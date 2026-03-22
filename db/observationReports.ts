import type { Database as DatabaseType } from 'better-sqlite3';
import { getDb } from './index.js';

const DEFAULT_LIMIT = 15;

interface CycleObservationRow {
  id: number;
  cycle_id: number;
  normalized_path: string;
  cycle_shape: string | null;
  cycle_size: number;
  feature_vector: string | null;
  repo_profile: string | null;
  selected_classification: string | null;
  fallback_classification: string | null;
  fallback_reasons: string | null;
}

interface CandidateObservationRow {
  strategy: string | null;
  status: string;
  promotion_eligible: number;
  confidence: number | null;
  upstreamability_score: number | null;
  validation_status: string | null;
  validation_failure_category: string | null;
  patch_id: number | null;
  review_status: string | null;
  cycle_shape: string | null;
  cycle_size: number;
  feature_vector: string | null;
  repo_profile: string | null;
}

interface AcceptanceSummaryRow {
  classification: string;
  total_cases: number;
  accepted_cases: number;
  rejected_cases: number;
  needs_review_cases: number;
}

interface RepoProfileShape {
  packageManager?: string;
  workspaceMode?: string;
  validationCommandCount?: number;
}

interface FeatureVectorShape {
  hasBarrelFile?: boolean;
  hasSharedModuleFile?: boolean;
  packageManager?: string;
  workspaceMode?: string;
}

export interface PatternReport {
  summary: {
    cycleObservations: number;
    candidateObservations: number;
  };
  cycleShapes: Array<{
    cycleShape: string;
    cycleSize: number;
    hasBarrelFile: boolean;
    hasSharedModuleFile: boolean;
    packageManager: string;
    workspaceMode: string;
    count: number;
  }>;
  failureClusters: Array<{
    strategy: string;
    failureCategory: string;
    cycleShape: string;
    packageManager: string;
    workspaceMode: string;
    count: number;
    averageConfidence: number | null;
    averageUpstreamability: number | null;
  }>;
  unsupportedClusters: Array<{
    classification: string;
    cycleShape: string;
    cycleSize: number;
    hasBarrelFile: boolean;
    packageManager: string;
    workspaceMode: string;
    count: number;
    samplePaths: string[];
    reasons: string[];
  }>;
}

export interface StrategyPerformanceReport {
  byRepositoryProfile: Array<{
    strategy: string;
    packageManager: string;
    workspaceMode: string;
    attempts: number;
    promoted: number;
    passedValidations: number;
    failedValidations: number;
    approvedReviews: number;
    rejectedReviews: number;
    prCandidates: number;
    ignoredReviews: number;
  }>;
  acceptanceByStrategy: Array<{
    strategy: string;
    classification: string;
    totalCases: number;
    acceptedCases: number;
    rejectedCases: number;
    needsReviewCases: number;
    acceptanceRate: number | null;
  }>;
}

export function getPatternReport(database: DatabaseType = getDb()): PatternReport {
  const cycleRows = database
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
        SELECT *
        FROM latest_cycle_observations
        ORDER BY id ASC
      `,
    )
    .all() as CycleObservationRow[];

  const candidateRows = database
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
          cobs.strategy,
          cobs.status,
          cobs.promotion_eligible,
          cobs.confidence,
          cobs.upstreamability_score,
          cobs.validation_status,
          cobs.validation_failure_category,
          cobs.patch_id,
          rd.decision AS review_status,
          co.cycle_shape,
          co.cycle_size,
          co.feature_vector,
          co.repo_profile
        FROM candidate_observations cobs
        INNER JOIN latest_cycle_observations co ON co.id = cobs.cycle_observation_id
        LEFT JOIN review_decisions rd ON rd.patch_id = cobs.patch_id
        ORDER BY cobs.id ASC
      `,
    )
    .all() as CandidateObservationRow[];

  return {
    summary: {
      cycleObservations: cycleRows.length,
      candidateObservations: candidateRows.length,
    },
    cycleShapes: buildCycleShapeSummary(cycleRows),
    failureClusters: buildFailureClusters(candidateRows),
    unsupportedClusters: buildUnsupportedClusters(cycleRows),
  };
}

