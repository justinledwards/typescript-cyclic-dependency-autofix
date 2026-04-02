import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import type { Database as DatabaseType } from 'better-sqlite3';
import { Matrix } from 'ml-matrix';
import type { TrainingDataExport, TrainingDataRow } from '../../db/trainingData.js';
import { getTrainingDataExport } from '../../db/trainingData.js';

const require = createRequire(import.meta.url);

export const LogisticRegression = require('ml-logistic-regression');

export const ML_DATASET_SCHEMA_VERSION = 1;
export const DEFAULT_ML_EXPORT_DIR = path.join(process.cwd(), 'exports', 'ml');
export const DEFAULT_ML_ARTIFACT_DIR = path.join(process.cwd(), 'artifacts', 'ml');
export const SAFE_ML_STRATEGIES = new Set(['import_type', 'direct_import', 'extract_shared', 'host_state_update']);

const TEXT_EXCLUSION_PATTERN =
  /(summary|reason|note|notes|body|title|text|url|file|path|sha|slug|normalized|commit|repository)/i;

export interface MlFeatureColumns {
  numeric: Record<string, number>;
  categorical: Record<string, string>;
  multiLabel: Record<string, string[]>;
}

export interface MlCyclePatternRow {
  datasetType: 'cycle_patterns';
  rowId: string;
  sourceType: 'cycle_observation';
  repositorySlug: string;
  commitSha: string | null;
  cycleId: number;
  observationId: number;
  normalizedPath: string;
  cycleShape: string | null;
  cycleSize: number;
  selectedStrategy: string | null;
  selectedClassification: string | null;
  cyclePatternTarget: string;
  supportTarget: number;
  candidateCount: number;
  acceptedCandidateCount: number;
  rejectedCandidateCount: number;
  supportedCandidateCount: number;
  featureColumns: MlFeatureColumns;
}

export interface MlCandidateRankingRow {
  datasetType: 'candidate_ranking';
  rowId: string;
  sourceType: 'candidate_observation' | 'acceptance_benchmark';
  repositorySlug: string;
  commitSha: string | null;
  cycleGroupKey: string;
  cycleId: number | null;
  cycleObservationId: number | null;
  candidateObservationId: number | null;
  acceptanceBenchmarkId: number | null;
  normalizedPath: string;
  strategy: string | null;
  classification: string;
  plannerRank: number;
  heuristicSelected: boolean;
  promotionEligible: boolean;
  candidateAcceptabilityTarget: BinaryLabel | null;
  candidateValidationTarget: BinaryLabel | null;
  cyclePatternTarget: string;
  featureColumns: MlFeatureColumns;
}

export interface PreparedMlDatasets {
  summary: {
    cyclePatterns: number;
    candidateRanking: number;
  };
  cyclePatterns: MlCyclePatternRow[];
  candidateRanking: MlCandidateRankingRow[];
}

export interface MlDatasetManifest {
  schemaVersion: number;
  createdAt: string;
  summary: PreparedMlDatasets['summary'];
  outputs: {
    cyclePatterns: Record<'jsonl' | 'parquet', string>;
    candidateRanking: Record<'jsonl' | 'parquet', string>;
  };
}

export interface MlPrepareResult {
  manifestPath: string;
  manifest: MlDatasetManifest;
}

export interface EncodableMlRow {
  rowId: string;
  repositorySlug: string;
  featureColumns: MlFeatureColumns;
}

export interface FeatureSchema {
  schemaVersion: number;
  numericKeys: string[];
  categoricalValues: Record<string, string[]>;
  multiLabelValues: Record<string, string[]>;
  numericStats: Record<string, { mean: number; stdDev: number }>;
}

export interface EncodedMatrixResult<T extends EncodableMlRow> {
  schema: FeatureSchema;
  matrix: number[][];
  rows: T[];
  featureNames: string[];
}

export interface RepositoryHoldoutSplit<T extends { repositorySlug: string }> {
  trainRows: T[];
  holdoutRows: T[];
  holdoutRepositories: string[];
}

export interface BinaryClassificationMetrics {
  accuracy: number;
  precision: number;
  recall: number;
  positiveRate: number;
  negativeRate: number;
  totalRows: number;
}

type BinaryLabel = 0 | 1;

export function prepareMlDatasets(database?: DatabaseType): PreparedMlDatasets {
  const exportData = getTrainingDataExport(database);
  return prepareMlDatasetsFromExport(exportData);
}

