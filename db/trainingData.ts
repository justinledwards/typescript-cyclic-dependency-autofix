import type { Database as DatabaseType } from 'better-sqlite3';
import type { AcceptanceBenchmarkCaseDTO, BenchmarkCaseDTO } from './index.js';
import { getDb } from './index.js';

interface CycleObservationExportRow {
  id: number;
  cycle_id: number;
  scan_id: number;
  repository_id: number;
  observation_version: number;
  normalized_path: string;
  cycle_shape: string | null;
  cycle_size: number;
  cycle_signals: string | null;
  feature_vector: string | null;
  graph_summary: string | null;
  repo_profile: string | null;
  planner_summary: string | null;
  planner_attempts: string;
  selected_strategy: string | null;
  selected_classification: string | null;
  selected_score: number | null;
  fallback_classification: string | null;
  fallback_confidence: number | null;
  fallback_reasons: string | null;
  owner: string;
  name: string;
  commit_sha: string | null;
}

interface CandidateObservationExportRow {
  id: number;
  cycle_observation_id: number;
  observation_version: number;
  fix_candidate_id: number | null;
  patch_id: number | null;
  strategy: string | null;
  status: string;
  planner_rank: number;
  promotion_eligible: number;
  summary: string | null;
  classification: string | null;
  confidence: number | null;
  upstreamability_score: number | null;
  reasons: string | null;
  score_breakdown: string | null;
  signals: string | null;
  plan: string | null;
  validation_status: string | null;
  validation_summary: string | null;
  validation_failure_category: string | null;
  review_status: string | null;
  review_notes: string | null;
  touched_files: string | null;
  patch_text: string | null;
  cycle_id: number;
  scan_id: number;
  repository_id: number;
  normalized_path: string;
  cycle_shape: string | null;
  cycle_size: number;
  cycle_signals: string | null;
  feature_vector: string | null;
  graph_summary: string | null;
  repo_profile: string | null;
  planner_summary: string | null;
  selected_strategy: string | null;
  selected_classification: string | null;
  fallback_classification: string | null;
  owner: string;
  name: string;
  commit_sha: string | null;
}

export interface TrainingDataExport {
  summary: {
    totalRows: number;
    cycleObservationRows: number;
    candidateObservationRows: number;
    acceptanceBenchmarkRows: number;
    benchmarkCaseRows: number;
  };
  rows: TrainingDataRow[];
}

export type TrainingDataRow =
  | CycleObservationTrainingRow
  | CandidateObservationTrainingRow
  | AcceptanceBenchmarkTrainingRow
  | BenchmarkCaseTrainingRow;

export interface CycleObservationTrainingRow {
  rowType: 'cycle_observation';
  rowId: string;
  repository: {
    id: number;
    slug: string;
  };
  scanId: number;
  commitSha: string | null;
  cycleId: number;
  observationId: number;
  observationVersion: number;
  normalizedPath: string;
  cycleShape: string | null;
  cycleSize: number;
  cycleSignals: Record<string, unknown>;
  featureVector: Record<string, unknown>;
  graphSummary: Record<string, unknown>;
  repoProfile: Record<string, unknown>;
  planner: {
    summary: string | null;
    attempts: unknown[];
    selectedStrategy: string | null;
    selectedClassification: string | null;
    selectedScore: number | null;
    fallbackClassification: string | null;
    fallbackConfidence: number | null;
    fallbackReasons: string[];
  };
}

export interface CandidateObservationTrainingRow {
  rowType: 'candidate_observation';
  rowId: string;
  repository: {
    id: number;
    slug: string;
  };
  scanId: number;
  commitSha: string | null;
  cycleId: number;
  observationId: number;
  observationVersion: number;
  candidateObservationId: number;
  fixCandidateId: number | null;
  patchId: number | null;
  normalizedPath: string;
  cycleShape: string | null;
  cycleSize: number;
  cycleSignals: Record<string, unknown>;
  featureVector: Record<string, unknown>;
  graphSummary: Record<string, unknown>;
  repoProfile: Record<string, unknown>;
  planner: {
    summary: string | null;
    selectedStrategy: string | null;
    selectedClassification: string | null;
    fallbackClassification: string | null;
  };
  candidate: {
    strategy: string | null;
    status: string;
    plannerRank: number;
    promotionEligible: boolean;
    summary: string | null;
    classification: string | null;
    confidence: number | null;
    upstreamabilityScore: number | null;
    reasons: string[];
    scoreBreakdown: string[];
    signals: Record<string, unknown>;
    plan: Record<string, unknown> | null;
  };
  validation: {
    status: string | null;
    summary: string | null;
    failureCategory: string | null;
  };
  review: {
    status: string | null;
    notes: string | null;
  };
  patch: {
    touchedFiles: string[];
    patchText: string | null;
  };
}

