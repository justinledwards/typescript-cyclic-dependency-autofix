import path from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';
import simpleGit from 'simple-git';
import { createStatements, getDb } from '../db/index.js';

const DEFAULT_SEARCH_TERMS = [
  'circular dependency',
  'cyclic dependency',
  'import type',
  'type-only',
  'barrel',
  're-export',
  'reexport',
  'index.ts',
  'index.js',
  'extract shared',
  'move helper',
  'break cycle',
  'internal.ts',
  'internal.js',
];

const LOG_RECORD_SEPARATOR = '\u001E';
const LOG_FIELD_SEPARATOR = '\u001F';

export interface BenchmarkMiningOptions {
  database?: DatabaseType;
  git?: GitAdapter;
  repositoryLabel?: string;
  searchTerms?: string[];
  maxCommits?: number;
  maxMatches?: number;
  caseContext?: BenchmarkCaseContext;
}

export interface BenchmarkMiningResult {
  repository: string;
  repoPath: string;
  scannedCommits: number;
  matchedCommits: number;
  insertedCases: number;
  matchedTerms: string[];
}

export interface BenchmarkCaseContext {
  corpusRepository?: string;
  corpusGroups?: string[];
  corpusPatterns?: string[];
  corpusDescription?: string;
}

export interface GitAdapter {
  raw(args: string[]): Promise<string>;
}

interface ParsedCommitRecord {
  commitSha: string;
  title: string;
  body: string;
}

interface DiffFeatures {
  files_changed: number;
  additions: number;
  deletions: number;
  new_files: number;
  renamed_files: number;
  modified_files: number;
  binary_files: number;
}

export async function mineBenchmarkCasesFromRepo(
  repoPath: string,
  options: BenchmarkMiningOptions = {},
): Promise<BenchmarkMiningResult> {
  const database = options.database ?? getDb();
  const statements = createStatements(database);
  const git = options.git ?? simpleGit(repoPath);
  const repository = options.repositoryLabel ?? (await resolveRepositoryLabel(git, repoPath));
  const searchTerms = normalizeSearchTerms(options.searchTerms ?? DEFAULT_SEARCH_TERMS);
  const maxCommits = options.maxCommits ?? 1000;
  const maxMatches = options.maxMatches ?? 25;

  const logOutput = await git.raw([
    'log',
    '--all',
    '--no-merges',
    `--max-count=${maxCommits}`,
    '--pretty=format:%H%x1f%s%x1f%b%x1e',
  ]);
  const commits = parseCommitRecords(logOutput);

  let matchedCommits = 0;
  let insertedCases = 0;
  const matchedTerms = new Set<string>();

  for (const commit of commits) {
    const commitText = `${commit.title}\n${commit.body}`.trim();
    const commitMatchedTerms = findMatchedTerms(commitText, searchTerms);
    if (commitMatchedTerms.length === 0) {
      continue;
    }

    matchedCommits += 1;
    for (const term of commitMatchedTerms) {
      matchedTerms.add(term);
    }

    const diffFeatures = await collectDiffFeatures(git, commit.commitSha);
    const strategyLabels = classifyStrategyLabels(commitText);
    const url = buildCommitUrl(repository, commit.commitSha);

    statements.addBenchmarkCase.run({
      repository,
      source: 'git-log',
      commit_sha: commit.commitSha,
      title: commit.title,
      body: commit.body || null,
      url,
      pr_number: null,
      issue_number: null,
      strategy_labels: JSON.stringify(strategyLabels),
      validation_signals: JSON.stringify({
        matched_terms: commitMatchedTerms,
        search_terms: searchTerms.length,
        commit_text_length: commitText.length,
        ...buildBenchmarkContextSignals(options.caseContext),
      }),
      diff_features: JSON.stringify(diffFeatures),
      matched_terms: JSON.stringify(commitMatchedTerms),
      notes: buildBenchmarkNote(commitMatchedTerms, diffFeatures, strategyLabels, options.caseContext),
    });

    insertedCases += 1;
    if (insertedCases >= maxMatches) {
      break;
    }
  }

  return {
    repository,
    repoPath: path.resolve(repoPath),
    scannedCommits: commits.length,
    matchedCommits,
    insertedCases,
    matchedTerms: [...matchedTerms],
  };
}

function normalizeSearchTerms(terms: string[]): string[] {
  return [...new Set(terms.map((term) => term.trim().toLowerCase()).filter(Boolean))];
}

function parseCommitRecords(logOutput: string): ParsedCommitRecord[] {
  return logOutput
    .split(LOG_RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [commitSha, title = '', body = ''] = record.split(LOG_FIELD_SEPARATOR);
      return {
        commitSha,
        title,
        body,
      };
    })
    .filter((record) => record.commitSha.length > 0);
}

function findMatchedTerms(text: string, searchTerms: string[]): string[] {
  const lowerText = text.toLowerCase();
  return searchTerms.filter((term) => lowerText.includes(term));
}