export function prepareMlDatasetsFromExport(exportData: TrainingDataExport): PreparedMlDatasets {
  const benchmarkStats = buildBenchmarkStats(exportData.rows);
  const candidateRows = exportData.rows.filter(
    (row): row is Extract<TrainingDataRow, { rowType: 'candidate_observation' }> =>
      row.rowType === 'candidate_observation',
  );
  const candidateGroups = new Map<number, Extract<TrainingDataRow, { rowType: 'candidate_observation' }>[]>();

  for (const row of candidateRows) {
    const rows = candidateGroups.get(row.observationId);
    if (rows) {
      rows.push(row);
      continue;
    }
    candidateGroups.set(row.observationId, [row]);
  }

  const cyclePatterns: MlCyclePatternRow[] = exportData.rows
    .filter(
      (row): row is Extract<TrainingDataRow, { rowType: 'cycle_observation' }> => row.rowType === 'cycle_observation',
    )
    .map((row) => {
      const groupedCandidates = candidateGroups.get(row.observationId) ?? [];
      const patternCategories = getPatternCategories(row.featureVector, row.graphSummary);
      const featureColumns = buildFeatureColumns();
      addFeatureRecord(featureColumns, '', row.featureVector);
      addFeatureRecord(featureColumns, 'cycle_signals', row.cycleSignals);
      addFeatureRecord(featureColumns, 'repo_profile', row.repoProfile);
      addFeatureRecord(featureColumns, 'planner', {
        selectedStrategy: row.planner.selectedStrategy,
        selectedClassification: row.planner.selectedClassification,
        selectedScore: row.planner.selectedScore,
        fallbackClassification: row.planner.fallbackClassification,
        fallbackConfidence: row.planner.fallbackConfidence,
      });
      addMultiLabelFeature(featureColumns, 'patternCategories', patternCategories);
      addBenchmarkFeatures(
        featureColumns,
        benchmarkStats,
        row.repository.slug,
        patternCategories,
        row.planner.selectedStrategy,
      );

      const acceptedCandidateCount = groupedCandidates.filter(
        (candidate) => candidate.review.status === 'approved',
      ).length;
      const rejectedCandidateCount = groupedCandidates.filter(
        (candidate) => candidate.review.status === 'rejected',
      ).length;
      const supportedCandidateCount = groupedCandidates.filter((candidate) =>
        (candidate.candidate.classification ?? '').startsWith('autofix_'),
      ).length;

      return {
        datasetType: 'cycle_patterns',
        rowId: row.rowId,
        sourceType: 'cycle_observation',
        repositorySlug: row.repository.slug,
        commitSha: row.commitSha,
        cycleId: row.cycleId,
        observationId: row.observationId,
        normalizedPath: row.normalizedPath,
        cycleShape: row.cycleShape,
        cycleSize: row.cycleSize,
        selectedStrategy: row.planner.selectedStrategy,
        selectedClassification: row.planner.selectedClassification,
        cyclePatternTarget: deriveCyclePatternTarget(
          patternCategories,
          row.planner.selectedStrategy,
          row.planner.selectedClassification,
        ),
        supportTarget: row.planner.selectedClassification?.startsWith('autofix_') ? 1 : 0,
        candidateCount: groupedCandidates.length,
        acceptedCandidateCount,
        rejectedCandidateCount,
        supportedCandidateCount,
        featureColumns,
      };
    });

  const candidateRanking: MlCandidateRankingRow[] = [];
  for (const row of exportData.rows) {
    if (row.rowType === 'candidate_observation') {
      candidateRanking.push(mapCandidateObservationMlRow(row, benchmarkStats));
      continue;
    }
    if (row.rowType === 'acceptance_benchmark') {
      candidateRanking.push(mapAcceptanceBenchmarkMlRow(row, benchmarkStats));
    }
  }

  return {
    summary: {
      cyclePatterns: cyclePatterns.length,
      candidateRanking: candidateRanking.length,
    },
    cyclePatterns,
    candidateRanking,
  };
}

