import path from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';
import simpleGit from 'simple-git';
import { createStatements, getDb } from '../db/index.js';
import {
  classifyStrategyLabels,
  findMatchedTerms,
  getDefaultBenchmarkSearchTerms,
  normalizeSearchTerms,
} from './benchmarkSignals.js';
import type { RepositoryProfile } from './repoProfile.js';

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
  repositoryProfile?: BenchmarkRepositoryProfileContext;
}

export interface BenchmarkRepositoryProfileContext {
  packageManager: RepositoryProfile['packageManager'];
  workspaceMode: RepositoryProfile['workspaceMode'];
  lockfiles: string[];
  scriptNames: string[];
  validationCommands: string[];
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
  js_ts_files_changed: number;
  non_js_ts_files_changed: number;
  touches_public_api_seam: boolean;
  touches_plugin_sdk_surface: boolean;
  touches_internal_surface: boolean;
  touches_setup_surface: boolean;
  touches_setup_core: boolean;
  touches_api_shim: boolean;
  touches_shared_module: boolean;
}

interface ChangedFileSummary {
  allPaths: string[];
  jsTsPaths: string[];
  nonJsTsPaths: string[];
}

interface DiffSummary {
  diffFeatures: DiffFeatures;
  changedFiles: ChangedFileSummary;
}

const TRAINING_CODE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mts', '.cts']);

export async function mineBenchmarkCasesFromRepo(
  repoPath: string,
  options: BenchmarkMiningOptions = {},
): Promise<BenchmarkMiningResult> {
  const database = options.database ?? getDb();
  const statements = createStatements(database);
  const git = options.git ?? simpleGit(repoPath);
  const repository = options.repositoryLabel ?? (await resolveRepositoryLabel(git, repoPath));
  const searchTerms = normalizeSearchTerms(options.searchTerms ?? getDefaultBenchmarkSearchTerms());
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

    const diffSummary = await collectDiffSummary(git, commit.commitSha);
    if (diffSummary.changedFiles.jsTsPaths.length === 0) {
      continue;
    }

    const strategyLabels = classifyStrategyLabels(commitText, diffSummary.changedFiles.allPaths);
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
        language_scope: buildLanguageScopeSignals(diffSummary.changedFiles),
        ...buildBenchmarkContextSignals(options.caseContext),
      }),
      diff_features: JSON.stringify(diffSummary.diffFeatures),
      matched_terms: JSON.stringify(commitMatchedTerms),
      notes: buildBenchmarkNote(commitMatchedTerms, diffSummary, strategyLabels, options.caseContext),
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

