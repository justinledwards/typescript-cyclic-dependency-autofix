import { describe, expect, it, vi } from 'vitest';
import { createDatabase, createStatements, initSchema } from '../db/index.js';
import { getMlDisagreementReport } from '../db/mlReports.js';
import type { MlCandidateRankingRow, PreparedMlDatasets } from './ml/shared.js';
import { compareMlRanker, evaluateMlRanker, trainMlRanker } from './mlRanker.js';

vi.mock('./mlArtifacts.js', () => ({
  writeMlArtifact: vi.fn().mockImplementation(async (_kind: string, payload: unknown, version = 'ml-test') => ({
    version,
    // eslint-disable-next-line sonarjs/publicly-writable-directories
    artifactPath: '/tmp/ml-artifact.json',
    // eslint-disable-next-line sonarjs/publicly-writable-directories
    latestPath: '/tmp/latest-ml-artifact.json',
    payload,
  })),
}));

describe('mlRanker', () => {
  it('trains and evaluates a ranker on repo-holdout data', async () => {
    const datasets = createPreparedDatasets();

    const trained = await trainMlRanker({ datasets });
    expect(trained.models.acceptability).not.toBeNull();
    expect(trained.models.validation).not.toBeNull();
    expect(trained.trainingSummary.trainRows).toBeGreaterThan(0);
    expect(trained.trainingSummary.holdoutRows).toBeGreaterThan(0);

    const evaluation = await evaluateMlRanker({ datasets });
    expect(evaluation.acceptability?.accuracy ?? 0).toBeGreaterThan(0);
    expect(evaluation.top1Acceptability.cycleCount).toBeGreaterThan(0);
  });

  it('persists advisory scores and disagreement reports for candidate observations', async () => {
    const db = createDatabase(':memory:');
    initSchema(db);
    const statements = createStatements(db);

    const repositoryResult = statements.addRepository.run({
      owner: 'acme',
      name: 'widget',
      default_branch: 'main',
      // eslint-disable-next-line sonarjs/publicly-writable-directories
      local_path: '/tmp/widget',
    });
    const repositoryId = Number(repositoryResult.lastInsertRowid);
    const scanResult = statements.addScan.run({
      repository_id: repositoryId,
      commit_sha: 'abc123',
      status: 'completed',
    });
    const scanId = Number(scanResult.lastInsertRowid);
    const cycleResult = statements.addCycle.run({
      scan_id: scanId,
      normalized_path: 'src/a.ts -> src/b.ts -> src/a.ts',
      participating_files: JSON.stringify(['src/a.ts', 'src/b.ts']),
      raw_payload: null,
    });
    const cycleId = Number(cycleResult.lastInsertRowid);
    const observationResult = statements.addCycleObservation.run({
      cycle_id: cycleId,
      scan_id: scanId,
      repository_id: repositoryId,
      observation_version: 1,
      normalized_path: 'src/a.ts -> src/b.ts -> src/a.ts',
      planner_attempts: '[]',
    });
    const cycleObservationId = Number(observationResult.lastInsertRowid);

    statements.addCandidateObservation.run({
      cycle_observation_id: cycleObservationId,
      observation_version: 1,
      fix_candidate_id: null,
      patch_id: null,
      strategy: 'extract_shared',
      status: 'candidate',
      planner_rank: 1,
      promotion_eligible: 0,
      summary: null,
      classification: 'autofix_extract_shared',
      confidence: 0.75,
      upstreamability_score: 0.5,
      reasons: '[]',
      score_breakdown: '[]',
      signals: '{}',
      plan: null,
      validation_status: 'failed',
      validation_summary: null,
      validation_failure_category: 'typecheck_failed',
    });
    statements.addCandidateObservation.run({
      cycle_observation_id: cycleObservationId,
      observation_version: 1,
      fix_candidate_id: null,
      patch_id: null,
      strategy: 'host_state_update',
      status: 'candidate',
      planner_rank: 2,
      promotion_eligible: 1,
      summary: null,
      classification: 'autofix_host_state_update',
      confidence: 0.95,
      upstreamability_score: 0.95,
      reasons: '[]',
      score_breakdown: '[]',
      signals: '{}',
      plan: null,
      validation_status: 'passed',
      validation_summary: null,
      validation_failure_category: null,
    });

    const datasets: PreparedMlDatasets = {
      summary: {
        cyclePatterns: 0,
        candidateRanking: 6,
      },
      cyclePatterns: [],
      candidateRanking: createPreparedDatasets().candidateRanking.map((row, index) => {
        if (index < 4) {
          return {
            ...row,
            cycleObservationId: null,
            candidateObservationId: null,
          };
        }
        if (index === 4) {
          return {
            ...row,
            repositorySlug: 'acme/widget',
            cycleObservationId,
            cycleId,
            cycleGroupKey: 'acme/widget:abc123:src/a.ts -> src/b.ts -> src/a.ts',
            candidateObservationId: 1,
            plannerRank: 1,
            heuristicSelected: true,
            strategy: 'extract_shared',
            classification: 'autofix_extract_shared',
          };
        }
        if (index === 5) {
          return {
            ...row,
            repositorySlug: 'acme/widget',
            cycleObservationId,
            cycleId,
            cycleGroupKey: 'acme/widget:abc123:src/a.ts -> src/b.ts -> src/a.ts',
            candidateObservationId: 2,
            plannerRank: 2,
            heuristicSelected: false,
            strategy: 'host_state_update',
            classification: 'autofix_host_state_update',
          };
        }
        return row;
      }),
    };

    const comparison = await compareMlRanker({ database: db, datasets });
    expect(comparison.totalScoredCandidates).toBeGreaterThan(0);

    const scoreRows = db.prepare('SELECT * FROM candidate_ml_scores').all() as Array<{
      candidate_observation_id: number;
    }>;
    expect(scoreRows).toHaveLength(2);

    const rankingRows = db.prepare('SELECT * FROM ml_cycle_rankings').all() as Array<{ disagreement: number }>;
    expect(rankingRows).toHaveLength(1);

    const disagreementReport = getMlDisagreementReport(db, comparison.version);
    expect(disagreementReport.modelVersion).toBe(comparison.version);
    expect(disagreementReport.totalCycles).toBe(1);

    db.close();
  });
});

