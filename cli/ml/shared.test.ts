import { describe, expect, it } from 'vitest';
import type {
  AcceptanceBenchmarkTrainingRow,
  BenchmarkCaseTrainingRow,
  CandidateObservationTrainingRow,
  CycleObservationTrainingRow,
  TrainingDataExport,
} from '../../db/trainingData.js';
import {
  encodeFeatureRows,
  prepareMlDatasetsFromExport,
  splitCandidateRowsByLabeledRepositoryHoldout,
  splitRowsByRepositoryHoldout,
} from './shared.js';

describe('ml/shared', () => {
  it('prepares flattened ML datasets and derives labels from review, validation, and benchmark rows', () => {
    const cycleObservation = createCycleObservationRow();
    const candidateRejected = createCandidateObservationRow({
      rowId: 'candidate-observation:1',
      repositorySlug: 'acme/widget',
      candidateObservationId: 1,
      reviewStatus: 'rejected',
      validationStatus: 'failed',
      plannerRank: 1,
      strategy: 'extract_shared',
      classification: 'autofix_extract_shared',
      promotionEligible: false,
      introducesNewFile: true,
    });
    const candidateApproved = createCandidateObservationRow({
      rowId: 'candidate-observation:2',
      repositorySlug: 'acme/widget',
      candidateObservationId: 2,
      reviewStatus: 'approved',
      validationStatus: 'passed',
      plannerRank: 2,
      strategy: 'host_state_update',
      classification: 'autofix_host_state_update',
      promotionEligible: true,
      introducesNewFile: false,
    });
    const acceptanceBenchmark = createAcceptanceBenchmarkRow();
    const benchmarkCase = createBenchmarkCaseRow();
    const exportData: TrainingDataExport = {
      summary: {
        totalRows: 4,
        cycleObservationRows: 1,
        candidateObservationRows: 2,
        acceptanceBenchmarkRows: 1,
        benchmarkCaseRows: 1,
      },
      rows: [cycleObservation, candidateRejected, candidateApproved, acceptanceBenchmark, benchmarkCase],
    };

    const datasets = prepareMlDatasetsFromExport(exportData);

    expect(datasets.summary.cyclePatterns).toBe(1);
    expect(datasets.summary.candidateRanking).toBe(3);
    expect(datasets.cyclePatterns[0]).toMatchObject({
      cyclePatternTarget: 'ownership_localization',
      acceptedCandidateCount: 1,
      rejectedCandidateCount: 1,
      supportedCandidateCount: 2,
    });

    const approvedCandidate = datasets.candidateRanking.find((row) => row.rowId === 'candidate-observation:2');
    expect(approvedCandidate).toMatchObject({
      candidateAcceptabilityTarget: 1,
      candidateValidationTarget: 1,
      cyclePatternTarget: 'ownership_localization',
    });
    expect(approvedCandidate?.featureColumns.numeric.candidate_signal_touchedFiles).toBe(2);
    expect(approvedCandidate?.featureColumns.numeric.historical_repositoryBenchmarkCount).toBe(1);

    const rejectedCandidate = datasets.candidateRanking.find((row) => row.rowId === 'candidate-observation:1');
    expect(rejectedCandidate).toMatchObject({
      candidateAcceptabilityTarget: 0,
      candidateValidationTarget: 0,
    });

    const acceptanceRow = datasets.candidateRanking.find((row) => row.sourceType === 'acceptance_benchmark');
    expect(acceptanceRow).toMatchObject({
      candidateAcceptabilityTarget: 1,
      candidateValidationTarget: 1,
      strategy: 'direct_import',
    });
  });

  it('one-hot encodes categorical and multi-label features and creates stable repo holdouts', () => {
    const rows = [
      {
        rowId: 'row-1',
        repositorySlug: 'acme/a',
        featureColumns: {
          numeric: {
            cycleSize: 2,
          },
          categorical: {
            strategy: 'host_state_update',
          },
          multiLabel: {
            patternCategories: ['ownership_localization'],
          },
        },
      },
      {
        rowId: 'row-2',
        repositorySlug: 'acme/b',
        featureColumns: {
          numeric: {
            cycleSize: 5,
          },
          categorical: {
            strategy: 'direct_import',
          },
          multiLabel: {
            patternCategories: ['public_seam_bypass'],
          },
        },
      },
    ];

    const encoded = encodeFeatureRows(rows);
    expect(encoded.schema.numericKeys).toEqual(['cycleSize']);
    expect(encoded.schema.categoricalValues.strategy).toEqual(['direct_import', 'host_state_update']);
    expect(encoded.schema.multiLabelValues.patternCategories).toEqual(['ownership_localization', 'public_seam_bypass']);
    expect(encoded.matrix).toHaveLength(2);
    expect(encoded.matrix[0]?.length).toBe(5);

    const split = splitRowsByRepositoryHoldout(rows, 0.5);
    expect(split.holdoutRepositories).toEqual(['acme/b']);
    expect(split.trainRows).toHaveLength(1);
    expect(split.holdoutRows).toHaveLength(1);
  });

  it('prefers labeled repositories when selecting candidate holdouts', () => {
    const split = splitCandidateRowsByLabeledRepositoryHoldout(
      [
        {
          datasetType: 'candidate_ranking',
          rowId: 'candidate-observation:1',
          sourceType: 'candidate_observation',
          repositorySlug: 'acme/a',
          commitSha: 'abc123',
          cycleGroupKey: 'acme/a:cycle-a',
          cycleId: 1,
          cycleObservationId: 1,
          candidateObservationId: 1,
          acceptanceBenchmarkId: null,
          normalizedPath: 'src/a.ts -> src/b.ts -> src/a.ts',
          strategy: 'extract_shared',
          classification: 'autofix_extract_shared',
          plannerRank: 1,
          heuristicSelected: true,
          promotionEligible: false,
          candidateAcceptabilityTarget: 0,
          candidateValidationTarget: 0,
          cyclePatternTarget: 'extract_shared',
          featureColumns: {
            numeric: {},
            categorical: {},
            multiLabel: {},
          },
        },
        {
          datasetType: 'candidate_ranking',
          rowId: 'candidate-observation:2',
          sourceType: 'candidate_observation',
          repositorySlug: 'acme/b',
          commitSha: 'abc123',
          cycleGroupKey: 'acme/b:cycle-b',
          cycleId: 2,
          cycleObservationId: 2,
          candidateObservationId: 2,
          acceptanceBenchmarkId: null,
          normalizedPath: 'src/c.ts -> src/d.ts -> src/c.ts',
          strategy: 'host_state_update',
          classification: 'autofix_host_state_update',
          plannerRank: 1,
          heuristicSelected: true,
          promotionEligible: true,
          candidateAcceptabilityTarget: 1,
          candidateValidationTarget: 1,
          cyclePatternTarget: 'ownership_localization',
          featureColumns: {
            numeric: {},
            categorical: {},
            multiLabel: {},
          },
        },
        {
          datasetType: 'candidate_ranking',
          rowId: 'candidate-observation:3',
          sourceType: 'candidate_observation',
          repositorySlug: 'zzz/unlabeled',
          commitSha: 'abc123',
          cycleGroupKey: 'zzz/unlabeled:cycle-c',
          cycleId: 3,
          cycleObservationId: 3,
          candidateObservationId: 3,
          acceptanceBenchmarkId: null,
          normalizedPath: 'src/e.ts -> src/f.ts -> src/e.ts',
          strategy: 'direct_import',
          classification: 'autofix_direct_import',
          plannerRank: 1,
          heuristicSelected: true,
          promotionEligible: true,
          candidateAcceptabilityTarget: null,
          candidateValidationTarget: null,
          cyclePatternTarget: 'public_seam_bypass',
          featureColumns: {
            numeric: {},
            categorical: {},
            multiLabel: {},
          },
        },
      ],
      0.5,
    );

    expect(split.holdoutRepositories).toEqual(['acme/b']);
    expect(split.holdoutRows).toHaveLength(1);
    expect(split.trainRows).toHaveLength(2);
  });
});

