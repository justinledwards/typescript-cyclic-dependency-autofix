import type { Database as DatabaseType } from 'better-sqlite3';
import type { Matrix as MatrixType } from 'ml-matrix';
import { Matrix } from 'ml-matrix';
import { createStatements, getDb } from '../db/index.js';
import {
  buildPreferenceFeatureColumns,
  computeBinaryClassificationMetrics,
  encodeFeatureRows,
  type FeatureSchema,
  getBinaryClassProbabilities,
  LogisticRegression,
  type MlCandidatePreferenceRow,
  type MlCandidateRankingRow,
  type PreparedMlDatasets,
  prepareMlDatasets,
  SAFE_ML_STRATEGIES,
  sortCopy,
  splitCandidateRowsByLabeledRepositoryHoldout,
  splitRowsByRepositoryHoldout,
} from './ml/shared.js';
import { writeMlArtifact } from './mlArtifacts.js';

export interface BinaryModelArtifact {
  label: 'acceptability' | 'validation' | 'preference';
  modelJson: unknown;
  featureSchema: FeatureSchema;
  featureNames: string[];
  positiveLabel: 1;
}

export interface MlRankerArtifact {
  version: string;
  createdAt: string;
  holdoutRepositories: string[];
  trainingSummary: {
    totalCandidateRows: number;
    totalPreferenceRows: number;
    labeledAcceptabilityRows: number;
    labeledValidationRows: number;
    labeledPreferenceRows: number;
    trainRows: number;
    holdoutRows: number;
  };
  models: {
    acceptability: BinaryModelArtifact | null;
    validation: BinaryModelArtifact | null;
    preference: BinaryModelArtifact | null;
  };
  evaluation: {
    acceptability: ReturnType<typeof computeBinaryClassificationMetrics> | null;
    validation: ReturnType<typeof computeBinaryClassificationMetrics> | null;
    preference: ReturnType<typeof computeBinaryClassificationMetrics> | null;
    top1Acceptability: {
      heuristic: number;
      model: number;
      cycleCount: number;
      beatsHeuristic: boolean;
    };
  };
}

export interface MlTrainRankerOptions {
  database?: DatabaseType;
  datasets?: PreparedMlDatasets;
}

export interface MlCompareResult {
  version: string;
  totalScoredCandidates: number;
  totalCycles: number;
  disagreements: number;
  rows: Array<{
    cycleObservationId: number;
    heuristicCandidateObservationId: number | null;
    modelCandidateObservationId: number | null;
    heuristicStrategy: string | null;
    modelStrategy: string | null;
    disagreement: boolean;
  }>;
}