export async function writePreparedMlDatasets(
  datasets: PreparedMlDatasets,
  outputDir = DEFAULT_ML_EXPORT_DIR,
): Promise<MlPrepareResult> {
  await fs.mkdir(outputDir, { recursive: true });

  const cyclePatternsJsonl = path.join(outputDir, 'cycle-patterns.jsonl');
  const cyclePatternsParquet = path.join(outputDir, 'cycle-patterns.parquet');
  const candidateRankingJsonl = path.join(outputDir, 'candidate-ranking.jsonl');
  const candidateRankingParquet = path.join(outputDir, 'candidate-ranking.parquet');
  const manifestPath = path.join(outputDir, 'manifest.json');

  await fs.writeFile(cyclePatternsJsonl, serializeJsonl(datasets.cyclePatterns), 'utf8');
  await fs.writeFile(candidateRankingJsonl, serializeJsonl(datasets.candidateRanking), 'utf8');
  await writeParquet(cyclePatternsParquet, datasets.cyclePatterns);
  await writeParquet(candidateRankingParquet, datasets.candidateRanking);

  const manifest: MlDatasetManifest = {
    schemaVersion: ML_DATASET_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    summary: datasets.summary,
    outputs: {
      cyclePatterns: {
        jsonl: cyclePatternsJsonl,
        parquet: cyclePatternsParquet,
      },
      candidateRanking: {
        jsonl: candidateRankingJsonl,
        parquet: candidateRankingParquet,
      },
    },
  };

  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  return {
    manifestPath,
    manifest,
  };
}

// eslint-disable-next-line sonarjs/cognitive-complexity
export function buildFeatureSchema<T extends EncodableMlRow>(rows: T[]): FeatureSchema {
  const numericKeys = new Set<string>();
  const categoricalValues = new Map<string, Set<string>>();
  const multiLabelValues = new Map<string, Set<string>>();
  const numericSamples = new Map<string, number[]>();

  for (const row of rows) {
    for (const [key, value] of Object.entries(row.featureColumns.numeric)) {
      if (!Number.isFinite(value)) {
        continue;
      }
      numericKeys.add(key);
      const samples = numericSamples.get(key);
      if (samples) {
        samples.push(value);
      } else {
        numericSamples.set(key, [value]);
      }
    }

    for (const [key, value] of Object.entries(row.featureColumns.categorical)) {
      const values = categoricalValues.get(key) ?? new Set<string>();
      values.add(value);
      categoricalValues.set(key, values);
    }

    for (const [key, values] of Object.entries(row.featureColumns.multiLabel)) {
      const knownValues = multiLabelValues.get(key) ?? new Set<string>();
      for (const value of values) {
        knownValues.add(value);
      }
      multiLabelValues.set(key, knownValues);
    }
  }

  const sortedNumericKeys = sortCopy([...numericKeys], compareStrings);
  const sortedCategoricalValues = Object.fromEntries(
    sortCopy([...categoricalValues.entries()], ([left], [right]) => compareStrings(left, right)).map(
      ([key, values]) => [key, sortCopy([...values], compareStrings)],
    ),
  );
  const sortedMultiLabelValues = Object.fromEntries(
    sortCopy([...multiLabelValues.entries()], ([left], [right]) => compareStrings(left, right)).map(([key, values]) => [
      key,
      sortCopy([...values], compareStrings),
    ]),
  );

  const numericStats = Object.fromEntries(
    sortedNumericKeys.map((key) => {
      const values = numericSamples.get(key) ?? [0];
      const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
      const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(values.length, 1);
      return [
        key,
        {
          mean,
          stdDev: Math.sqrt(variance) || 1,
        },
      ];
    }),
  );

  return {
    schemaVersion: ML_DATASET_SCHEMA_VERSION,
    numericKeys: sortedNumericKeys,
    categoricalValues: sortedCategoricalValues,
    multiLabelValues: sortedMultiLabelValues,
    numericStats,
  };
}

export function encodeFeatureRows<T extends EncodableMlRow>(
  rows: T[],
  schema = buildFeatureSchema(rows),
): EncodedMatrixResult<T> {
  const featureNames: string[] = [];
  const matrix = rows.map((row) => {
    const vector: number[] = [];

    for (const key of schema.numericKeys) {
      const value = row.featureColumns.numeric[key] ?? 0;
      const stats = schema.numericStats[key];
      featureNames.push(`num:${key}`);
      vector.push((value - stats.mean) / stats.stdDev);
    }

    for (const [key, values] of Object.entries(schema.categoricalValues)) {
      const selected = row.featureColumns.categorical[key] ?? '__unknown__';
      for (const value of values) {
        featureNames.push(`cat:${key}:${value}`);
        vector.push(selected === value ? 1 : 0);
      }
    }

    for (const [key, values] of Object.entries(schema.multiLabelValues)) {
      const selectedValues = new Set(row.featureColumns.multiLabel[key]);
      for (const value of values) {
        featureNames.push(`multi:${key}:${value}`);
        vector.push(selectedValues.has(value) ? 1 : 0);
      }
    }

    return vector;
  });

  return {
    schema,
    matrix,
    rows,
    featureNames,
  };
}