export function getStrategyPerformanceReport(database: DatabaseType = getDb()): StrategyPerformanceReport {
  const candidateRows = database
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
          cobs.strategy,
          cobs.status,
          cobs.promotion_eligible,
          cobs.confidence,
          cobs.upstreamability_score,
          cobs.validation_status,
          cobs.validation_failure_category,
          cobs.patch_id,
          rd.decision AS review_status,
          co.cycle_shape,
          co.cycle_size,
          co.feature_vector,
          co.repo_profile
        FROM candidate_observations cobs
        INNER JOIN latest_cycle_observations co ON co.id = cobs.cycle_observation_id
        LEFT JOIN review_decisions rd ON rd.patch_id = cobs.patch_id
        ORDER BY cobs.id ASC
      `,
    )
    .all() as CandidateObservationRow[];

  const acceptanceRows = database
    .prepare(
      `
        SELECT
          classification,
          COUNT(*) AS total_cases,
          SUM(CASE WHEN acceptability = 'accepted' THEN 1 ELSE 0 END) AS accepted_cases,
          SUM(CASE WHEN acceptability = 'rejected' THEN 1 ELSE 0 END) AS rejected_cases,
          SUM(CASE WHEN acceptability = 'needs_review' OR acceptability IS NULL THEN 1 ELSE 0 END) AS needs_review_cases
        FROM acceptance_benchmark_cases
        GROUP BY classification
        ORDER BY classification ASC
      `,
    )
    .all() as AcceptanceSummaryRow[];

  return {
    byRepositoryProfile: buildStrategyPerformance(candidateRows),
    acceptanceByStrategy: acceptanceRows.map((row) => ({
      strategy: classificationToStrategy(row.classification),
      classification: row.classification,
      totalCases: row.total_cases,
      acceptedCases: row.accepted_cases,
      rejectedCases: row.rejected_cases,
      needsReviewCases: row.needs_review_cases,
      acceptanceRate: row.total_cases > 0 ? Number((row.accepted_cases / row.total_cases).toFixed(2)) : null,
    })),
  };
}

export function getUnsupportedClustersReport(database: DatabaseType = getDb()) {
  return getPatternReport(database).unsupportedClusters;
}

function buildCycleShapeSummary(rows: CycleObservationRow[]): PatternReport['cycleShapes'] {
  const counts = new Map<string, PatternReport['cycleShapes'][number]>();

  for (const row of rows) {
    const featureVector = parseJson(row.feature_vector, {} as FeatureVectorShape);
    const repoProfile = parseJson(row.repo_profile, {} as RepoProfileShape);
    const bucket = {
      cycleShape: row.cycle_shape ?? 'unknown',
      cycleSize: row.cycle_size,
      hasBarrelFile: featureVector.hasBarrelFile === true,
      hasSharedModuleFile: featureVector.hasSharedModuleFile === true,
      packageManager: repoProfile.packageManager ?? featureVector.packageManager ?? 'unknown',
      workspaceMode: repoProfile.workspaceMode ?? featureVector.workspaceMode ?? 'unknown',
      count: 0,
    };
    const key = JSON.stringify(bucket);
    const current = counts.get(key) ?? bucket;
    current.count += 1;
    counts.set(key, current);
  }

  return sortDescendingByNumber([...counts.values()], (row) => row.count).slice(0, DEFAULT_LIMIT);
}

function buildFailureClusters(rows: CandidateObservationRow[]): PatternReport['failureClusters'] {
  const counts = new Map<
    string,
    {
      strategy: string;
      failureCategory: string;
      cycleShape: string;
      packageManager: string;
      workspaceMode: string;
      count: number;
      confidenceTotal: number;
      confidenceCount: number;
      upstreamabilityTotal: number;
      upstreamabilityCount: number;
    }
  >();

  for (const row of rows) {
    if (!row.strategy || !row.validation_failure_category) {
      continue;
    }

    const featureVector = parseJson(row.feature_vector, {} as FeatureVectorShape);
    const repoProfile = parseJson(row.repo_profile, {} as RepoProfileShape);
    const bucket = {
      strategy: row.strategy,
      failureCategory: row.validation_failure_category,
      cycleShape: row.cycle_shape ?? 'unknown',
      packageManager: repoProfile.packageManager ?? featureVector.packageManager ?? 'unknown',
      workspaceMode: repoProfile.workspaceMode ?? featureVector.workspaceMode ?? 'unknown',
      count: 0,
      confidenceTotal: 0,
      confidenceCount: 0,
      upstreamabilityTotal: 0,
      upstreamabilityCount: 0,
    };
    const key = JSON.stringify({
      strategy: bucket.strategy,
      failureCategory: bucket.failureCategory,
      cycleShape: bucket.cycleShape,
      packageManager: bucket.packageManager,
      workspaceMode: bucket.workspaceMode,
    });
    const current = counts.get(key) ?? bucket;
    current.count += 1;
    if (row.confidence !== null) {
      current.confidenceTotal += row.confidence;
      current.confidenceCount += 1;
    }
    if (row.upstreamability_score !== null) {
      current.upstreamabilityTotal += row.upstreamability_score;
      current.upstreamabilityCount += 1;
    }
    counts.set(key, current);
  }

  return sortDescendingByNumber(
    [...counts.values()].map((row) => ({
      strategy: row.strategy,
      failureCategory: row.failureCategory,
      cycleShape: row.cycleShape,
      packageManager: row.packageManager,
      workspaceMode: row.workspaceMode,
      count: row.count,
      averageConfidence:
        row.confidenceCount > 0 ? Number((row.confidenceTotal / row.confidenceCount).toFixed(2)) : null,
      averageUpstreamability:
        row.upstreamabilityCount > 0 ? Number((row.upstreamabilityTotal / row.upstreamabilityCount).toFixed(2)) : null,
    })),
    (row) => row.count,
  ).slice(0, DEFAULT_LIMIT);
}

function buildUnsupportedClusters(rows: CycleObservationRow[]): PatternReport['unsupportedClusters'] {
  const counts = new Map<
    string,
    {
      classification: string;
      cycleShape: string;
      cycleSize: number;
      hasBarrelFile: boolean;
      packageManager: string;
      workspaceMode: string;
      count: number;
      samplePaths: string[];
      reasons: string[];
    }
  >();

  for (const row of rows) {
    const classification = row.selected_classification ?? row.fallback_classification ?? 'unknown';
    if (classification !== 'unsupported' && classification !== 'suggest_manual') {
      continue;
    }

    const featureVector = parseJson(row.feature_vector, {} as FeatureVectorShape);
    const repoProfile = parseJson(row.repo_profile, {} as RepoProfileShape);
    const bucket = {
      classification,
      cycleShape: row.cycle_shape ?? 'unknown',
      cycleSize: row.cycle_size,
      hasBarrelFile: featureVector.hasBarrelFile === true,
      packageManager: repoProfile.packageManager ?? featureVector.packageManager ?? 'unknown',
      workspaceMode: repoProfile.workspaceMode ?? featureVector.workspaceMode ?? 'unknown',
      count: 0,
      samplePaths: [] as string[],
      reasons: [] as string[],
    };
    const key = JSON.stringify({
      classification: bucket.classification,
      cycleShape: bucket.cycleShape,
      cycleSize: bucket.cycleSize,
      hasBarrelFile: bucket.hasBarrelFile,
      packageManager: bucket.packageManager,
      workspaceMode: bucket.workspaceMode,
    });
    const current = counts.get(key) ?? bucket;
    current.count += 1;
    if (current.samplePaths.length < 3) {
      current.samplePaths.push(row.normalized_path);
    }
    const parsedReasons = parseJson(row.fallback_reasons, [] as string[]).filter(Boolean);
    for (const reason of parsedReasons) {
      if (current.reasons.length >= 3 || current.reasons.includes(reason)) {
        continue;
      }
      current.reasons.push(reason);
    }
    counts.set(key, current);
  }

  return sortDescendingByNumber([...counts.values()], (row) => row.count).slice(0, DEFAULT_LIMIT);
}

function buildStrategyPerformance(rows: CandidateObservationRow[]): StrategyPerformanceReport['byRepositoryProfile'] {
  const counts = new Map<string, StrategyPerformanceReport['byRepositoryProfile'][number]>();

  for (const row of rows) {
    if (!row.strategy || row.status !== 'candidate') {
      continue;
    }

    const featureVector = parseJson(row.feature_vector, {} as FeatureVectorShape);
    const repoProfile = parseJson(row.repo_profile, {} as RepoProfileShape);
    const bucket = {
      strategy: row.strategy,
      packageManager: repoProfile.packageManager ?? featureVector.packageManager ?? 'unknown',
      workspaceMode: repoProfile.workspaceMode ?? featureVector.workspaceMode ?? 'unknown',
      attempts: 0,
      promoted: 0,
      passedValidations: 0,
      failedValidations: 0,
      approvedReviews: 0,
      rejectedReviews: 0,
      prCandidates: 0,
      ignoredReviews: 0,
    };
    const key = JSON.stringify({
      strategy: bucket.strategy,
      packageManager: bucket.packageManager,
      workspaceMode: bucket.workspaceMode,
    });
    const current = counts.get(key) ?? bucket;
    current.attempts += 1;
    if (row.promotion_eligible === 1) {
      current.promoted += 1;
    }
    if (row.validation_status === 'passed') {
      current.passedValidations += 1;
    }
    if (row.validation_status === 'failed') {
      current.failedValidations += 1;
    }
    switch (row.review_status) {
      case 'approved': {
        current.approvedReviews += 1;
        break;
      }
      case 'rejected': {
        current.rejectedReviews += 1;
        break;
      }
      case 'pr_candidate': {
        current.prCandidates += 1;
        break;
      }
      case 'ignored': {
        current.ignoredReviews += 1;
        break;
      }
      default: {
        break;
      }
    }
    counts.set(key, current);
  }

  return sortDescendingByNumber([...counts.values()], (row) => row.attempts).slice(0, DEFAULT_LIMIT);
}

function classificationToStrategy(classification: string): string {
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
      return 'unknown';
    }
  }
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function sortDescendingByNumber<T>(rows: T[], getValue: (row: T) => number): T[] {
  const sorted: T[] = [];

  for (const row of rows) {
    const value = getValue(row);
    const insertAt = sorted.findIndex((existingRow) => getValue(existingRow) < value);
    if (insertAt === -1) {
      sorted.push(row);
      continue;
    }

    sorted.splice(insertAt, 0, row);
  }

  return sorted;
}