export async function trainMlRanker(options: MlTrainRankerOptions = {}): Promise<MlRankerArtifact> {
  const database = options.database ?? (options.datasets ? null : getDb());
  const datasets = options.datasets ?? prepareMlDatasets(database ?? getDb());
  const candidateRows = [...datasets.candidateRanking, ...datasets.syntheticFixtures].filter(
    (row) => row.strategy && SAFE_ML_STRATEGIES.has(row.strategy),
  );
  const preferenceRows = datasets.candidatePreferences;
  const split = splitCandidateRowsByLabeledRepositoryHoldout(candidateRows);
  const preferenceSplit = splitRowsByRepositoryHoldout(preferenceRows);

  const labeledAcceptabilityTrainRows = split.trainRows.filter((row) => row.candidateAcceptabilityTarget !== null);
  const labeledValidationTrainRows = split.trainRows.filter((row) => row.candidateValidationTarget !== null);
  const labeledAcceptabilityHoldoutRows = split.holdoutRows.filter((row) => row.candidateAcceptabilityTarget !== null);
  const labeledValidationHoldoutRows = split.holdoutRows.filter((row) => row.candidateValidationTarget !== null);

  const acceptabilityModel = trainCandidateBinaryModel(labeledAcceptabilityTrainRows, 'candidateAcceptabilityTarget');
  const validationModel = trainCandidateBinaryModel(labeledValidationTrainRows, 'candidateValidationTarget');
  const preferenceModel = trainPreferenceBinaryModel(preferenceSplit.trainRows);

  const acceptabilityEvaluation = evaluateBinaryModel(
    acceptabilityModel,
    labeledAcceptabilityHoldoutRows,
    'candidateAcceptabilityTarget',
  );
  const validationEvaluation = evaluateBinaryModel(
    validationModel,
    labeledValidationHoldoutRows,
    'candidateValidationTarget',
  );
  const preferenceEvaluation = evaluatePreferenceModel(preferenceModel, preferenceSplit.holdoutRows);
  const top1Acceptability = compareHeuristicVsModelTop1(
    acceptabilityModel,
    validationModel,
    preferenceModel,
    split.holdoutRows,
  );

  const payload: Omit<MlRankerArtifact, 'version'> = {
    createdAt: new Date().toISOString(),
    holdoutRepositories: split.holdoutRepositories,
    trainingSummary: {
      totalCandidateRows: candidateRows.length,
      totalPreferenceRows: preferenceRows.length,
      labeledAcceptabilityRows: labeledAcceptabilityTrainRows.length + labeledAcceptabilityHoldoutRows.length,
      labeledValidationRows: labeledValidationTrainRows.length + labeledValidationHoldoutRows.length,
      labeledPreferenceRows: preferenceSplit.trainRows.length + preferenceSplit.holdoutRows.length,
      trainRows: split.trainRows.length,
      holdoutRows: split.holdoutRows.length,
    },
    models: {
      acceptability: acceptabilityModel?.artifact ?? null,
      validation: validationModel?.artifact ?? null,
      preference: preferenceModel?.artifact ?? null,
    },
    evaluation: {
      acceptability: acceptabilityEvaluation,
      validation: validationEvaluation,
      preference: preferenceEvaluation,
      top1Acceptability,
    },
  };

  const artifact = await writeMlArtifact('ranker', payload);
  return {
    version: artifact.version,
    ...payload,
  };
}

export async function evaluateMlRanker(
  options: MlTrainRankerOptions = {},
): Promise<MlRankerArtifact['evaluation'] & { version: string; holdoutRepositories: string[] }> {
  const artifact = await trainMlRanker(options);
  const evaluationArtifact = await writeMlArtifact('evaluation', {
    createdAt: artifact.createdAt,
    holdoutRepositories: artifact.holdoutRepositories,
    evaluation: artifact.evaluation,
  });
  return {
    version: evaluationArtifact.version,
    holdoutRepositories: artifact.holdoutRepositories,
    ...artifact.evaluation,
  };
}

