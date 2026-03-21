import path from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BenchmarkCorpusEntry } from '../benchmarks/repo-corpus.js';
import { type AcceptanceBenchmarkCaseDTO, createDatabase, createStatements, initSchema } from '../db/index.js';
import {
  annotateAcceptanceBenchmarkCase,
  getAcceptanceBenchmarkReport,
  runAcceptanceBenchmark,
} from './acceptanceBenchmark.js';

// eslint-disable-next-line sonarjs/publicly-writable-directories
const TEST_LOCAL_REPO_PATH = '/tmp/openclaw';

interface SeededCycleOptions {
  normalizedPath: string;
  classification: string;
  confidence: number;
  upstreamabilityScore?: number | null;
  reviewStatus?: 'approved' | 'pending' | 'pr_candidate' | 'rejected';
  validationStatus?: string | null;
  validationSummary?: string | null;
  touchedFiles?: string[];
  featureVector?: Record<string, unknown>;
  plannerAttempts?: Array<Record<string, unknown>>;
  plannerSummary?: string;
}

function createTestDb(): DatabaseType {
  const db = createDatabase(':memory:');
  initSchema(db);
  return db;
}

function seedAcceptanceScan(
  db: DatabaseType,
  repositorySlug: string,
  repoPath: string,
  commitSha: string,
  cycles: SeededCycleOptions[],
) {
  const statements = createStatements(db);
  const [owner, name] = repositorySlug.split('/');
  const repoInfo = statements.addRepository.run({
    owner,
    name,
    default_branch: 'main',
    local_path: repoPath,
  });
  const scanInfo = statements.addScan.run({
    repository_id: repoInfo.lastInsertRowid,
    commit_sha: commitSha,
    status: 'completed',
  });

  for (const [index, cycle] of cycles.entries()) {
    const rawPayload = JSON.stringify({
      type: 'circular',
      path: cycle.normalizedPath.split(' -> '),
      analysis: {
        classification: cycle.classification,
        confidence: cycle.confidence,
        upstreamabilityScore: cycle.upstreamabilityScore ?? null,
        planner: {
          features: cycle.featureVector ?? {
            cycleSize: 2,
            cycleShape: 'two_file',
            packageManager: 'pnpm',
            workspaceMode: 'workspace',
            validationCommandCount: 3,
          },
          attempts: cycle.plannerAttempts ?? [
            {
              strategy: cycle.classification.replace('autofix_', ''),
              status: 'candidate',
              classification: cycle.classification,
              score: cycle.upstreamabilityScore ?? 0.8,
            },
          ],
          selectionSummary: cycle.plannerSummary ?? `Selected ${cycle.classification} for cycle ${index + 1}.`,
        },
      },
    });

    const cycleInfo = statements.addCycle.run({
      scan_id: scanInfo.lastInsertRowid,
      normalized_path: cycle.normalizedPath,
      participating_files: JSON.stringify(cycle.normalizedPath.split(' -> ')),
      raw_payload: rawPayload,
    });

    const fixCandidateInfo = statements.addFixCandidate.run({
      cycle_id: cycleInfo.lastInsertRowid,
      classification: cycle.classification,
      confidence: cycle.confidence,
      reasons: JSON.stringify(['Autofix candidate identified during benchmark seeding.']),
    });

    const patchInfo = statements.addPatch.run({
      fix_candidate_id: fixCandidateInfo.lastInsertRowid,
      patch_text: `diff --git a/file-${index}.ts b/file-${index}.ts`,
      touched_files: JSON.stringify(cycle.touchedFiles ?? ['a.ts', 'b.ts']),
      validation_status: cycle.validationStatus ?? 'passed',
      validation_summary: cycle.validationSummary ?? 'Cycle removed',
    });

    if (cycle.reviewStatus && cycle.reviewStatus !== 'pending') {
      statements.addReviewDecision.run({
        patch_id: patchInfo.lastInsertRowid,
        decision: cycle.reviewStatus,
        notes: `${cycle.reviewStatus} during benchmark review`,
      });
    }
  }

  return {
    scanId: Number(scanInfo.lastInsertRowid),
    cyclesFound: cycles.length,
  };
}

