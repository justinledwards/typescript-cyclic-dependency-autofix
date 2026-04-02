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