export async function compareMlRanker(options: MlTrainRankerOptions = {}): Promise<MlCompareResult> {
  const database = options.database ?? getDb();
  const statements = createStatements(database);
  const artifact = await trainMlRanker({ database, datasets: options.datasets });
  const acceptabilityArtifact = artifact.models.acceptability;
  const validationArtifact = artifact.models.validation;
  const preferenceArtifact = artifact.models.preference;
  if (!acceptabilityArtifact && !validationArtifact && !preferenceArtifact) {
    const empty = {
      version: artifact.version,
      totalScoredCandidates: 0,
      totalCycles: 0,
      disagreements: 0,
      rows: [],
    };
    await writeMlArtifact('comparison', empty, artifact.version);
    return empty;
  }

  const datasets = options.datasets ?? prepareMlDatasets(database);
  const candidateRows = datasets.candidateRanking.filter(
    (row): row is MlCandidateRankingRow & { candidateObservationId: number; cycleObservationId: number } =>
      row.sourceType === 'candidate_observation' &&
      row.candidateObservationId !== null &&
      row.cycleObservationId !== null &&
      row.strategy !== null &&
      SAFE_ML_STRATEGIES.has(row.strategy),
  );

  const scoredRows = scoreRowsWithModels(candidateRows, acceptabilityArtifact, validationArtifact, preferenceArtifact);
  for (const row of scoredRows) {
    statements.upsertCandidateMlScore.run({
      candidate_observation_id: row.candidateObservationId,
      model_version: artifact.version,
      acceptability_score: row.acceptabilityProbability,
      validation_score: row.validationProbability,
      preference_score: row.preferenceProbability,
      combined_score: row.combinedScore,
    });
  }

  const grouped = new Map<number, typeof scoredRows>();
  for (const row of scoredRows) {
    const existing = grouped.get(row.cycleObservationId);
    if (existing) {
      existing.push(row);
    } else {
      grouped.set(row.cycleObservationId, [row]);
    }
  }

  const rankingRows = [...grouped.entries()].map(([cycleObservationId, members]) => {
    const heuristicRow =
      sortCopy(
        members,
        (left, right) =>
          left.plannerRank - right.plannerRank || left.candidateObservationId - right.candidateObservationId,
      )[0] ?? null;
    const modelRow =
      sortCopy(
        members,
        (left, right) => right.combinedScore - left.combinedScore || left.plannerRank - right.plannerRank,
      )[0] ?? null;
    const disagreement = heuristicRow?.candidateObservationId !== modelRow?.candidateObservationId;

    statements.upsertMlCycleRanking.run({
      cycle_observation_id: cycleObservationId,
      model_version: artifact.version,
      heuristic_candidate_observation_id: heuristicRow?.candidateObservationId ?? null,
      model_candidate_observation_id: modelRow?.candidateObservationId ?? null,
      heuristic_strategy: heuristicRow?.strategy ?? null,
      model_strategy: modelRow?.strategy ?? null,
      disagreement: disagreement ? 1 : 0,
    });

    return {
      cycleObservationId,
      heuristicCandidateObservationId: heuristicRow?.candidateObservationId ?? null,
      modelCandidateObservationId: modelRow?.candidateObservationId ?? null,
      heuristicStrategy: heuristicRow?.strategy ?? null,
      modelStrategy: modelRow?.strategy ?? null,
      disagreement,
    };
  });
  const rows = sortCopy(
    rankingRows,
    (left, right) =>
      Number(right.disagreement) - Number(left.disagreement) || left.cycleObservationId - right.cycleObservationId,
  );

  const payload = {
    totalScoredCandidates: scoredRows.length,
    totalCycles: rows.length,
    disagreements: rows.filter((row) => row.disagreement).length,
    rows,
  };
  const comparisonArtifact = await writeMlArtifact('comparison', payload, artifact.version);

  return {
    version: comparisonArtifact.version,
    ...payload,
  };
}

interface TrainedBinaryModel {
  artifact: BinaryModelArtifact;
  model: {
    classifiers?: Array<{ testScores(features: MatrixType): number[] }>;
    toJSON(): unknown;
  };
}

interface ScoredCandidateRow extends MlCandidateRankingRow {
  candidateObservationId: number;
  cycleObservationId: number;
  acceptabilityProbability: number;
  validationProbability: number;
  preferenceProbability: number;
  combinedScore: number;
}

function trainCandidateBinaryModel(
  rows: MlCandidateRankingRow[],
  labelKey: 'candidateAcceptabilityTarget' | 'candidateValidationTarget',
): TrainedBinaryModel | null {
  if (rows.length < 2) {
    return null;
  }

  const positiveCount = rows.filter((row) => row[labelKey] === 1).length;
  const negativeCount = rows.filter((row) => row[labelKey] === 0).length;
  if (positiveCount === 0 || negativeCount === 0) {
    return null;
  }

  const encoded = encodeFeatureRows(rows);
  const features = new Matrix(encoded.matrix);
  const targets = Matrix.columnVector(rows.map((row) => row[labelKey] ?? 0));

  const model = new LogisticRegression({ numSteps: 250 * 10, learningRate: 1 / (100 * 10) }) as {
    train(features: MatrixType, targets: MatrixType): void;
    toJSON(): unknown;
    classifiers?: Array<{ testScores(features: MatrixType): number[] }>;
  };
  model.train(features, targets);

  return {
    artifact: {
      label: labelKey === 'candidateAcceptabilityTarget' ? 'acceptability' : 'validation',
      modelJson: model.toJSON(),
      featureSchema: encoded.schema,
      featureNames: encoded.featureNames,
      positiveLabel: 1,
    },
    model,
  };
}