async function collectDiffSummary(git: GitAdapter, commitSha: string): Promise<DiffSummary> {
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
  const changedPaths = new Set<string>();

  for (const line of nameStatusLines) {
    const [status, ...rawPaths] = line.split('\t');
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

    for (const filePath of rawPaths.map((value) => value.trim()).filter(Boolean)) {
      changedPaths.add(filePath);
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

  const changedFiles = summarizeChangedFiles([...changedPaths]);

  return {
    diffFeatures: {
      files_changed: filesChanged,
      additions,
      deletions,
      new_files: newFiles,
      renamed_files: renamedFiles,
      modified_files: modifiedFiles,
      binary_files: binaryFiles,
      js_ts_files_changed: changedFiles.jsTsPaths.length,
      non_js_ts_files_changed: changedFiles.nonJsTsPaths.length,
      ...buildPatchShapeDiffFeatures(changedFiles),
    },
    changedFiles,
  };
}

function buildBenchmarkNote(
  matchedTerms: string[],
  diffSummary: DiffSummary,
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
  if (context?.repositoryProfile) {
    const profile = context.repositoryProfile;
    contextParts.push(
      `repository profile: ${profile.packageManager}/${profile.workspaceMode}`,
      `validation commands: ${profile.validationCommands.join(' | ') || 'none'}`,
    );
  }

  return [
    `matched terms: ${matchedTerms.join(', ')}`,
    `labels: ${labels.join(', ')}`,
    `files changed: ${diffSummary.diffFeatures.files_changed}`,
    `training language scope: js/ts (${diffSummary.changedFiles.jsTsPaths.length} code files)`,
    ...contextParts,
  ].join('; ');
}

function buildLanguageScopeSignals(changedFiles: ChangedFileSummary): Record<string, unknown> {
  return {
    training_language: 'js_ts',
    eligible: true,
    js_ts_changed_files: changedFiles.jsTsPaths,
    non_js_ts_changed_files: changedFiles.nonJsTsPaths,
    total_changed_paths: changedFiles.allPaths.length,
  };
}

function buildBenchmarkContextSignals(context?: BenchmarkCaseContext): Record<string, unknown> {
  if (!context) {
    return {};
  }

  return {
    corpus_repository: context.corpusRepository,
    corpus_groups: context.corpusGroups,
    corpus_patterns: context.corpusPatterns,
    corpus_description: context.corpusDescription,
    repository_profile: context.repositoryProfile
      ? {
          package_manager: context.repositoryProfile.packageManager,
          workspace_mode: context.repositoryProfile.workspaceMode,
          lockfiles: context.repositoryProfile.lockfiles,
          script_names: context.repositoryProfile.scriptNames,
          validation_commands: context.repositoryProfile.validationCommands,
        }
      : undefined,
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

function summarizeChangedFiles(paths: string[]): ChangedFileSummary {
  const uniquePaths = [...new Set(paths.map((filePath) => filePath.trim()).filter(Boolean))];
  const jsTsPaths: string[] = [];
  const nonJsTsPaths: string[] = [];

  for (const filePath of uniquePaths) {
    if (isJavaScriptOrTypeScriptPath(filePath)) {
      jsTsPaths.push(filePath);
      continue;
    }

    nonJsTsPaths.push(filePath);
  }

  return {
    allPaths: uniquePaths,
    jsTsPaths,
    nonJsTsPaths,
  };
}

function buildPatchShapeDiffFeatures(
  changedFiles: ChangedFileSummary,
): Omit<
  DiffFeatures,
  | 'files_changed'
  | 'additions'
  | 'deletions'
  | 'new_files'
  | 'renamed_files'
  | 'modified_files'
  | 'binary_files'
  | 'js_ts_files_changed'
  | 'non_js_ts_files_changed'
> {
  const normalizedPaths = changedFiles.allPaths.map((filePath) => filePath.toLowerCase());

  return {
    touches_public_api_seam: normalizedPaths.some(
      (filePath) =>
        filePath.endsWith('/api.ts') ||
        filePath.endsWith('/api.js') ||
        filePath.includes('/plugin-sdk/') ||
        filePath.includes('/setup-surface.') ||
        filePath.includes('/setup-core.'),
    ),
    touches_plugin_sdk_surface: normalizedPaths.some((filePath) => filePath.includes('/plugin-sdk/')),
    touches_internal_surface: normalizedPaths.some(
      (filePath) =>
        filePath.includes('/plugin-sdk-internal/') ||
        filePath.endsWith('/internal.ts') ||
        filePath.endsWith('/internal.js'),
    ),
    touches_setup_surface: normalizedPaths.some((filePath) => filePath.includes('/setup-surface.')),
    touches_setup_core: normalizedPaths.some((filePath) => filePath.includes('/setup-core.')),
    touches_api_shim: normalizedPaths.some((filePath) => filePath.endsWith('/api.ts') || filePath.endsWith('/api.js')),
    touches_shared_module: normalizedPaths.some((filePath) => filePath.includes('.shared.')),
  };
}

function isJavaScriptOrTypeScriptPath(filePath: string): boolean {
  const normalizedPath = filePath.trim().toLowerCase();
  if (!normalizedPath) {
    return false;
  }

  return TRAINING_CODE_EXTENSIONS.has(path.extname(normalizedPath));
}