describe('acceptance benchmark workflow', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('benchmarks local corpus checkouts and snapshots planner data into acceptance cases', async () => {
    const db = createTestDb();
    const repoPath = path.join(process.cwd(), '.test-fixtures', 'openclaw');
    const entry: BenchmarkCorpusEntry = {
      slug: 'openclaw/openclaw',
      groups: ['calibration'],
      description: 'Calibration repo',
      patterns: ['host_owned_state_update'],
    };

    const scanRepo = vi.fn(async (targetRepoPath: string, worktreesDir?: string) => {
      expect(targetRepoPath).toBe(repoPath);
      expect(worktreesDir).toBe(path.join(process.cwd(), '.test-fixtures', 'scan-worktrees'));

      return {
        ...seedAcceptanceScan(db, entry.slug, repoPath, 'abc123', [
          {
            normalizedPath: 'a.ts -> b.ts -> a.ts',
            classification: 'autofix_import_type',
            confidence: 0.93,
            upstreamabilityScore: 0.91,
            reviewStatus: 'approved',
            featureVector: {
              cycleSize: 2,
              hasBarrelFile: false,
              packageManager: 'pnpm',
              workspaceMode: 'workspace',
              validationCommandCount: 4,
            },
          },
          {
            normalizedPath: 'c.ts -> d.ts -> c.ts',
            classification: 'autofix_extract_shared',
            confidence: 0.78,
            upstreamabilityScore: 0.74,
            reviewStatus: 'pending',
            touchedFiles: ['c.ts', 'd.ts', 'shared.ts'],
            featureVector: {
              cycleSize: 2,
              hasSharedModuleFile: false,
              introducesNewFile: true,
              packageManager: 'pnpm',
              workspaceMode: 'workspace',
              validationCommandCount: 4,
            },
          },
        ]),
        repoPath,
      };
    });

    const result = await runAcceptanceBenchmark({
      database: db,
      entries: [entry],
      searchRoots: [path.join(process.cwd(), '.test-fixtures')],
      scanWorktreesDir: path.join(process.cwd(), '.test-fixtures', 'scan-worktrees'),
      dependencies: {
        findLocalCheckout: () => repoPath,
        scanRepository: scanRepo,
      },
    });

    expect(result).toMatchObject({
      corpusSize: 1,
      repositoriesBenchmarked: 1,
      repositoriesCloned: 0,
      repositoriesSkipped: 0,
      totalCycles: 2,
      totalAcceptanceCases: 2,
      repositoryResults: [
        {
          slug: 'openclaw/openclaw',
          repoPath,
          status: 'benchmarked',
          cyclesFound: 2,
          benchmarkedCases: 2,
        },
      ],
    });
    expect(result.acceptanceSummary).toEqual([
      {
        classification: 'autofix_extract_shared',
        totalCases: 1,
        acceptedCases: 0,
        rejectedCases: 0,
        needsReviewCases: 1,
        acceptanceRate: 0,
      },
      {
        classification: 'autofix_import_type',
        totalCases: 1,
        acceptedCases: 1,
        rejectedCases: 0,
        needsReviewCases: 0,
        acceptanceRate: 1,
      },
    ]);

    const report = getAcceptanceBenchmarkReport(db);
    expect(report.totalCases).toBe(2);

    const importTypeCase = report.cases.find((candidate) => candidate.classification === 'autofix_import_type');
    expect(importTypeCase).toMatchObject({
      repository: 'openclaw/openclaw',
      commit_sha: 'abc123',
      acceptability: 'accepted',
      review_status: 'approved',
    });
    expect(JSON.parse(importTypeCase?.feature_vector ?? '{}')).toMatchObject({
      cycleSize: 2,
      packageManager: 'pnpm',
    });
    expect(JSON.parse(importTypeCase?.planner_attempts ?? '[]')).toEqual([
      expect.objectContaining({
        classification: 'autofix_import_type',
      }),
    ]);

    db.close();
  });

  it('skips repositories without a local checkout when cloning is disabled', async () => {
    const db = createTestDb();
    const entry: BenchmarkCorpusEntry = {
      slug: 'microsoft/vscode',
      groups: ['stable-core'],
      description: 'Core corpus repo',
      patterns: ['direct_import'],
    };

    const result = await runAcceptanceBenchmark({
      database: db,
      entries: [entry],
      cloneMissing: false,
      dependencies: {
        findLocalCheckout: () => null,
        scanRepository: vi.fn(),
      },
    });

    expect(result).toMatchObject({
      repositoriesBenchmarked: 0,
      repositoriesCloned: 0,
      repositoriesSkipped: 1,
      totalAcceptanceCases: 0,
      repositoryResults: [
        {
          slug: 'microsoft/vscode',
          repoPath: null,
          status: 'skipped',
          reason: 'No local checkout matched the configured search roots',
        },
      ],
    });

    db.close();
  });

  it('clones missing repositories when requested and captures rejected benchmark cases', async () => {
    const db = createTestDb();
    const entry: BenchmarkCorpusEntry = {
      slug: 'anomalyco/opencode',
      groups: ['watchlist'],
      description: 'Watchlist repo',
      patterns: ['extract_shared'],
    };
    const clonedRepoPath = path.join(process.cwd(), '.test-fixtures', 'anomalyco', 'opencode');
    const cloneRepository = vi.fn(async () => clonedRepoPath);

    const result = await runAcceptanceBenchmark({
      database: db,
      entries: [entry],
      cloneMissing: true,
      workspaceDir: path.join(process.cwd(), '.test-fixtures', 'worktrees'),
      dependencies: {
        findLocalCheckout: () => null,
        cloneRepository,
        scanRepository: vi.fn(async () => ({
          ...seedAcceptanceScan(db, entry.slug, clonedRepoPath, 'def456', [
            {
              normalizedPath: 'x.ts -> y.ts -> x.ts',
              classification: 'autofix_host_state_update',
              confidence: 0.81,
              upstreamabilityScore: 0.79,
              reviewStatus: 'rejected',
              validationStatus: 'failed',
              validationSummary: 'Repo-native validation failed',
            },
          ]),
          repoPath: clonedRepoPath,
        })),
      },
    });

    expect(cloneRepository).toHaveBeenCalledWith(entry, path.join(process.cwd(), '.test-fixtures', 'worktrees'));
    expect(result).toMatchObject({
      repositoriesBenchmarked: 1,
      repositoriesCloned: 1,
      repositoriesSkipped: 0,
      totalAcceptanceCases: 1,
      repositoryResults: [
        {
          slug: 'anomalyco/opencode',
          repoPath: clonedRepoPath,
          status: 'cloned',
          benchmarkedCases: 1,
        },
      ],
    });

    const report = getAcceptanceBenchmarkReport(db);
    expect(report.summary).toEqual([
      {
        classification: 'autofix_host_state_update',
        totalCases: 1,
        acceptedCases: 0,
        rejectedCases: 1,
        needsReviewCases: 0,
        acceptanceRate: 0,
      },
    ]);

    db.close();
  });

  it('annotates stored benchmark cases and updates the report summary', () => {
    const db = createTestDb();
    const statements = createStatements(db);

    statements.upsertAcceptanceBenchmarkCase.run({
      repository: 'openclaw/openclaw',
      local_path: TEST_LOCAL_REPO_PATH,
      commit_sha: 'abc123',
      scan_id: 1,
      cycle_id: 2,
      fix_candidate_id: 3,
      patch_id: 4,
      normalized_path: 'a.ts -> b.ts -> a.ts',
      classification: 'autofix_import_type',
      confidence: 0.9,
      upstreamability_score: 0.88,
      validation_status: 'passed',
      validation_summary: 'Cycle removed',
      review_status: 'pending',
      touched_files: '["a.ts","b.ts"]',
      feature_vector: '{"cycleSize":2}',
      planner_summary: 'Selected import_type',
      planner_attempts: '[]',
      acceptability: 'needs_review',
      rejection_reason: null,
      acceptability_note: null,
    });

    const initialReport = getAcceptanceBenchmarkReport(db);
    const [benchmarkCase] = initialReport.cases as AcceptanceBenchmarkCaseDTO[];
    expect(benchmarkCase.acceptability).toBe('needs_review');

    const updated = annotateAcceptanceBenchmarkCase(
      benchmarkCase.id,
      {
        acceptability: 'rejected',
        rejectionReason: 'semantic_wrong',
        note: 'Reject because it changes runtime behavior',
      },
      db,
    );

    expect(updated).toMatchObject({
      id: benchmarkCase.id,
      acceptability: 'rejected',
      rejection_reason: 'semantic_wrong',
      acceptability_note: 'Reject because it changes runtime behavior',
    });

    expect(getAcceptanceBenchmarkReport(db).summary).toEqual([
      {
        classification: 'autofix_import_type',
        totalCases: 1,
        acceptedCases: 0,
        rejectedCases: 1,
        needsReviewCases: 0,
        acceptanceRate: 0,
      },
    ]);

    db.close();
  });
});