export interface AcceptanceBenchmarkTrainingRow {
  rowType: 'acceptance_benchmark';
  rowId: string;
  repository: {
    slug: string;
    localPath: string | null;
  };
  commitSha: string;
  scanId: number | null;
  cycleId: number | null;
  fixCandidateId: number | null;
  patchId: number | null;
  normalizedPath: string;
  classification: string;
  confidence: number;
  upstreamabilityScore: number | null;
  validation: {
    status: string | null;
    summary: string | null;
  };
  reviewStatus: string | null;
  touchedFiles: string[];
  featureVector: Record<string, unknown>;
  plannerSummary: string | null;
  plannerAttempts: unknown[];
  acceptability: {
    decision: string | null;
    rejectionReason: string | null;
    note: string | null;
  };
}

export interface BenchmarkCaseTrainingRow {
  rowType: 'benchmark_case';
  rowId: string;
  repository: string;
  source: string;
  commitSha: string;
  title: string;
  body: string | null;
  url: string | null;
  prNumber: number | null;
  issueNumber: number | null;
  strategyLabels: string[];
  validationSignals: Record<string, unknown>;
  diffFeatures: Record<string, unknown>;
  matchedTerms: string[];
  notes: string | null;
}

export function getTrainingDataExport(database: DatabaseType = getDb()): TrainingDataExport {
  const cycleObservationRows = loadLatestCycleObservationRows(database);
  const candidateObservationRows = loadLatestCandidateObservationRows(database);
  const acceptanceRows = loadAcceptanceBenchmarkRows(database);
  const benchmarkRows = loadBenchmarkCaseRows(database).filter((row) => isTrainingEligibleBenchmarkCase(row));

  const rows: TrainingDataRow[] = [
    ...cycleObservationRows.map((row) => mapCycleObservationRow(row)),
    ...candidateObservationRows.map((row) => mapCandidateObservationRow(row)),
    ...acceptanceRows.map((row) => mapAcceptanceBenchmarkRow(row)),
    ...benchmarkRows.map((row) => mapBenchmarkCaseRow(row)),
  ];

  return {
    summary: {
      totalRows: rows.length,
      cycleObservationRows: cycleObservationRows.length,
      candidateObservationRows: candidateObservationRows.length,
      acceptanceBenchmarkRows: acceptanceRows.length,
      benchmarkCaseRows: benchmarkRows.length,
    },
    rows,
  };
}

function loadLatestCycleObservationRows(database: DatabaseType): CycleObservationExportRow[] {
  return database
    .prepare(
      `
        WITH latest_cycle_observations AS (
          SELECT co.*
          FROM cycle_observations co
          INNER JOIN (
            SELECT cycle_id, MAX(observation_version) AS max_version
            FROM cycle_observations
            GROUP BY cycle_id
          ) latest
            ON latest.cycle_id = co.cycle_id
           AND latest.max_version = co.observation_version
        )
        SELECT
          co.*,
          r.owner,
          r.name,
          s.commit_sha
        FROM latest_cycle_observations co
        INNER JOIN repositories r ON r.id = co.repository_id
        INNER JOIN scans s ON s.id = co.scan_id
        ORDER BY r.owner ASC, r.name ASC, co.cycle_id ASC, co.id ASC
      `,
    )
    .all() as CycleObservationExportRow[];
}