export function splitRowsByRepositoryHoldout<T extends { repositorySlug: string }>(
  rows: T[],
  holdoutFraction = 0.2,
): RepositoryHoldoutSplit<T> {
  const repositories = sortCopy([...new Set(rows.map((row) => row.repositorySlug))], compareStrings);
  if (repositories.length <= 1) {
    return {
      trainRows: rows,
      holdoutRows: rows,
      holdoutRepositories: repositories,
    };
  }

  const holdoutCount = Math.max(1, Math.floor(repositories.length * holdoutFraction));
  const holdoutRepositories = repositories.slice(-holdoutCount);
  const holdoutSet = new Set(holdoutRepositories);

  return {
    trainRows: rows.filter((row) => !holdoutSet.has(row.repositorySlug)),
    holdoutRows: rows.filter((row) => holdoutSet.has(row.repositorySlug)),
    holdoutRepositories,
  };
}

export function splitCandidateRowsByLabeledRepositoryHoldout(
  rows: MlCandidateRankingRow[],
  holdoutFraction = 0.2,
): RepositoryHoldoutSplit<MlCandidateRankingRow> {
  const labeledRepositories = sortCopy(
    [
      ...new Set(
        rows
          .filter((row) => row.candidateAcceptabilityTarget !== null || row.candidateValidationTarget !== null)
          .map((row) => row.repositorySlug),
      ),
    ],
    compareStrings,
  );

  const repositories =
    labeledRepositories.length > 1
      ? labeledRepositories
      : sortCopy([...new Set(rows.map((row) => row.repositorySlug))], compareStrings);

  if (repositories.length <= 1) {
    return {
      trainRows: rows,
      holdoutRows: rows.filter((row) => repositories.includes(row.repositorySlug)),
      holdoutRepositories: repositories,
    };
  }

  const holdoutCount = Math.max(1, Math.floor(repositories.length * holdoutFraction));
  const holdoutRepositories = repositories.slice(-holdoutCount);
  const holdoutSet = new Set(holdoutRepositories);

  return {
    trainRows: rows.filter((row) => !holdoutSet.has(row.repositorySlug)),
    holdoutRows: rows.filter((row) => holdoutSet.has(row.repositorySlug)),
    holdoutRepositories,
  };
}

// eslint-disable-next-line sonarjs/cognitive-complexity
export function computeBinaryClassificationMetrics(
  actualLabels: number[],
  predictedLabels: number[],
): BinaryClassificationMetrics {
  let correct = 0;
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let positiveCount = 0;
  let negativeCount = 0;

  for (const [index, actualLabel] of actualLabels.entries()) {
    const actual = actualLabel ?? 0;
    const predicted = predictedLabels[index] ?? 0;
    if (actual === predicted) {
      correct += 1;
    }
    if (actual === 1) {
      positiveCount += 1;
    } else {
      negativeCount += 1;
    }
    if (actual === 1 && predicted === 1) {
      truePositive += 1;
    }
    if (actual === 0 && predicted === 1) {
      falsePositive += 1;
    }
    if (actual === 1 && predicted === 0) {
      falseNegative += 1;
    }
  }

  return {
    accuracy: actualLabels.length > 0 ? correct / actualLabels.length : 0,
    precision: truePositive + falsePositive > 0 ? truePositive / (truePositive + falsePositive) : 0,
    recall: truePositive + falseNegative > 0 ? truePositive / (truePositive + falseNegative) : 0,
    positiveRate: actualLabels.length > 0 ? positiveCount / actualLabels.length : 0,
    negativeRate: actualLabels.length > 0 ? negativeCount / actualLabels.length : 0,
    totalRows: actualLabels.length,
  };
}

export function toMatrix(encoded: EncodedMatrixResult<EncodableMlRow>): Matrix {
  return new Matrix(encoded.matrix);
}

