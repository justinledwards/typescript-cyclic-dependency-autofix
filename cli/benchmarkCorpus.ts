import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';
import simpleGit from 'simple-git';
import {
  BENCHMARK_REPO_CORPUS,
  type BenchmarkCorpusEntry,
  type BenchmarkCorpusGroup,
} from '../benchmarks/repo-corpus.js';
import { getDb } from '../db/index.js';
import { type BenchmarkCaseContext, type BenchmarkMiningResult, mineBenchmarkCasesFromRepo } from './benchmarkMiner.js';

export interface BenchmarkCorpusMiningOptions {
  database?: DatabaseType;
  entries?: BenchmarkCorpusEntry[];
  onlyRepositories?: string[];
  searchRoots?: string[];
  workspaceDir?: string;
  cloneMissing?: boolean;
  limit?: number;
  maxCommits?: number;
  maxMatches?: number;
  dependencies?: BenchmarkCorpusDependencies;
}

export interface BenchmarkCorpusDependencies {
  mineBenchmarkCasesFromRepo?: typeof mineBenchmarkCasesFromRepo;
  findLocalCheckout?: typeof findLocalCheckout;
  cloneRepository?: typeof cloneRepository;
}

export interface BenchmarkCorpusRepositoryResult {
  slug: string;
  groups: BenchmarkCorpusGroup[];
  patterns: string[];
  repoPath: string | null;
  status: 'mined' | 'cloned' | 'skipped';
  reason?: string;
  mining?: BenchmarkMiningResult;
}

export interface BenchmarkCorpusMiningResult {
  corpusSize: number;
  repositoriesMined: number;
  repositoriesCloned: number;
  repositoriesSkipped: number;
  scannedCommits: number;
  matchedCommits: number;
  insertedCases: number;
  workspaceDir: string;
  searchRoots: string[];
  repositoryResults: BenchmarkCorpusRepositoryResult[];
  groupSummary: Array<{
    group: BenchmarkCorpusGroup;
    repositories: number;
    minedRepositories: number;
    skippedRepositories: number;
    insertedCases: number;
  }>;
  patternSummary: Array<{
    pattern: string;
    repositories: number;
    minedRepositories: number;
    skippedRepositories: number;
    insertedCases: number;
  }>;
}

export async function mineBenchmarkCasesFromCorpus(
  options: BenchmarkCorpusMiningOptions = {},
): Promise<BenchmarkCorpusMiningResult> {
  const database = options.database ?? getDb();
  const mineRepo = options.dependencies?.mineBenchmarkCasesFromRepo ?? mineBenchmarkCasesFromRepo;
  const localCheckoutResolver = options.dependencies?.findLocalCheckout ?? findLocalCheckout;
  const cloneRepo = options.dependencies?.cloneRepository ?? cloneRepository;
  const entries = selectCorpusEntries(
    options.entries ?? BENCHMARK_REPO_CORPUS,
    options.onlyRepositories,
    options.limit,
  );
  const searchRoots = normalizeSearchRoots(options.searchRoots);
  const workspaceDir = options.workspaceDir ? path.resolve(options.workspaceDir) : defaultWorkspaceDir();
  const searchRootsWithWorkspace = dedupePaths([...searchRoots, workspaceDir]);

  const repositoryResults: BenchmarkCorpusRepositoryResult[] = [];
  let repositoriesMined = 0;
  let repositoriesCloned = 0;
  let repositoriesSkipped = 0;
  let scannedCommits = 0;
  let matchedCommits = 0;
  let insertedCases = 0;

  for (const entry of entries) {
    const caseContext = buildCaseContext(entry);
    const localPath = localCheckoutResolver(entry, searchRootsWithWorkspace);
    if (localPath) {
      try {
        const mining = await mineRepo(localPath, {
          database,
          repositoryLabel: entry.slug,
          maxCommits: options.maxCommits,
          maxMatches: options.maxMatches,
          caseContext,
        });

        repositoriesMined += 1;
        scannedCommits += mining.scannedCommits;
        matchedCommits += mining.matchedCommits;
        insertedCases += mining.insertedCases;
        repositoryResults.push({
          slug: entry.slug,
          groups: entry.groups,
          patterns: entry.patterns,
          repoPath: localPath,
          status: 'mined',
          mining,
        });
      } catch (error) {
        repositoriesSkipped += 1;
        repositoryResults.push({
          slug: entry.slug,
          groups: entry.groups,
          patterns: entry.patterns,
          repoPath: localPath,
          status: 'skipped',
          reason: stringifyError(error),
        });
      }
      continue;
    }

    if (!options.cloneMissing) {
      repositoriesSkipped += 1;
      repositoryResults.push({
        slug: entry.slug,
        groups: entry.groups,
        patterns: entry.patterns,
        repoPath: null,
        status: 'skipped',
        reason: 'No local checkout matched the configured search roots',
      });
      continue;
    }

    try {
      const clonedPath = await cloneRepo(entry, workspaceDir);
      const mining = await mineRepo(clonedPath, {
        database,
        repositoryLabel: entry.slug,
        maxCommits: options.maxCommits,
        maxMatches: options.maxMatches,
        caseContext,
      });

      repositoriesMined += 1;
      repositoriesCloned += 1;
      scannedCommits += mining.scannedCommits;
      matchedCommits += mining.matchedCommits;
      insertedCases += mining.insertedCases;
      repositoryResults.push({
        slug: entry.slug,
        groups: entry.groups,
        patterns: entry.patterns,
        repoPath: clonedPath,
        status: 'cloned',
        mining,
      });
    } catch (error) {
      repositoriesSkipped += 1;
      repositoryResults.push({
        slug: entry.slug,
        groups: entry.groups,
        patterns: entry.patterns,
        repoPath: null,
        status: 'skipped',
        reason: stringifyError(error),
      });
    }
  }

  return {
    corpusSize: entries.length,
    repositoriesMined,
    repositoriesCloned,
    repositoriesSkipped,
    scannedCommits,
    matchedCommits,
    insertedCases,
    workspaceDir,
    searchRoots: searchRootsWithWorkspace,
    repositoryResults,
    groupSummary: buildGroupSummary(entries, repositoryResults),
    patternSummary: buildPatternSummary(entries, repositoryResults),
  };
}