function createPreparedDatasets(): PreparedMlDatasets {
  return {
    summary: {
      cyclePatterns: 0,
      candidateRanking: 6,
    },
    cyclePatterns: [],
    candidateRanking: [
      createCandidateRow('candidate-observation:1', 'repo/a', 'cycle-a', 1, 'extract_shared', 0, 0, true),
      createCandidateRow('candidate-observation:2', 'repo/a', 'cycle-a', 2, 'host_state_update', 1, 1, false),
      createCandidateRow('candidate-observation:3', 'repo/b', 'cycle-b', 1, 'extract_shared', 0, 0, true),
      createCandidateRow('candidate-observation:4', 'repo/b', 'cycle-b', 2, 'host_state_update', 1, 1, false),
      createCandidateRow('candidate-observation:5', 'repo/c', 'cycle-c', 1, 'extract_shared', 0, 0, true),
      createCandidateRow('candidate-observation:6', 'repo/c', 'cycle-c', 2, 'host_state_update', 1, 1, false),
    ],
  };
}

function createCandidateRow(
  rowId: string,
  repositorySlug: string,
  cycleGroupKey: string,
  plannerRank: number,
  strategy: 'extract_shared' | 'host_state_update',
  acceptabilityTarget: 0 | 1,
  validationTarget: 0 | 1,
  introducesNewFile: boolean,
): MlCandidateRankingRow {
  const id = Number(rowId.split(':').at(-1) ?? 0);
  return {
    datasetType: 'candidate_ranking',
    rowId,
    sourceType: 'candidate_observation',
    repositorySlug,
    commitSha: 'abc123',
    cycleGroupKey,
    cycleId: id,
    cycleObservationId: id,
    candidateObservationId: id,
    acceptanceBenchmarkId: null,
    normalizedPath: `${cycleGroupKey}.ts`,
    strategy,
    classification: strategy === 'host_state_update' ? 'autofix_host_state_update' : 'autofix_extract_shared',
    plannerRank,
    heuristicSelected: plannerRank === 1,
    promotionEligible: strategy === 'host_state_update',
    candidateAcceptabilityTarget: acceptabilityTarget,
    candidateValidationTarget: validationTarget,
    cyclePatternTarget: strategy === 'host_state_update' ? 'ownership_localization' : 'extract_shared',
    featureColumns: {
      numeric: {
        cycleSize: 2,
        candidate_plannerRank: plannerRank,
        candidate_signal_introducesNewFile: introducesNewFile ? 1 : 0,
        candidate_signal_preservesSourceExports: introducesNewFile ? 0 : 1,
        candidate_confidence: strategy === 'host_state_update' ? 0.95 : 0.7,
        candidate_upstreamabilityScore: strategy === 'host_state_update' ? 0.9 : 0.45,
      },
      categorical: {
        candidate_strategy: strategy,
        packageManager: 'pnpm',
        workspaceMode: 'workspace',
      },
      multiLabel: {
        patternCategories: [strategy === 'host_state_update' ? 'ownership_localization' : 'extract_shared'],
      },
    },
  };
}