function trainPreferenceBinaryModel(rows: MlCandidatePreferenceRow[]): TrainedBinaryModel | null {
  if (rows.length < 2) {
    return null;
  }

  const positiveCount = rows.filter((row) => row.preferenceTarget === 1).length;
  const negativeCount = rows.filter((row) => row.preferenceTarget === 0).length;
  if (positiveCount === 0 || negativeCount === 0) {
    return null;
  }

  const encoded = encodeFeatureRows(rows);
  const features = new Matrix(encoded.matrix);
  const targets = Matrix.columnVector(rows.map((row) => row.preferenceTarget));

  const model = new LogisticRegression({ numSteps: 250 * 10, learningRate: 1 / (100 * 10) }) as {
    train(features: MatrixType, targets: MatrixType): void;
    toJSON(): unknown;
    classifiers?: Array<{ testScores(features: MatrixType): number[] }>;
  };
  model.train(features, targets);

  return {
    artifact: {
      label: 'preference',
      modelJson: model.toJSON(),
      featureSchema: encoded.schema,
      featureNames: encoded.featureNames,
      positiveLabel: 1,
    },
    model,
  };
}

function evaluateBinaryModel(
  trainedModel: TrainedBinaryModel | null,
  rows: MlCandidateRankingRow[],
  labelKey: 'candidateAcceptabilityTarget' | 'candidateValidationTarget',
) {
  if (!trainedModel || rows.length === 0) {
    return null;
  }

  const encoded = encodeFeatureRows(rows, trainedModel.artifact.featureSchema);
  const probabilities = getBinaryClassProbabilities(trainedModel.model, new Matrix(encoded.matrix));
  const predictions = probabilities.map((value) => (value >= 0.5 ? 1 : 0));
  const actual = rows.map((row) => row[labelKey] ?? 0);

  return computeBinaryClassificationMetrics(actual, predictions);
}

function compareHeuristicVsModelTop1(
  acceptabilityModel: TrainedBinaryModel | null,
  validationModel: TrainedBinaryModel | null,
  preferenceModel: TrainedBinaryModel | null,
  rows: MlCandidateRankingRow[],
) {
  if (rows.length === 0) {
    return {
      heuristic: 0,
      model: 0,
      cycleCount: 0,
      beatsHeuristic: false,
    };
  }

  const labeledRows = rows.filter((row) => row.candidateAcceptabilityTarget !== null);
  if (labeledRows.length === 0) {
    return {
      heuristic: 0,
      model: 0,
      cycleCount: 0,
      beatsHeuristic: false,
    };
  }
  const rankedRows = scoreRowsWithModels(
    labeledRows.filter(
      (row): row is MlCandidateRankingRow & { candidateObservationId: number; cycleObservationId: number } =>
        row.sourceType === 'candidate_observation' &&
        row.candidateObservationId !== null &&
        row.cycleObservationId !== null,
    ),
    acceptabilityModel?.artifact ?? null,
    validationModel?.artifact ?? null,
    preferenceModel?.artifact ?? null,
  );

  const grouped = new Map<string, typeof rankedRows>();
  for (const row of rankedRows) {
    const existing = grouped.get(row.cycleGroupKey);
    if (existing) {
      existing.push(row);
    } else {
      grouped.set(row.cycleGroupKey, [row]);
    }
  }

  let heuristicHits = 0;
  let modelHits = 0;
  for (const candidates of grouped.values()) {
    const heuristic = sortCopy(candidates, (left, right) => left.plannerRank - right.plannerRank)[0];
    const model = sortCopy(
      candidates,
      (left, right) => right.combinedScore - left.combinedScore || left.plannerRank - right.plannerRank,
    )[0];
    if (heuristic?.candidateAcceptabilityTarget === 1) {
      heuristicHits += 1;
    }
    if (model?.candidateAcceptabilityTarget === 1) {
      modelHits += 1;
    }
  }

  const cycleCount = grouped.size;
  return {
    heuristic: cycleCount > 0 ? heuristicHits / cycleCount : 0,
    model: cycleCount > 0 ? modelHits / cycleCount : 0,
    cycleCount,
    beatsHeuristic: modelHits > heuristicHits,
  };
}