function loadLatestCandidateObservationRows(database: DatabaseType): CandidateObservationExportRow[] {
  return database
    .prepare(
      `
        WITH latest_cycle_observations AS (
          SELECT co.*
          FROM cycle_observations co
          INNER JOIN (
            SELECT cycle_id, MAX(observation_version) AS max_version
            FROM cycle_observations
            GROUP BY cycle_id
          ) latest
            ON latest.cycle_id = co.cycle_id
           AND latest.max_version = co.observation_version
        )
        SELECT
          cobs.*,
          co.cycle_id,
          co.scan_id,
          co.repository_id,
          co.normalized_path,
          co.cycle_shape,
          co.cycle_size,
          co.cycle_signals,
          co.feature_vector,
          co.graph_summary,
          co.repo_profile,
          co.planner_summary,
          co.selected_strategy,
          co.selected_classification,
          co.fallback_classification,
          r.owner,
          r.name,
          s.commit_sha,
          p.touched_files,
          p.patch_text,
          rd.decision AS review_status,
          rd.notes AS review_notes
        FROM candidate_observations cobs
        INNER JOIN latest_cycle_observations co ON co.id = cobs.cycle_observation_id
        INNER JOIN repositories r ON r.id = co.repository_id
        INNER JOIN scans s ON s.id = co.scan_id
        LEFT JOIN patches p ON p.id = cobs.patch_id
        LEFT JOIN review_decisions rd ON rd.id = (
          SELECT id
          FROM review_decisions
          WHERE patch_id = cobs.patch_id
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        )
        ORDER BY r.owner ASC, r.name ASC, co.cycle_id ASC, cobs.planner_rank ASC, cobs.id ASC
      `,
    )
    .all() as CandidateObservationExportRow[];
}

function loadAcceptanceBenchmarkRows(database: DatabaseType): AcceptanceBenchmarkCaseDTO[] {
  return database
    .prepare(
      `
        SELECT *
        FROM acceptance_benchmark_cases
        ORDER BY repository ASC, id ASC
      `,
    )
    .all() as AcceptanceBenchmarkCaseDTO[];
}

function loadBenchmarkCaseRows(database: DatabaseType): BenchmarkCaseDTO[] {
  return database
    .prepare(
      `
        SELECT *
        FROM benchmark_cases
        ORDER BY repository ASC, id ASC
      `,
    )
    .all() as BenchmarkCaseDTO[];
}

function mapCycleObservationRow(row: CycleObservationExportRow): CycleObservationTrainingRow {
  return {
    rowType: 'cycle_observation',
    rowId: `cycle-observation:${row.id}`,
    repository: {
      id: row.repository_id,
      slug: `${row.owner}/${row.name}`,
    },
    scanId: row.scan_id,
    commitSha: row.commit_sha,
    cycleId: row.cycle_id,
    observationId: row.id,
    observationVersion: row.observation_version,
    normalizedPath: row.normalized_path,
    cycleShape: row.cycle_shape,
    cycleSize: row.cycle_size,
    cycleSignals: parseJsonRecord(row.cycle_signals),
    featureVector: parseJsonRecord(row.feature_vector),
    graphSummary: parseJsonRecord(row.graph_summary),
    repoProfile: parseJsonRecord(row.repo_profile),
    planner: {
      summary: row.planner_summary,
      attempts: parseJsonArray(row.planner_attempts),
      selectedStrategy: row.selected_strategy,
      selectedClassification: row.selected_classification,
      selectedScore: row.selected_score,
      fallbackClassification: row.fallback_classification,
      fallbackConfidence: row.fallback_confidence,
      fallbackReasons: parseJsonStringArray(row.fallback_reasons),
    },
  };
}