export function getBinaryClassProbabilities(
  model: { classifiers?: Array<{ testScores(features: Matrix): number[] }> },
  features: Matrix,
): number[] {
  const classifier = model.classifiers?.[0];
  if (!classifier) {
    return Array.from({ length: features.rows }, () => 0.5);
  }
  return classifier.testScores(features).map((score) => clamp(score, 0, 1));
}

function mapCandidateObservationMlRow(
  row: Extract<TrainingDataRow, { rowType: 'candidate_observation' }>,
  benchmarkStats: BenchmarkStats,
): MlCandidateRankingRow {
  const patternCategories = getPatternCategories(row.featureVector, row.graphSummary);
  const featureColumns = buildFeatureColumns();
  addFeatureRecord(featureColumns, '', row.featureVector);
  addFeatureRecord(featureColumns, 'cycle_signals', row.cycleSignals);
  addFeatureRecord(featureColumns, 'repo_profile', row.repoProfile);
  addFeatureRecord(featureColumns, 'candidate', {
    strategy: row.candidate.strategy,
    status: row.candidate.status,
    plannerRank: row.candidate.plannerRank,
    promotionEligible: row.candidate.promotionEligible,
    confidence: row.candidate.confidence,
    upstreamabilityScore: row.candidate.upstreamabilityScore,
    classification: row.candidate.classification,
  });
  addFeatureRecord(featureColumns, 'candidate_signal', row.candidate.signals);
  addFeatureRecord(featureColumns, 'candidate_plan', row.candidate.plan);
  addFeatureRecord(featureColumns, 'validation', {
    status: row.validation.status,
    failureCategory: row.validation.failureCategory,
  });
  addFeatureRecord(featureColumns, 'review', {
    status: row.review.status,
  });
  addFeatureRecord(featureColumns, 'patch', {
    touchedFilesCount: row.patch.touchedFiles.length,
    introducesPatch: row.patch.patchText ? 1 : 0,
  });
  addMultiLabelFeature(featureColumns, 'patternCategories', patternCategories);
  addBenchmarkFeatures(featureColumns, benchmarkStats, row.repository.slug, patternCategories, row.candidate.strategy);

  return {
    datasetType: 'candidate_ranking',
    rowId: row.rowId,
    sourceType: 'candidate_observation',
    repositorySlug: row.repository.slug,
    commitSha: row.commitSha,
    cycleGroupKey: `${row.repository.slug}:${row.commitSha ?? 'unknown'}:${row.normalizedPath}`,
    cycleId: row.cycleId,
    cycleObservationId: row.observationId,
    candidateObservationId: row.candidateObservationId,
    acceptanceBenchmarkId: null,
    normalizedPath: row.normalizedPath,
    strategy: row.candidate.strategy,
    classification:
      row.candidate.classification ??
      row.planner.selectedClassification ??
      row.planner.fallbackClassification ??
      'unsupported',
    plannerRank: row.candidate.plannerRank,
    heuristicSelected: row.candidate.plannerRank === 1,
    promotionEligible: row.candidate.promotionEligible,
    candidateAcceptabilityTarget: deriveReviewAcceptabilityTarget(row.review.status, row.validation.status),
    candidateValidationTarget: deriveValidationTarget(row.validation.status),
    cyclePatternTarget: deriveCyclePatternTarget(
      patternCategories,
      row.candidate.strategy,
      row.candidate.classification,
    ),
    featureColumns,
  };
}