function scoreRowsWithModels(
  rows: Array<MlCandidateRankingRow & { candidateObservationId: number; cycleObservationId: number }>,
  acceptabilityArtifact: BinaryModelArtifact | null,
  validationArtifact: BinaryModelArtifact | null,
  preferenceArtifact: BinaryModelArtifact | null,
): ScoredCandidateRow[] {
  const acceptabilityProbabilities = scorePointwiseRows(rows, acceptabilityArtifact);
  const validationProbabilities = scorePointwiseRows(rows, validationArtifact);
  const preferenceProbabilities = scorePreferenceRows(rows, preferenceArtifact);

  return rows.map((row, index) => {
    const acceptabilityProbability = acceptabilityProbabilities[index] ?? 0.5;
    const validationProbability = validationProbabilities[index] ?? 0.5;
    const preferenceProbability = preferenceProbabilities[index] ?? 0.5;
    const componentCount = [acceptabilityArtifact, validationArtifact, preferenceArtifact].filter(Boolean).length || 1;
    return {
      ...row,
      acceptabilityProbability,
      validationProbability,
      preferenceProbability,
      combinedScore: (acceptabilityProbability + validationProbability + preferenceProbability) / componentCount,
    };
  });
}

function scorePointwiseRows(
  rows: Array<MlCandidateRankingRow & { candidateObservationId: number; cycleObservationId: number }>,
  artifact: BinaryModelArtifact | null,
): number[] {
  if (!artifact) {
    return Array.from({ length: rows.length }, () => 0.5);
  }
  const model = loadModel(artifact);
  const encoded = encodeFeatureRows(rows, artifact.featureSchema);
  return getBinaryClassProbabilities(model, new Matrix(encoded.matrix));
}

function scorePreferenceRows(
  rows: Array<MlCandidateRankingRow & { candidateObservationId: number; cycleObservationId: number }>,
  artifact: BinaryModelArtifact | null,
): number[] {
  if (!artifact) {
    return Array.from({ length: rows.length }, () => 0.5);
  }

  const grouped = new Map<
    number,
    Array<MlCandidateRankingRow & { candidateObservationId: number; cycleObservationId: number }>
  >();
  for (const row of rows) {
    const existing = grouped.get(row.cycleObservationId);
    if (existing) {
      existing.push(row);
      continue;
    }
    grouped.set(row.cycleObservationId, [row]);
  }

  const result = new Map<number, number>();
  const model = loadModel(artifact);
  for (const groupRows of grouped.values()) {
    if (groupRows.length === 1) {
      const single = groupRows[0];
      if (single) {
        result.set(single.candidateObservationId, 0.5);
      }
      continue;
    }

    const pairRows = groupRows.flatMap((left) =>
      groupRows
        .filter((right) => right.candidateObservationId !== left.candidateObservationId)
        .map((right) => ({
          rowId: `preference-inference:${left.rowId}:${right.rowId}`,
          repositorySlug: left.repositorySlug,
          featureColumns: buildPreferenceFeatureColumns(left, right),
        })),
    );
    const encoded = encodeFeatureRows(pairRows, artifact.featureSchema);
    const probabilities = getBinaryClassProbabilities(model, new Matrix(encoded.matrix));

    for (const left of groupRows) {
      const wins = probabilities.filter((_, index) =>
        pairRows[index]?.rowId.startsWith(`preference-inference:${left.rowId}:`),
      );
      const averageWins = wins.length > 0 ? wins.reduce((sum, value) => sum + value, 0) / wins.length : 0.5;
      result.set(left.candidateObservationId, averageWins);
    }
  }

  return rows.map((row) => result.get(row.candidateObservationId) ?? 0.5);
}

function evaluatePreferenceModel(trainedModel: TrainedBinaryModel | null, rows: MlCandidatePreferenceRow[]) {
  if (!trainedModel || rows.length === 0) {
    return null;
  }
  const encoded = encodeFeatureRows(rows, trainedModel.artifact.featureSchema);
  const probabilities = getBinaryClassProbabilities(trainedModel.model, new Matrix(encoded.matrix));
  const predictions = probabilities.map((value) => (value >= 0.5 ? 1 : 0));
  const actual = rows.map((row) => row.preferenceTarget);
  return computeBinaryClassificationMetrics(actual, predictions);
}

function loadModel(artifact: BinaryModelArtifact) {
  return LogisticRegression.load(artifact.modelJson as object) as {
    classifiers?: Array<{ testScores(features: MatrixType): number[] }>;
  };
}