function createCycleObservationRow(): CycleObservationTrainingRow {
  return {
    rowType: 'cycle_observation',
    rowId: 'cycle-observation:1',
    repository: {
      id: 1,
      slug: 'acme/widget',
    },
    scanId: 10,
    commitSha: 'abc123',
    cycleId: 100,
    observationId: 1,
    observationVersion: 1,
    normalizedPath: 'src/app-chat.ts -> src/app-settings.ts -> src/app-chat.ts',
    cycleShape: 'two_file',
    cycleSize: 2,
    cycleSignals: {
      explicitImportEdges: 2,
      loadedFiles: 2,
      missingFiles: 0,
    },
    featureVector: {
      cycleSize: 2,
      cycleShape: 'two_file',
      explicitImportEdges: 2,
      loadedFiles: 2,
      missingFiles: 0,
      packageManager: 'pnpm',
      workspaceMode: 'workspace',
      validationCommandCount: 3,
      symbolNodeCount: 4,
      symbolEdgeCount: 3,
      patternCategories: ['ownership_localization'],
    },
    graphSummary: {
      patternCategories: ['ownership_localization'],
      metrics: {
        symbolNodeCount: 4,
      },
    },
    repoProfile: {
      packageManager: 'pnpm',
      workspaceMode: 'workspace',
      validationCommandCount: 3,
    },
    planner: {
      summary: 'Host-owned state update looks safest.',
      attempts: [],
      selectedStrategy: 'host_state_update',
      selectedClassification: 'autofix_host_state_update',
      selectedScore: 0.92,
      fallbackClassification: 'suggest_manual',
      fallbackConfidence: 0.4,
      fallbackReasons: [],
    },
  };
}