function mapCandidateObservationRow(row: CandidateObservationExportRow): CandidateObservationTrainingRow {
  return {
    rowType: 'candidate_observation',
    rowId: `candidate-observation:${row.id}`,
    repository: {
      id: row.repository_id,
      slug: `${row.owner}/${row.name}`,
    },
    scanId: row.scan_id,
    commitSha: row.commit_sha,
    cycleId: row.cycle_id,
    observationId: row.cycle_observation_id,
    observationVersion: row.observation_version,
    candidateObservationId: row.id,
    fixCandidateId: row.fix_candidate_id,
    patchId: row.patch_id,
    normalizedPath: row.normalized_path,
    cycleShape: row.cycle_shape,
    cycleSize: row.cycle_size,
    cycleSignals: parseJsonRecord(row.cycle_signals),
    featureVector: parseJsonRecord(row.feature_vector),
    graphSummary: parseJsonRecord(row.graph_summary),
    repoProfile: parseJsonRecord(row.repo_profile),
    planner: {
      summary: row.planner_summary,
      selectedStrategy: row.selected_strategy,
      selectedClassification: row.selected_classification,
      fallbackClassification: row.fallback_classification,
    },
    candidate: {
      strategy: row.strategy,
      status: row.status,
      plannerRank: row.planner_rank,
      promotionEligible: row.promotion_eligible === 1,
      summary: row.summary,
      classification: row.classification,
      confidence: row.confidence,
      upstreamabilityScore: row.upstreamability_score,
      reasons: parseJsonStringArray(row.reasons),
      scoreBreakdown: parseJsonStringArray(row.score_breakdown),
      signals: parseJsonRecord(row.signals),
      plan: parseJsonNullableRecord(row.plan),
    },
    validation: {
      status: row.validation_status,
      summary: row.validation_summary,
      failureCategory: row.validation_failure_category,
    },
    review: {
      status: row.review_status,
      notes: row.review_notes,
    },
    patch: {
      touchedFiles: parseJsonStringArray(row.touched_files),
      patchText: row.patch_text,
    },
  };
}

function mapAcceptanceBenchmarkRow(row: AcceptanceBenchmarkCaseDTO): AcceptanceBenchmarkTrainingRow {
  return {
    rowType: 'acceptance_benchmark',
    rowId: `acceptance-benchmark:${row.id}`,
    repository: {
      slug: row.repository,
      localPath: row.local_path,
    },
    commitSha: row.commit_sha,
    scanId: row.scan_id,
    cycleId: row.cycle_id,
    fixCandidateId: row.fix_candidate_id,
    patchId: row.patch_id,
    normalizedPath: row.normalized_path,
    classification: row.classification,
    confidence: row.confidence,
    upstreamabilityScore: row.upstreamability_score,
    validation: {
      status: row.validation_status,
      summary: row.validation_summary,
    },
    reviewStatus: row.review_status,
    touchedFiles: parseJsonStringArray(row.touched_files),
    featureVector: parseJsonRecord(row.feature_vector),
    plannerSummary: row.planner_summary,
    plannerAttempts: parseJsonArray(row.planner_attempts),
    acceptability: {
      decision: row.acceptability,
      rejectionReason: row.rejection_reason,
      note: row.acceptability_note,
    },
  };
}

function mapBenchmarkCaseRow(row: BenchmarkCaseDTO): BenchmarkCaseTrainingRow {
  return {
    rowType: 'benchmark_case',
    rowId: `benchmark-case:${row.id}`,
    repository: row.repository,
    source: row.source,
    commitSha: row.commit_sha,
    title: row.title,
    body: row.body,
    url: row.url,
    prNumber: row.pr_number,
    issueNumber: row.issue_number,
    strategyLabels: parseJsonStringArray(row.strategy_labels),
    validationSignals: parseJsonRecord(row.validation_signals),
    diffFeatures: parseJsonRecord(row.diff_features),
    matchedTerms: parseJsonStringArray(row.matched_terms),
    notes: row.notes,
  };
}

function isTrainingEligibleBenchmarkCase(row: BenchmarkCaseDTO): boolean {
  const signals = parseJsonRecord(row.validation_signals);
  const languageScope = asRecord(signals.language_scope);

  return languageScope?.training_language === 'js_ts' && languageScope.eligible === true;
}

function parseJsonRecord(value: string | null): Record<string, unknown> {
  return parseJsonValue<Record<string, unknown>>(value, {});
}

function parseJsonNullableRecord(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  return parseJsonValue<Record<string, unknown>>(value, {});
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function parseJsonArray(value: string | null): unknown[] {
  return parseJsonValue<unknown[]>(value, []);
}

function parseJsonStringArray(value: string | null): string[] {
  return parseJsonArray(value).filter((item): item is string => typeof item === 'string');
}

function parseJsonValue<T>(value: string | null, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
