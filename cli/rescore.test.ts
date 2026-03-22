import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as dbModule from '../db/index.js';
import { rescoreStoredCycles, retryFailedPatchCandidates } from './rescore.js';

const testWorktreesDir = `${process.cwd()}/.test-fixtures/rescore-worktrees`;

vi.mock('simple-git', () => ({
  default: vi.fn(() => ({
    log: vi.fn(),
  })),
}));

vi.mock('../analyzer/semantic/index.js', () => ({
  SemanticAnalyzer: class {
    public analyzeCycle() {
      return {
        classification: 'autofix_import_type',
        confidence: 0.91,
        reasons: ['Converted runtime edges to type-only imports.'],
        plan: {
          kind: 'import_type',
          imports: [{ sourceFile: 'a.ts', targetFile: 'b.ts' }],
        },
        upstreamabilityScore: 0.94,
        planner: {
          cycleFiles: ['a.ts', 'b.ts'],
          cycleSize: 2,
          cycleShape: 'two_file',
          cycleSignals: { explicitImportEdges: 2, loadedFiles: 2, missingFiles: 0 },
          features: {
            cycleSize: 2,
            cycleShape: 'two_file',
            explicitImportEdges: 2,
            loadedFiles: 2,
            missingFiles: 0,
            hasBarrelFile: false,
            hasSharedModuleFile: false,
            typescriptFileCount: 2,
            tsxFileCount: 0,
            packageManager: 'pnpm',
            workspaceMode: 'workspace',
            validationCommandCount: 1,
          },
          fallbackClassification: 'autofix_import_type',
          fallbackConfidence: 0.91,
          fallbackReasons: ['Converted runtime edges to type-only imports.'],
          selectedStrategy: 'import_type',
          selectedClassification: 'autofix_import_type',
          selectedScore: 0.94,
          selectionSummary: 'Selected import_type.',
          rankedCandidates: [
            {
              strategy: 'import_type',
              status: 'candidate',
              summary: 'Convert the cycle imports to type-only imports.',
              reasons: ['Converted runtime edges to type-only imports.'],
              signals: { touchedFiles: 1 },
              score: 0.94,
              scoreBreakdown: ['base 0.97'],
              classification: 'autofix_import_type',
              confidence: 0.91,
              plan: {
                kind: 'import_type',
                imports: [{ sourceFile: 'a.ts', targetFile: 'b.ts' }],
              },
            },
          ],
          attempts: [
            {
              strategy: 'import_type',
              status: 'candidate',
              summary: 'Convert the cycle imports to type-only imports.',
              reasons: ['Converted runtime edges to type-only imports.'],
              signals: { touchedFiles: 1 },
              score: 0.94,
              scoreBreakdown: ['base 0.97'],
              classification: 'autofix_import_type',
              confidence: 0.91,
              plan: {
                kind: 'import_type',
                imports: [{ sourceFile: 'a.ts', targetFile: 'b.ts' }],
              },
            },
          ],
        },
      };
    }
  },
}));

vi.mock('./repoProfile.js', () => ({
  profileRepository: vi.fn().mockResolvedValue({
    packageManager: 'pnpm',
    workspaceMode: 'workspace',
    validationCommands: ['pnpm lint'],
  }),
}));

vi.mock('./scanner/target.js', () => ({
  resolveScanTarget: vi.fn().mockResolvedValue({
    owner: 'acme',
    name: 'app',
    repoPath: '/resolved/app',
    localPath: '/repos/app',
    cloneUrl: null,
    remoteUrl: 'https://github.com/acme/app.git',
  }),
  syncRepositoryClone: vi.fn().mockResolvedValue('cloned'),
}));

vi.mock('./scanner/persistence.js', () => ({
  getLatestCommitSha: vi.fn().mockResolvedValue('rescored-sha'),
  getNextCycleObservationVersion: vi.fn().mockReturnValue(2),
  persistCycleObservationVersion: vi.fn().mockResolvedValue(101),
}));

vi.mock('../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../db/index.js')>('../db/index.js');
  const db = actual.createDatabase(':memory:');
  actual.initSchema(db);
  const stmts = actual.createStatements(db);

  return {
    ...actual,
    getDb: () => db,
    addRepository: stmts.addRepository,
    getRepository: stmts.getRepository,
    updateRepositoryLocalPath: stmts.updateRepositoryLocalPath,
    addScan: stmts.addScan,
    addCycle: stmts.addCycle,
    addCycleObservation: stmts.addCycleObservation,
    addCandidateObservation: stmts.addCandidateObservation,
  };
});