export function defaultWorkspaceDir(): string {
  return path.resolve(process.cwd(), 'worktrees', 'benchmark-corpus');
}

export function normalizeSearchRoots(searchRoots: string[] = []): string[] {
  return dedupePaths(
    searchRoots.length > 0
      ? searchRoots.map((root) => path.resolve(root))
      : [
          process.cwd(),
          path.resolve(process.cwd(), '..'),
          path.resolve(process.cwd(), '..', '..'),
          path.resolve(process.cwd(), '..', '..', '..'),
        ],
  );
}

export function selectCorpusEntries(
  entries: BenchmarkCorpusEntry[],
  onlyRepositories: string[] = [],
  limit?: number,
): BenchmarkCorpusEntry[] {
  const filters = onlyRepositories.map((repository) => repository.trim().toLowerCase()).filter(Boolean);
  const selected = entries.filter((entry) =>
    filters.length === 0 ? true : filters.some((filter) => matchesCorpusRepository(entry.slug, filter)),
  );

  return typeof limit === 'number' ? selected.slice(0, limit) : selected;
}

export function findLocalCheckout(entry: BenchmarkCorpusEntry, searchRoots: string[] = []): string | null {
  for (const candidate of buildCheckoutCandidates(entry, searchRoots)) {
    if (isGitRepository(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function buildCheckoutCandidates(entry: BenchmarkCorpusEntry, searchRoots: string[] = []): string[] {
  const uniqueCandidates = new Set<string>();
  const [owner = '', repo = ''] = entry.slug.split('/');
  const normalizedRoots = searchRoots.length > 0 ? searchRoots : normalizeSearchRoots();

  for (const root of normalizedRoots) {
    uniqueCandidates.add(path.resolve(root, entry.slug));
    if (repo) {
      uniqueCandidates.add(path.resolve(root, repo));
    }
    if (owner && repo) {
      uniqueCandidates.add(path.resolve(root, owner, repo));
    }
  }

  return [...uniqueCandidates];
}

async function cloneRepository(entry: BenchmarkCorpusEntry, workspaceDir: string): Promise<string> {
  const destination = path.join(workspaceDir, ...entry.slug.split('/'));
  await mkdir(path.dirname(destination), { recursive: true });

  if (isGitRepository(destination)) {
    return destination;
  }

  if (existsSync(destination)) {
    throw new Error(`Workspace path already exists but is not a git repository: ${destination}`);
  }

  const git = simpleGit();
  await git.clone(`https://github.com/${entry.slug}.git`, destination, ['--depth', '1']);
  return destination;
}

function buildCaseContext(entry: BenchmarkCorpusEntry): BenchmarkCaseContext {
  return {
    corpusRepository: entry.slug,
    corpusGroups: entry.groups,
    corpusPatterns: entry.patterns,
    corpusDescription: entry.description,
  };
}

function buildGroupSummary(
  entries: BenchmarkCorpusEntry[],
  repositoryResults: BenchmarkCorpusRepositoryResult[],
): BenchmarkCorpusMiningResult['groupSummary'] {
  const groups: BenchmarkCorpusGroup[] = ['calibration', 'stable-core', 'watchlist'];

  return groups.map((group) => {
    const repos = entries.filter((entry) => entry.groups.includes(group));
    const repoResults = repositoryResults.filter((result) => result.groups.includes(group));
    return {
      group,
      repositories: repos.length,
      minedRepositories: repoResults.filter((result) => result.status !== 'skipped').length,
      skippedRepositories: repoResults.filter((result) => result.status === 'skipped').length,
      insertedCases: repoResults.reduce((total, result) => total + (result.mining?.insertedCases ?? 0), 0),
    };
  });
}

function buildPatternSummary(
  entries: BenchmarkCorpusEntry[],
  repositoryResults: BenchmarkCorpusRepositoryResult[],
): BenchmarkCorpusMiningResult['patternSummary'] {
  const patterns = [...new Set(entries.flatMap((entry) => entry.patterns))];
  patterns.sort((left: string, right: string) => left.localeCompare(right));
  return patterns.map((pattern) => {
    const repos = entries.filter((entry) => entry.patterns.includes(pattern));
    const repoResults = repositoryResults.filter((result) => result.patterns.includes(pattern));
    return {
      pattern,
      repositories: repos.length,
      minedRepositories: repoResults.filter((result) => result.status !== 'skipped').length,
      skippedRepositories: repoResults.filter((result) => result.status === 'skipped').length,
      insertedCases: repoResults.reduce((total, result) => total + (result.mining?.insertedCases ?? 0), 0),
    };
  });
}

function matchesCorpusRepository(slug: string, filter: string): boolean {
  const normalizedSlug = slug.toLowerCase();
  const normalizedRepo = slug.split('/').pop()?.toLowerCase() ?? normalizedSlug;
  return normalizedSlug === filter || normalizedRepo === filter;
}

function isGitRepository(candidate: string): boolean {
  return existsSync(path.join(candidate, '.git'));
}

function dedupePaths(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean))];
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