function mapAcceptanceBenchmarkMlRow(
  row: Extract<TrainingDataRow, { rowType: 'acceptance_benchmark' }>,
  benchmarkStats: BenchmarkStats,
): MlCandidateRankingRow {
  const patternCategories = getPatternCategories(row.featureVector, {});
  const featureColumns = buildFeatureColumns();
  addFeatureRecord(featureColumns, '', row.featureVector);
  addFeatureRecord(featureColumns, 'candidate', {
    classification: row.classification,
    confidence: row.confidence,
    upstreamabilityScore: row.upstreamabilityScore,
  });
  addFeatureRecord(featureColumns, 'validation', {
    status: row.validation.status,
  });
  addFeatureRecord(featureColumns, 'review', {
    status: row.reviewStatus,
  });
  addFeatureRecord(featureColumns, 'patch', {
    touchedFilesCount: row.touchedFiles.length,
    introducesPatch: row.touchedFiles.length > 0 ? 1 : 0,
  });
  addMultiLabelFeature(featureColumns, 'patternCategories', patternCategories);
  addBenchmarkFeatures(
    featureColumns,
    benchmarkStats,
    row.repository.slug,
    patternCategories,
    classificationToStrategy(row.classification),
  );

  return {
    datasetType: 'candidate_ranking',
    rowId: row.rowId,
    sourceType: 'acceptance_benchmark',
    repositorySlug: row.repository.slug,
    commitSha: row.commitSha,
    cycleGroupKey: `${row.repository.slug}:${row.commitSha}:${row.normalizedPath}`,
    cycleId: row.cycleId,
    cycleObservationId: null,
    candidateObservationId: null,
    acceptanceBenchmarkId: Number(row.rowId.split(':').at(-1) ?? 0),
    normalizedPath: row.normalizedPath,
    strategy: classificationToStrategy(row.classification),
    classification: row.classification,
    plannerRank: 1,
    heuristicSelected: true,
    promotionEligible: row.acceptability.decision === 'accepted',
    candidateAcceptabilityTarget: deriveAcceptanceBenchmarkTarget(row.acceptability.decision, row.validation.status),
    candidateValidationTarget: deriveValidationTarget(row.validation.status),
    cyclePatternTarget: deriveCyclePatternTarget(
      patternCategories,
      classificationToStrategy(row.classification),
      row.classification,
    ),
    featureColumns,
  };
}

interface BenchmarkStats {
  repositoryCaseCount: Map<string, number>;
  repositoryLabelCounts: Map<string, Map<string, number>>;
}

function buildBenchmarkStats(rows: TrainingDataRow[]): BenchmarkStats {
  const repositoryCaseCount = new Map<string, number>();
  const repositoryLabelCounts = new Map<string, Map<string, number>>();

  for (const row of rows) {
    if (row.rowType !== 'benchmark_case') {
      continue;
    }

    repositoryCaseCount.set(row.repository, (repositoryCaseCount.get(row.repository) ?? 0) + 1);
    const labelCounts = repositoryLabelCounts.get(row.repository) ?? new Map<string, number>();
    for (const label of row.strategyLabels) {
      labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }
    repositoryLabelCounts.set(row.repository, labelCounts);
  }

  return {
    repositoryCaseCount,
    repositoryLabelCounts,
  };
}

function addBenchmarkFeatures(
  columns: MlFeatureColumns,
  stats: BenchmarkStats,
  repositorySlug: string,
  patternCategories: string[],
  strategy: string | null,
): void {
  addNumericFeature(columns, 'historical_repositoryBenchmarkCount', stats.repositoryCaseCount.get(repositorySlug) ?? 0);
  if (strategy) {
    addNumericFeature(
      columns,
      'historical_repositoryStrategyLabelCount',
      stats.repositoryLabelCounts.get(repositorySlug)?.get(strategy) ?? 0,
    );
  }
  addNumericFeature(
    columns,
    'historical_repositoryPatternLabelCount',
    patternCategories.reduce(
      (sum, category) => sum + (stats.repositoryLabelCounts.get(repositorySlug)?.get(category) ?? 0),
      0,
    ),
  );
}

export function buildFeatureColumns(): MlFeatureColumns {
  return {
    numeric: {},
    categorical: {},
    multiLabel: {},
  };
}

// eslint-disable-next-line sonarjs/cognitive-complexity
function addFeatureRecord(
  columns: MlFeatureColumns,
  prefix: string,
  record: Record<string, unknown> | null | undefined,
): void {
  if (!record) {
    return;
  }

  for (const [key, value] of Object.entries(record)) {
    const featureKey = prefix ? `${prefix}_${key}` : key;
    if (value === null || value === undefined) {
      continue;
    }

    if (typeof value === 'number') {
      addNumericFeature(columns, featureKey, value);
      continue;
    }

    if (typeof value === 'boolean') {
      addNumericFeature(columns, featureKey, value ? 1 : 0);
      continue;
    }

    if (typeof value === 'string') {
      if (TEXT_EXCLUSION_PATTERN.test(featureKey)) {
        continue;
      }
      addCategoricalFeature(columns, featureKey, value);
      continue;
    }

    if (Array.isArray(value)) {
      const stringValues = value.filter((item): item is string => typeof item === 'string');
      if (stringValues.length === value.length && stringValues.length > 0) {
        addMultiLabelFeature(columns, featureKey, stringValues);
      }
      continue;
    }

    if (isPlainObject(value)) {
      addFeatureRecord(columns, featureKey, value);
    }
  }
}