describe('rescoreStoredCycles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbModule.getDb().prepare('DELETE FROM candidate_observations').run();
    dbModule.getDb().prepare('DELETE FROM cycle_observations').run();
    dbModule.getDb().prepare('DELETE FROM cycles').run();
    dbModule.getDb().prepare('DELETE FROM scans').run();
    dbModule.getDb().prepare('DELETE FROM repositories').run();
  });

  it('rescales stored cycles into a new observation version', async () => {
    const repositoryInfo = dbModule.addRepository.run({
      owner: 'acme',
      name: 'app',
      default_branch: 'main',
      local_path: '/repos/app',
    });
    const repositoryId = repositoryInfo.lastInsertRowid as number;
    const scanInfo = dbModule.addScan.run({
      repository_id: repositoryId,
      commit_sha: 'old-sha',
      status: 'completed',
    });
    const scanId = scanInfo.lastInsertRowid as number;
    const cycleInfo = dbModule.addCycle.run({
      scan_id: scanId,
      normalized_path: 'a.ts -> b.ts',
      participating_files: JSON.stringify(['a.ts', 'b.ts']),
      raw_payload: JSON.stringify({
        type: 'circular',
        path: ['a.ts', 'b.ts'],
      }),
    });
    const cycleId = cycleInfo.lastInsertRowid as number;

    dbModule.addCycleObservation.run({
      cycle_id: cycleId,
      scan_id: scanId,
      repository_id: repositoryId,
      observation_version: 1,
      normalized_path: 'a.ts -> b.ts',
      cycle_shape: 'two_file',
      cycle_size: 2,
      cycle_signals: JSON.stringify({ explicitImportEdges: 2 }),
      feature_vector: JSON.stringify({ cycleShape: 'two_file' }),
      repo_profile: JSON.stringify({ packageManager: 'pnpm', workspaceMode: 'workspace' }),
      planner_summary: 'Original observation.',
      planner_attempts: JSON.stringify([]),
      selected_strategy: 'import_type',
      selected_classification: 'autofix_import_type',
      selected_score: 0.9,
      fallback_classification: 'autofix_import_type',
      fallback_confidence: 0.9,
      fallback_reasons: JSON.stringify(['original']),
    });

    const result = await rescoreStoredCycles({
      cycleIds: [cycleId],
      worktreesDir: testWorktreesDir,
    });

    const { persistCycleObservationVersion } = await import('./scanner/persistence.js');

    expect(vi.mocked(persistCycleObservationVersion)).toHaveBeenCalledWith(
      expect.objectContaining({
        cycleId,
        observationVersion: 2,
        scanId,
        repoPath: path.join('/resolved', 'app'),
        sourceTarget: '/repos/app',
        commitSha: 'rescored-sha',
        cycle: expect.objectContaining({
          path: ['a.ts', 'b.ts'],
          analysis: expect.objectContaining({
            classification: 'autofix_import_type',
          }),
        }),
      }),
    );
    expect(result).toMatchObject({
      processedCycles: 1,
      skippedCycles: 0,
      createdObservations: 1,
      cycleIds: [cycleId],
    });
  });

  it('retries only the latest failed candidate observations', async () => {
    const repositoryInfo = dbModule.addRepository.run({
      owner: 'acme',
      name: 'app',
      default_branch: 'main',
      local_path: '/repos/app',
    });
    const repositoryId = repositoryInfo.lastInsertRowid as number;
    const scanInfo = dbModule.addScan.run({
      repository_id: repositoryId,
      commit_sha: 'old-sha',
      status: 'completed',
    });
    const scanId = scanInfo.lastInsertRowid as number;

    const firstCycleInfo = dbModule.addCycle.run({
      scan_id: scanId,
      normalized_path: 'a.ts -> b.ts',
      participating_files: JSON.stringify(['a.ts', 'b.ts']),
      raw_payload: JSON.stringify({
        type: 'circular',
        path: ['a.ts', 'b.ts'],
      }),
    });
    const secondCycleInfo = dbModule.addCycle.run({
      scan_id: scanId,
      normalized_path: 'c.ts -> d.ts',
      participating_files: JSON.stringify(['c.ts', 'd.ts']),
      raw_payload: JSON.stringify({
        type: 'circular',
        path: ['c.ts', 'd.ts'],
      }),
    });

    const failedObservation = dbModule.addCycleObservation.run({
      cycle_id: firstCycleInfo.lastInsertRowid as number,
      scan_id: scanId,
      repository_id: repositoryId,
      observation_version: 1,
      normalized_path: 'a.ts -> b.ts',
      cycle_shape: 'two_file',
      cycle_size: 2,
      cycle_signals: JSON.stringify({ explicitImportEdges: 2 }),
      feature_vector: JSON.stringify({ cycleShape: 'two_file' }),
      repo_profile: JSON.stringify({ packageManager: 'pnpm', workspaceMode: 'workspace' }),
      planner_summary: 'Failed observation.',
      planner_attempts: JSON.stringify([]),
      selected_strategy: 'import_type',
      selected_classification: 'autofix_import_type',
      selected_score: 0.9,
      fallback_classification: 'autofix_import_type',
      fallback_confidence: 0.9,
      fallback_reasons: JSON.stringify(['failed']),
    });
    const passedObservation = dbModule.addCycleObservation.run({
      cycle_id: secondCycleInfo.lastInsertRowid as number,
      scan_id: scanId,
      repository_id: repositoryId,
      observation_version: 1,
      normalized_path: 'c.ts -> d.ts',
      cycle_shape: 'two_file',
      cycle_size: 2,
      cycle_signals: JSON.stringify({ explicitImportEdges: 2 }),
      feature_vector: JSON.stringify({ cycleShape: 'two_file' }),
      repo_profile: JSON.stringify({ packageManager: 'pnpm', workspaceMode: 'workspace' }),
      planner_summary: 'Passed observation.',
      planner_attempts: JSON.stringify([]),
      selected_strategy: 'import_type',
      selected_classification: 'autofix_import_type',
      selected_score: 0.9,
      fallback_classification: 'autofix_import_type',
      fallback_confidence: 0.9,
      fallback_reasons: JSON.stringify(['passed']),
    });

    dbModule.addCandidateObservation.run({
      cycle_observation_id: failedObservation.lastInsertRowid as number,
      observation_version: 1,
      fix_candidate_id: null,
      patch_id: null,
      strategy: 'import_type',
      status: 'candidate',
      planner_rank: 1,
      promotion_eligible: 1,
      summary: 'Failed patch candidate',
      classification: 'autofix_import_type',
      confidence: 0.9,
      upstreamability_score: 0.9,
      reasons: JSON.stringify(['failed']),
      score_breakdown: JSON.stringify(['base 0.97']),
      signals: JSON.stringify({ touchedFiles: 1 }),
      plan: JSON.stringify({
        kind: 'import_type',
        imports: [{ sourceFile: 'a.ts', targetFile: 'b.ts' }],
      }),
      validation_status: 'failed',
      validation_summary: 'Typecheck failed.',
      validation_failure_category: 'typecheck_failed',
    });
    dbModule.addCandidateObservation.run({
      cycle_observation_id: passedObservation.lastInsertRowid as number,
      observation_version: 1,
      fix_candidate_id: null,
      patch_id: null,
      strategy: 'import_type',
      status: 'candidate',
      planner_rank: 1,
      promotion_eligible: 1,
      summary: 'Passed patch candidate',
      classification: 'autofix_import_type',
      confidence: 0.9,
      upstreamability_score: 0.9,
      reasons: JSON.stringify(['passed']),
      score_breakdown: JSON.stringify(['base 0.97']),
      signals: JSON.stringify({ touchedFiles: 1 }),
      plan: JSON.stringify({
        kind: 'import_type',
        imports: [{ sourceFile: 'c.ts', targetFile: 'd.ts' }],
      }),
      validation_status: 'passed',
      validation_summary: 'Validation passed.',
      validation_failure_category: null,
    });

    const result = await retryFailedPatchCandidates({
      worktreesDir: testWorktreesDir,
    });

    const { persistCycleObservationVersion } = await import('./scanner/persistence.js');

    expect(vi.mocked(persistCycleObservationVersion)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(persistCycleObservationVersion)).toHaveBeenCalledWith(
      expect.objectContaining({
        cycleId: firstCycleInfo.lastInsertRowid as number,
      }),
    );
    expect(result).toMatchObject({
      processedCycles: 1,
      retriedOnlyFailed: true,
      cycleIds: [firstCycleInfo.lastInsertRowid as number],
    });
  });
});