function createCandidateObservationRow(args: {
  rowId: string;
  repositorySlug: string;
  candidateObservationId: number;
  reviewStatus: 'approved' | 'rejected';
  validationStatus: 'passed' | 'failed';
  plannerRank: number;
  strategy: 'extract_shared' | 'host_state_update';
  classification: 'autofix_extract_shared' | 'autofix_host_state_update';
  promotionEligible: boolean;
  introducesNewFile: boolean;
}): CandidateObservationTrainingRow {
  return {
    rowType: 'candidate_observation',
    rowId: args.rowId,
    repository: {
      id: 1,
      slug: args.repositorySlug,
    },
    scanId: 10,
    commitSha: 'abc123',
    cycleId: 100,
    observationId: 1,
    observationVersion: 1,
    candidateObservationId: args.candidateObservationId,
    fixCandidateId: args.candidateObservationId,
    patchId: args.candidateObservationId,
    normalizedPath: 'src/app-chat.ts -> src/app-settings.ts -> src/app-chat.ts',
    cycleShape: 'two_file',
    cycleSize: 2,
    cycleSignals: {
      explicitImportEdges: 2,
    },
    featureVector: {
      cycleSize: 2,
      cycleShape: 'two_file',
      packageManager: 'pnpm',
      workspaceMode: 'workspace',
      patternCategories: ['ownership_localization'],
      symbolNodeCount: 4,
      symbolEdgeCount: 3,
    },
    graphSummary: {
      patternCategories: ['ownership_localization'],
    },
    repoProfile: {
      packageManager: 'pnpm',
      workspaceMode: 'workspace',
      validationCommandCount: 3,
    },
    planner: {
      summary: 'Cycle planner summary',
      selectedStrategy: 'host_state_update',
      selectedClassification: 'autofix_host_state_update',
      fallbackClassification: 'suggest_manual',
    },
    candidate: {
      strategy: args.strategy,
      status: 'candidate',
      plannerRank: args.plannerRank,
      promotionEligible: args.promotionEligible,
      summary: null,
      classification: args.classification,
      confidence: 0.9,
      upstreamabilityScore: 0.8,
      reasons: [],
      scoreBreakdown: [],
      signals: {
        touchedFiles: 2,
        introducesNewFile: args.introducesNewFile,
        preservesSourceExports: !args.introducesNewFile,
        historicalBenchmarkMatches: 3,
      },
      plan: {
        kind: args.strategy,
        preserveSourceExports: !args.introducesNewFile,
      },
    },
    validation: {
      status: args.validationStatus,
      summary: null,
      failureCategory: args.validationStatus === 'failed' ? 'typecheck_failed' : null,
    },
    review: {
      status: args.reviewStatus,
      notes: null,
    },
    patch: {
      touchedFiles: ['src/app-chat.ts', 'src/app-settings.ts'],
      patchText: 'diff --git a b',
    },
  };
}

function createAcceptanceBenchmarkRow(): AcceptanceBenchmarkTrainingRow {
  return {
    rowType: 'acceptance_benchmark',
    rowId: 'acceptance-benchmark:1',
    repository: {
      slug: 'acme/widget',
      localPath: null,
    },
    commitSha: 'def456',
    scanId: 11,
    cycleId: 101,
    fixCandidateId: 12,
    patchId: 13,
    normalizedPath: 'src/api.ts -> src/setup-core.ts -> src/api.ts',
    classification: 'autofix_direct_import',
    confidence: 0.88,
    upstreamabilityScore: 0.87,
    validation: {
      status: 'passed',
      summary: 'Validation passed',
    },
    reviewStatus: 'approved',
    touchedFiles: ['src/api.ts'],
    featureVector: {
      cycleSize: 2,
      cycleShape: 'two_file',
      packageManager: 'pnpm',
      workspaceMode: 'workspace',
      patternCategories: ['public_seam_bypass'],
      cyclePublicSeamEdgeCount: 1,
    },
    plannerSummary: null,
    plannerAttempts: [],
    acceptability: {
      decision: 'accepted',
      rejectionReason: null,
      note: null,
    },
  };
}

function createBenchmarkCaseRow(): BenchmarkCaseTrainingRow {
  return {
    rowType: 'benchmark_case',
    rowId: 'benchmark-case:1',
    repository: 'acme/widget',
    source: 'git-log',
    commitSha: 'ghi789',
    title: 'break app chat settings cycle',
    body: null,
    url: null,
    prNumber: null,
    issueNumber: null,
    strategyLabels: ['host_state_update', 'ownership_localization'],
    validationSignals: {
      language_scope: {
        training_language: 'js_ts',
        eligible: true,
      },
    },
    diffFeatures: {},
    matchedTerms: ['cycle'],
    notes: null,
  };
}
