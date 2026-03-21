import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BenchmarkCorpusEntry } from '../benchmarks/repo-corpus.js';
import { createDatabase, initSchema } from '../db/index.js';
import { findLocalCheckout, mineBenchmarkCasesFromCorpus } from './benchmarkCorpus.js';
import type { BenchmarkMiningResult, mineBenchmarkCasesFromRepo } from './benchmarkMiner.js';

const fixtureRoot = path.join(process.cwd(), '.test-fixtures');
mkdirSync(fixtureRoot, { recursive: true });

describe('findLocalCheckout', () => {
  it('finds a local git checkout from the configured search roots', () => {
    const root = mkdtempSync(path.join(fixtureRoot, 'corpus-root-'));
    const repoPath = path.join(root, 'openclaw');
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(path.join(repoPath, '.git'), 'gitdir: benchmark-fixture');

    const entry: BenchmarkCorpusEntry = {
      slug: 'openclaw/openclaw',
      groups: ['calibration'],
      description: 'Calibration repo',
      patterns: ['extract_shared'],
    };

    expect(findLocalCheckout(entry, [root])).toBe(repoPath);
  });
});

describe('mineBenchmarkCasesFromCorpus', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('mines local checkouts and skips missing repositories without cloning', async () => {
    const db = createDatabase(':memory:');
    initSchema(db);

    const entries: BenchmarkCorpusEntry[] = [
      {
        slug: 'openclaw/openclaw',
        groups: ['calibration'],
        description: 'Calibration repo',
        patterns: ['extract_shared'],
      },
      {
        slug: 'microsoft/vscode',
        groups: ['stable-core'],
        description: 'Core corpus repo',
        patterns: ['direct_import'],
      },
    ];

    const profile = {
      repoPath: path.join(fixtureRoot, 'corpus', 'openclaw'),
      packageJsonPath: path.join(fixtureRoot, 'corpus', 'openclaw', 'package.json'),
      packageManager: 'pnpm' as const,
      workspaceMode: 'workspace' as const,
      lockfiles: ['pnpm-lock.yaml'],
      scriptNames: ['build', 'lint', 'test', 'typecheck'],
      validationCommands: ['pnpm typecheck', 'pnpm lint', 'pnpm test', 'pnpm build'],
    };

    const mineRepo = vi.fn(async (repoPath: string, options: { repositoryLabel?: string; caseContext?: unknown }) => {
      expect(options.repositoryLabel).toBeDefined();
      expect(options.caseContext).toMatchObject({
        corpusRepository: options.repositoryLabel,
        repositoryProfile: {
          packageManager: 'pnpm',
          workspaceMode: 'workspace',
          lockfiles: ['pnpm-lock.yaml'],
          scriptNames: ['build', 'lint', 'test', 'typecheck'],
          validationCommands: ['pnpm typecheck', 'pnpm lint', 'pnpm test', 'pnpm build'],
        },
      });

      const mining: BenchmarkMiningResult = {
        repository: options.repositoryLabel ?? 'unknown',
        repoPath,
        scannedCommits: 4,
        matchedCommits: 2,
        insertedCases: repoPath.includes('openclaw') ? 1 : 0,
        matchedTerms: ['circular dependency'],
      };

      return mining;
    });

    const result = await mineBenchmarkCasesFromCorpus({
      database: db,
      entries,
      searchRoots: [path.join(fixtureRoot, 'corpus')],
      cloneMissing: false,
      dependencies: {
        mineBenchmarkCasesFromRepo: mineRepo as unknown as typeof mineBenchmarkCasesFromRepo,
        findLocalCheckout: (entry) =>
          entry.slug === 'openclaw/openclaw' ? path.join(fixtureRoot, 'corpus', 'openclaw') : null,
        cloneRepository: vi.fn(),
        profileRepository: vi.fn(async (repoPath: string) => {
          expect(repoPath).toBe(path.join(fixtureRoot, 'corpus', 'openclaw'));
          return profile;
        }),
      },
    });

    expect(result).toMatchObject({
      corpusSize: 2,
      repositoriesMined: 1,
      repositoriesSkipped: 1,
      repositoriesCloned: 0,
      insertedCases: 1,
      scannedCommits: 4,
      matchedCommits: 2,
    });
    expect(result.repositoryResults).toEqual([
      {
        slug: 'openclaw/openclaw',
        groups: ['calibration'],
        patterns: ['extract_shared'],
        repoPath: path.join(fixtureRoot, 'corpus', 'openclaw'),
        profile,
        status: 'mined',
        mining: expect.objectContaining({
          repository: 'openclaw/openclaw',
          insertedCases: 1,
        }),
      },
      {
        slug: 'microsoft/vscode',
        groups: ['stable-core'],
        patterns: ['direct_import'],
        repoPath: null,
        status: 'skipped',
        reason: 'No local checkout matched the configured search roots',
      },
    ]);
    expect(result.groupSummary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          group: 'calibration',
          repositories: 1,
          minedRepositories: 1,
          skippedRepositories: 0,
          insertedCases: 1,
        }),
        expect.objectContaining({
          group: 'stable-core',
          repositories: 1,
          minedRepositories: 0,
          skippedRepositories: 1,
          insertedCases: 0,
        }),
      ]),
    );
    expect(result.patternSummary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pattern: 'extract_shared',
          repositories: 1,
          minedRepositories: 1,
          skippedRepositories: 0,
          insertedCases: 1,
        }),
        expect.objectContaining({
          pattern: 'direct_import',
          repositories: 1,
          minedRepositories: 0,
          skippedRepositories: 1,
          insertedCases: 0,
        }),
      ]),
    );

    db.close();
  });

  it('clones missing repositories when cloneMissing is enabled', async () => {
    const db = createDatabase(':memory:');
    initSchema(db);

    const entries: BenchmarkCorpusEntry[] = [
      {
        slug: 'anomalyco/opencode',
        groups: ['watchlist'],
        description: 'Watchlist repo',
        patterns: ['stateful_singleton_split'],
      },
    ];

    const profile = {
      repoPath: path.join(fixtureRoot, 'worktrees', 'anomalyco', 'opencode'),
      packageJsonPath: path.join(fixtureRoot, 'worktrees', 'anomalyco', 'opencode', 'package.json'),
      packageManager: 'bun' as const,
      workspaceMode: 'single-package' as const,
      lockfiles: ['bun.lock'],
      scriptNames: ['build', 'test'],
      validationCommands: ['bun run test', 'bun run build'],
    };

    const cloneRepository = vi.fn(async (_entry: BenchmarkCorpusEntry, workspaceDir: string) => {
      expect(workspaceDir).toBe(path.join(fixtureRoot, 'worktrees'));
      return path.join(workspaceDir, 'anomalyco', 'opencode');
    });

    const mineRepo = vi.fn(async (repoPath: string, options: { repositoryLabel?: string; caseContext?: unknown }) => ({
      repository: options.repositoryLabel ?? 'unknown',
      repoPath,
      scannedCommits: 3,
      matchedCommits: 1,
      insertedCases: 2,
      matchedTerms: ['extract shared'],
    }));

    const result = await mineBenchmarkCasesFromCorpus({
      database: db,
      entries,
      workspaceDir: path.join(fixtureRoot, 'worktrees'),
      cloneMissing: true,
      dependencies: {
        mineBenchmarkCasesFromRepo: mineRepo as unknown as typeof mineBenchmarkCasesFromRepo,
        findLocalCheckout: () => null,
        cloneRepository,
        profileRepository: vi.fn(async (repoPath: string) => {
          expect(repoPath).toBe(path.join(fixtureRoot, 'worktrees', 'anomalyco', 'opencode'));
          return profile;
        }),
      },
    });

    expect(cloneRepository).toHaveBeenCalledWith(entries[0], path.join(fixtureRoot, 'worktrees'));
    expect(mineRepo).toHaveBeenCalledWith(
      path.join(fixtureRoot, 'worktrees', 'anomalyco', 'opencode'),
      expect.objectContaining({
        repositoryLabel: 'anomalyco/opencode',
        caseContext: expect.objectContaining({
          corpusRepository: 'anomalyco/opencode',
          corpusGroups: ['watchlist'],
          corpusPatterns: ['stateful_singleton_split'],
        }),
      }),
    );
    expect(result.repositoriesCloned).toBe(1);
    expect(result.repositoriesMined).toBe(1);
    expect(result.repositoryResults[0]).toMatchObject({
      slug: 'anomalyco/opencode',
      repoPath: path.join(fixtureRoot, 'worktrees', 'anomalyco', 'opencode'),
      profile,
      status: 'cloned',
    });

    db.close();
  });

  it('continues mining when repository profiling fails', async () => {
    const db = createDatabase(':memory:');
    initSchema(db);

    const entries: BenchmarkCorpusEntry[] = [
      {
        slug: 'openclaw/openclaw',
        groups: ['calibration'],
        description: 'Calibration repo',
        patterns: ['extract_shared'],
      },
    ];

    const mineRepo = vi.fn(async (repoPath: string, options: { repositoryLabel?: string; caseContext?: unknown }) => ({
      repository: options.repositoryLabel ?? 'unknown',
      repoPath,
      scannedCommits: 3,
      matchedCommits: 1,
      insertedCases: 1,
      matchedTerms: ['circular dependency'],
    }));

    const result = await mineBenchmarkCasesFromCorpus({
      database: db,
      entries,
      searchRoots: [path.join(fixtureRoot, 'corpus')],
      cloneMissing: false,
      dependencies: {
        mineBenchmarkCasesFromRepo: mineRepo as unknown as typeof mineBenchmarkCasesFromRepo,
        findLocalCheckout: (entry) =>
          entry.slug === 'openclaw/openclaw' ? path.join(fixtureRoot, 'corpus', 'openclaw') : null,
        cloneRepository: vi.fn(),
        profileRepository: vi.fn(async () => {
          throw new Error('broken package.json');
        }),
      },
    });

    expect(mineRepo).toHaveBeenCalledTimes(1);
    expect(result.repositoryResults[0]).toMatchObject({
      slug: 'openclaw/openclaw',
      repoPath: path.join(fixtureRoot, 'corpus', 'openclaw'),
      profile: undefined,
      status: 'mined',
    });

    db.close();
  });
});