function addNumericFeature(columns: MlFeatureColumns, key: string, value: number): void {
  if (!Number.isFinite(value)) {
    return;
  }
  columns.numeric[key] = value;
}

function addCategoricalFeature(columns: MlFeatureColumns, key: string, value: string): void {
  columns.categorical[key] = normalizeFeatureValue(value);
}

function addMultiLabelFeature(columns: MlFeatureColumns, key: string, values: string[]): void {
  const normalized = values.map((value) => normalizeFeatureValue(value)).filter((value) => value.length > 0);
  if (normalized.length === 0) {
    return;
  }
  columns.multiLabel[key] = sortCopy([...new Set(normalized)], compareStrings);
}

function normalizeFeatureValue(value: string): string {
  return value.trim().replaceAll(/\s+/g, '_').slice(0, 120) || '__empty__';
}

function deriveCyclePatternTarget(
  patternCategories: string[],
  strategy: string | null | undefined,
  classification: string | null | undefined,
): string {
  if (patternCategories.length > 0) {
    return patternCategories[0] ?? 'unknown';
  }
  if (strategy) {
    return strategy;
  }
  if (classification) {
    return classification;
  }
  return 'unknown';
}

function getPatternCategories(
  featureVector: Record<string, unknown> | null | undefined,
  graphSummary: Record<string, unknown> | null | undefined,
): string[] {
  const featurePatterns = asStringArray(featureVector?.patternCategories);
  if (featurePatterns.length > 0) {
    return featurePatterns;
  }
  return asStringArray(graphSummary?.patternCategories);
}

function deriveReviewAcceptabilityTarget(
  reviewStatus: string | null | undefined,
  validationStatus: string | null | undefined,
): BinaryLabel | null {
  if (reviewStatus === 'approved' || reviewStatus === 'pr_candidate') {
    return 1;
  }
  if (reviewStatus === 'rejected' || validationStatus === 'failed') {
    return 0;
  }
  return null;
}

function deriveAcceptanceBenchmarkTarget(
  acceptability: string | null | undefined,
  validationStatus: string | null | undefined,
): BinaryLabel | null {
  if (acceptability === 'accepted') {
    return 1;
  }
  if (acceptability === 'rejected' || validationStatus === 'failed') {
    return 0;
  }
  return null;
}

function deriveValidationTarget(validationStatus: string | null | undefined): BinaryLabel | null {
  if (validationStatus === 'passed') {
    return 1;
  }
  if (validationStatus === 'failed') {
    return 0;
  }
  return null;
}

function classificationToStrategy(classification: string | null | undefined): string | null {
  switch (classification) {
    case 'autofix_import_type': {
      return 'import_type';
    }
    case 'autofix_direct_import': {
      return 'direct_import';
    }
    case 'autofix_extract_shared': {
      return 'extract_shared';
    }
    case 'autofix_host_state_update': {
      return 'host_state_update';
    }
    default: {
      return null;
    }
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function serializeJsonl(rows: unknown[]): string {
  if (rows.length === 0) {
    return '';
  }
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

export async function writeParquet(outputPath: string, rows: unknown[]): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autofix-ml-'));
  const jsonlPath = path.join(tempDir, 'dataset.jsonl');
  try {
    await fs.writeFile(jsonlPath, serializeJsonl(rows), 'utf8');

    const instance = await DuckDBInstance.create(':memory:');
    try {
      const connection = await instance.connect();
      try {
        await connection.run('LOAD json');
        await connection.run('LOAD parquet');
        await connection.run(`
          CREATE TABLE ml_dataset AS
          SELECT *
          FROM read_json_auto('${escapeSqlString(normalizeForDuckDb(jsonlPath))}', format = 'newline_delimited')
        `);
        await connection.run(`
          COPY ml_dataset
          TO '${escapeSqlString(normalizeForDuckDb(outputPath))}'
          (FORMAT parquet, COMPRESSION zstd)
        `);
      } finally {
        connection.closeSync();
      }
    } finally {
      instance.closeSync();
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function normalizeForDuckDb(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function escapeSqlString(value: string): string {
  return value.replaceAll("'", "''");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

export function sortCopy<T>(values: readonly T[], compareFn: (left: T, right: T) => number): T[] {
  // eslint-disable-next-line unicorn/no-array-sort
  return [...values].sort(compareFn);
}