async function collectDiffFeatures(git: GitAdapter, commitSha: string): Promise<DiffFeatures> {
  const [nameStatusOutput, numstatOutput] = await Promise.all([
    git.raw(['show', '--name-status', '--find-renames', '--format=', commitSha]),
    git.raw(['show', '--numstat', '--find-renames', '--format=', commitSha]),
  ]);

  const nameStatusLines = nameStatusOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const numstatLines = numstatOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  let filesChanged = 0;
  let additions = 0;
  let deletions = 0;
  let newFiles = 0;
  let renamedFiles = 0;
  let modifiedFiles = 0;
  let binaryFiles = 0;

  for (const line of nameStatusLines) {
    const [status] = line.split('\t');
    if (!status) {
      continue;
    }

    filesChanged += 1;
    if (status.startsWith('A')) {
      newFiles += 1;
    } else if (status.startsWith('R')) {
      renamedFiles += 1;
    } else if (status.startsWith('M')) {
      modifiedFiles += 1;
    }
  }

  for (const line of numstatLines) {
    const [adds, deletes] = line.split('\t');
    if (adds === '-' || deletes === '-') {
      binaryFiles += 1;
      continue;
    }

    additions += Number(adds ?? 0);
    deletions += Number(deletes ?? 0);
  }

  return {
    files_changed: filesChanged,
    additions,
    deletions,
    new_files: newFiles,
    renamed_files: renamedFiles,
    modified_files: modifiedFiles,
    binary_files: binaryFiles,
  };
}

function classifyStrategyLabels(commitText: string): string[] {
  const lowerText = commitText.toLowerCase();
  const labels = new Set<string>();

  if (/import\s+type|type-only|type only/.test(lowerText)) {
    labels.add('import_type');
    labels.add('type_runtime_split');
  }

  if (/barrel|re-?export|index\.(ts|tsx|js|jsx)/.test(lowerText)) {
    labels.add('barrel_reexport_cleanup');
    labels.add('direct_import');
  }

  if (/extract shared|shared module|shared file|move helper|split helper|leaf-like/.test(lowerText)) {
    labels.add('extract_shared');
    labels.add('leaf_cluster_extraction');
  }

  if (/setter|state update|host-owned|stateful singleton|dependency inversion/.test(lowerText)) {
    labels.add('host_owned_state_update');
    labels.add('stateful_singleton_split');
  }

  if (/internal\.(ts|js)|module loading order|internal entrypoint/.test(lowerText)) {
    labels.add('internal_entrypoint_pattern');
  }

  if (labels.size === 0) {
    labels.add('unclassified');
  }

  return [...labels];
}

function buildBenchmarkNote(
  matchedTerms: string[],
  diffFeatures: DiffFeatures,
  labels: string[],
  context?: BenchmarkCaseContext,
): string {
  const contextParts: string[] = [];
  if (context?.corpusRepository) {
    contextParts.push(`corpus repo: ${context.corpusRepository}`);
  }
  if (context?.corpusGroups?.length) {
    contextParts.push(`corpus groups: ${context.corpusGroups.join(', ')}`);
  }
  if (context?.corpusPatterns?.length) {
    contextParts.push(`corpus patterns: ${context.corpusPatterns.join(', ')}`);
  }
  if (context?.corpusDescription) {
    contextParts.push(`corpus description: ${context.corpusDescription}`);
  }

  return [
    `matched terms: ${matchedTerms.join(', ')}`,
    `labels: ${labels.join(', ')}`,
    `files changed: ${diffFeatures.files_changed}`,
    ...contextParts,
  ].join('; ');
}

function buildBenchmarkContextSignals(context?: BenchmarkCaseContext): Record<string, string | string[] | undefined> {
  if (!context) {
    return {};
  }

  return {
    corpus_repository: context.corpusRepository,
    corpus_groups: context.corpusGroups,
    corpus_patterns: context.corpusPatterns,
    corpus_description: context.corpusDescription,
  };
}

async function resolveRepositoryLabel(git: GitAdapter, repoPath: string): Promise<string> {
  try {
    const remoteUrlOutput = await git.raw(['remote', 'get-url', 'origin']);
    const remoteUrl = remoteUrlOutput.trim();
    const githubSlug = parseGitHubSlug(remoteUrl);
    if (githubSlug) {
      return githubSlug;
    }
  } catch {
    // Fall back to the local directory name below.
  }

  return path.basename(path.resolve(repoPath));
}

function parseGitHubSlug(remoteUrl: string): string | undefined {
  const sshMatch = remoteUrl.match(/^git@github\.com:(.+?)\.git$/);
  if (sshMatch?.[1]) {
    return sshMatch[1];
  }

  const httpsMatch = remoteUrl.match(/^https?:\/\/github\.com\/(.+?)(?:\.git)?$/);
  if (httpsMatch?.[1]) {
    return httpsMatch[1];
  }

  return undefined;
}

function buildCommitUrl(repository: string, commitSha: string): string | null {
  if (!repository.includes('/')) {
    return null;
  }

  return `https://github.com/${repository}/commit/${commitSha}`;
}
