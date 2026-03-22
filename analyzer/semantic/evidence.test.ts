import { beforeEach, describe, expect, it, vi } from 'vitest';

const evidenceFixtures = vi.hoisted(() => ({
  benchmarkCases: [] as Array<Record<string, unknown>>,
  acceptanceBenchmarkCases: [] as Array<Record<string, unknown>>,
  reviewRows: [] as Array<Record<string, unknown>>,
  replayRows: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../db/index.js', () => ({
  getBenchmarkCases: {
    all: vi.fn(() => evidenceFixtures.benchmarkCases),
  },
  getAcceptanceBenchmarkCases: {
    all: vi.fn(() => evidenceFixtures.acceptanceBenchmarkCases),
  },
  getDb: () => ({
    prepare: (query: string) => ({
      all: vi.fn(() => (query.includes('patch_replays') ? evidenceFixtures.replayRows : evidenceFixtures.reviewRows)),
    }),
  }),
}));

import { loadHistoricalEvidence } from './evidence.js';

describe('historical evidence loading', () => {
  beforeEach(() => {
    evidenceFixtures.benchmarkCases = [];
    evidenceFixtures.acceptanceBenchmarkCases = [];
    evidenceFixtures.reviewRows = [];
    evidenceFixtures.replayRows = [];
  });

  it('hydrates acceptance benchmark outcomes and replay failure categories into strategy evidence', () => {
    evidenceFixtures.benchmarkCases = [
      {
        strategy_labels: JSON.stringify(['direct_import']),
        validation_signals: JSON.stringify({
          repository_profile: {
            package_manager: 'pnpm',
            workspace_mode: 'workspace',
          },
        }),
      },
    ];
    evidenceFixtures.acceptanceBenchmarkCases = [
      {
        classification: 'autofix_import_type',
        acceptability: 'accepted',
        rejection_reason: null,
        feature_vector: JSON.stringify({
          packageManager: 'pnpm',
          workspaceMode: 'workspace',
        }),
      },
      {
        classification: 'autofix_extract_shared',
        acceptability: 'rejected',
        rejection_reason: 'semantic_wrong',
        feature_vector: JSON.stringify({
          packageManager: 'pnpm',
          workspaceMode: 'workspace',
        }),
      },
      {
        classification: 'autofix_extract_shared',
        acceptability: 'rejected',
        rejection_reason: 'diff_noisy',
        feature_vector: JSON.stringify({
          packageManager: 'npm',
          workspaceMode: 'single-package',
        }),
      },
    ];
    evidenceFixtures.reviewRows = [
      {
        classification: 'autofix_direct_import',
        validation_status: 'passed',
        decision: 'approved',
      },
      {
        classification: 'autofix_extract_shared',
        validation_status: 'failed',
        decision: 'rejected',
      },
    ];
    evidenceFixtures.replayRows = [
      {
        classification: 'autofix_extract_shared',
        replay_bundle: JSON.stringify({
          validation: {
            failureCategory: 'new_cycles_introduced',
          },
        }),
      },
      {
        classification: 'autofix_extract_shared',
        replay_bundle: JSON.stringify({
          validation: {
            failureCategory: 'repo_validation_failed',
          },
        }),
      },
    ];

    const snapshot = loadHistoricalEvidence({
      packageManager: 'pnpm',
      workspaceMode: 'workspace',
      validationCommandCount: 3,
    });

    expect(snapshot.totalBenchmarkCases).toBe(1);
    expect(snapshot.totalAcceptanceBenchmarkCases).toBe(3);
    expect(snapshot.totalReviewedPatches).toBe(2);
    expect(snapshot.totalValidatedPatches).toBe(2);
    expect(snapshot.strategies.direct_import).toMatchObject({
      benchmarkMatches: 1,
      profileMatches: 2,
      approvedReviews: 1,
      passedValidations: 1,
    });
    expect(snapshot.strategies.import_type).toMatchObject({
      acceptedBenchmarks: 1,
      acceptanceProfileMatches: 2,
    });
    expect(snapshot.strategies.extract_shared).toMatchObject({
      rejectedBenchmarks: 2,
      semanticWrongRejections: 1,
      diffNoisyRejections: 1,
      rejectedReviews: 1,
      failedValidations: 1,
      newCyclesIntroducedFailures: 1,
      repoValidationFailures: 1,
    });
  });
});
