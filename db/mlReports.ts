import type { Database as DatabaseType } from 'better-sqlite3';
import { getDb } from './index.js';

export interface MlDisagreementReportRow {
  cycleObservationId: number;
  modelVersion: string;
  repositorySlug: string;
  normalizedPath: string;
  heuristicStrategy: string | null;
  modelStrategy: string | null;
  heuristicCandidateObservationId: number | null;
  modelCandidateObservationId: number | null;
  heuristicScore: number | null;
  modelScore: number | null;
  disagreement: boolean;
}

export interface MlLabelingQueueRow {
  cycleObservationId: number;
  modelVersion: string;
  repositorySlug: string;
  normalizedPath: string;
  heuristicStrategy: string | null;
  modelStrategy: string | null;
  heuristicCandidateObservationId: number | null;
  modelCandidateObservationId: number | null;
  heuristicScore: number | null;
  modelScore: number | null;
  heuristicValidationStatus: string | null;
  modelValidationStatus: string | null;
  heuristicReviewDecision: string | null;
  modelReviewDecision: string | null;
  priorityScore: number;
}

export function getMlDisagreementReport(database: DatabaseType = getDb(), modelVersion?: string) {
  const effectiveModelVersion = modelVersion ?? getLatestModelVersion(database);
  if (!effectiveModelVersion) {
    return {
      modelVersion: null,
      totalCycles: 0,
      disagreements: 0,
      rows: [] as MlDisagreementReportRow[],
    };
  }

  const rows = database
    .prepare(
      `
        SELECT
          mcr.cycle_observation_id AS cycleObservationId,
          mcr.model_version AS modelVersion,
          r.owner || '/' || r.name AS repositorySlug,
          co.normalized_path AS normalizedPath,
          mcr.heuristic_strategy AS heuristicStrategy,
          mcr.model_strategy AS modelStrategy,
          mcr.heuristic_candidate_observation_id AS heuristicCandidateObservationId,
          mcr.model_candidate_observation_id AS modelCandidateObservationId,
          heuristic_scores.combined_score AS heuristicScore,
          model_scores.combined_score AS modelScore,
          mcr.disagreement AS disagreement
        FROM ml_cycle_rankings mcr
        INNER JOIN cycle_observations co ON co.id = mcr.cycle_observation_id
        INNER JOIN repositories r ON r.id = co.repository_id
        LEFT JOIN candidate_ml_scores heuristic_scores
          ON heuristic_scores.candidate_observation_id = mcr.heuristic_candidate_observation_id
         AND heuristic_scores.model_version = mcr.model_version
        LEFT JOIN candidate_ml_scores model_scores
          ON model_scores.candidate_observation_id = mcr.model_candidate_observation_id
         AND model_scores.model_version = mcr.model_version
        WHERE mcr.model_version = ?
        ORDER BY mcr.disagreement DESC, model_scores.combined_score DESC, mcr.id ASC
      `,
    )
    .all(effectiveModelVersion) as Array<Omit<MlDisagreementReportRow, 'disagreement'> & { disagreement: number }>;

  return {
    modelVersion: effectiveModelVersion,
    totalCycles: rows.length,
    disagreements: rows.filter((row) => row.disagreement === 1).length,
    rows: rows.map((row) => ({
      ...row,
      disagreement: row.disagreement === 1,
    })),
  };
}

export function getMlLabelingQueueReport(database: DatabaseType = getDb(), modelVersion?: string, limit = 25) {
  const effectiveModelVersion = modelVersion ?? getLatestModelVersion(database);
  if (!effectiveModelVersion) {
    return {
      modelVersion: null,
      totalCycles: 0,
      rows: [] as MlLabelingQueueRow[],
    };
  }

  const rows = database
    .prepare(
      `
        SELECT
          mcr.cycle_observation_id AS cycleObservationId,
          mcr.model_version AS modelVersion,
          r.owner || '/' || r.name AS repositorySlug,
          co.normalized_path AS normalizedPath,
          mcr.heuristic_strategy AS heuristicStrategy,
          mcr.model_strategy AS modelStrategy,
          mcr.heuristic_candidate_observation_id AS heuristicCandidateObservationId,
          mcr.model_candidate_observation_id AS modelCandidateObservationId,
          heuristic_scores.combined_score AS heuristicScore,
          model_scores.combined_score AS modelScore,
          heuristic_candidate.validation_status AS heuristicValidationStatus,
          model_candidate.validation_status AS modelValidationStatus,
          heuristic_review.decision AS heuristicReviewDecision,
          model_review.decision AS modelReviewDecision,
          (
            (CASE WHEN mcr.disagreement = 1 THEN 10 ELSE 0 END) +
            ABS(COALESCE(model_scores.combined_score, 0.5) - COALESCE(heuristic_scores.combined_score, 0.5)) * 5 +
            (CASE
              WHEN heuristic_review.decision IS NULL AND model_review.decision IS NULL THEN 2
              WHEN heuristic_review.decision IS NULL OR model_review.decision IS NULL THEN 1
              ELSE 0
            END)
          ) AS priorityScore
        FROM ml_cycle_rankings mcr
        INNER JOIN cycle_observations co ON co.id = mcr.cycle_observation_id
        INNER JOIN repositories r ON r.id = co.repository_id
        LEFT JOIN candidate_observations heuristic_candidate ON heuristic_candidate.id = mcr.heuristic_candidate_observation_id
        LEFT JOIN candidate_observations model_candidate ON model_candidate.id = mcr.model_candidate_observation_id
        LEFT JOIN review_decisions heuristic_review ON heuristic_review.patch_id = heuristic_candidate.patch_id
        LEFT JOIN review_decisions model_review ON model_review.patch_id = model_candidate.patch_id
        LEFT JOIN candidate_ml_scores heuristic_scores
          ON heuristic_scores.candidate_observation_id = mcr.heuristic_candidate_observation_id
         AND heuristic_scores.model_version = mcr.model_version
        LEFT JOIN candidate_ml_scores model_scores
          ON model_scores.candidate_observation_id = mcr.model_candidate_observation_id
         AND model_scores.model_version = mcr.model_version
        WHERE mcr.model_version = ?
          AND mcr.disagreement = 1
          AND (
            heuristic_review.decision IS NULL
            OR model_review.decision IS NULL
          )
        ORDER BY priorityScore DESC, mcr.id ASC
        LIMIT ?
      `,
    )
    .all(effectiveModelVersion, limit) as MlLabelingQueueRow[];

  return {
    modelVersion: effectiveModelVersion,
    totalCycles: rows.length,
    rows,
  };
}

function getLatestModelVersion(database: DatabaseType): string | null {
  const row = database
    .prepare(
      `
        SELECT model_version
        FROM ml_cycle_rankings
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      `,
    )
    .get() as { model_version: string } | undefined;

  return row?.model_version ?? null;
}
