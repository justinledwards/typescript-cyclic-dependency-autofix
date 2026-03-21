import type { Database as DatabaseType } from 'better-sqlite3';
import { getDb } from '../db/index.js';
import { DEFAULT_MIN_PATCH_CONFIDENCE } from './promotionPolicy.js';

interface CountRow {
  count: number;
}

interface CountByKeyRow {
  count: number;
  key: string | null;
}

export interface OperationalMetrics {
  repositories: {
    total: number;
    byStatus: Record<string, number>;
  };
  scans: {
    total: number;
    completed: number;
    failed: number;
    byStatus: Record<string, number>;
  };
  cycles: {
    total: number;
  };
  fixCandidates: {
    total: number;
    highConfidence: number;
    byClassification: Record<string, number>;
  };
  patches: {
    total: number;
    passed: number;
    failed: number;
    pending: number;
    validationPassRate: number | null;
  };
  reviews: {
    total: number;
    approved: number;
    prCandidate: number;
    rejected: number;
    ignored: number;
    approvalRate: number | null;
  };
}

export function getOperationalMetrics(database: DatabaseType = getDb()): OperationalMetrics {
  const repositoriesByStatus = countByKey(
    database,
    'SELECT status AS key, COUNT(*) AS count FROM repositories GROUP BY status',
  );
  const scansByStatus = countByKey(
    database,
    'SELECT COALESCE(status, ?) AS key, COUNT(*) AS count FROM scans GROUP BY COALESCE(status, ?)',
    ['unknown', 'unknown'],
  );
  const fixCandidatesByClassification = countByKey(
    database,
    'SELECT classification AS key, COUNT(*) AS count FROM fix_candidates GROUP BY classification',
  );
  const patchValidationByStatus = countByKey(
    database,
    "SELECT COALESCE(validation_status, 'pending') AS key, COUNT(*) AS count FROM patches GROUP BY COALESCE(validation_status, 'pending')",
  );
  const reviewsByDecision = countByKey(
    database,
    'SELECT decision AS key, COUNT(*) AS count FROM review_decisions GROUP BY decision',
  );

  const passedPatchCount = patchValidationByStatus.passed ?? 0;
  const failedPatchCount = patchValidationByStatus.failed ?? 0;
  const completedPatchValidations = passedPatchCount + failedPatchCount;
  const approvalCount = reviewsByDecision.approved ?? 0;
  const reviewCount = count(database, 'SELECT COUNT(*) AS count FROM review_decisions');

  return {
    repositories: {
      total: count(database, 'SELECT COUNT(*) AS count FROM repositories'),
      byStatus: repositoriesByStatus,
    },
    scans: {
      total: count(database, 'SELECT COUNT(*) AS count FROM scans'),
      completed: scansByStatus.completed ?? 0,
      failed: scansByStatus.failed ?? 0,
      byStatus: scansByStatus,
    },
    cycles: {
      total: count(database, 'SELECT COUNT(*) AS count FROM cycles'),
    },
    fixCandidates: {
      total: count(database, 'SELECT COUNT(*) AS count FROM fix_candidates'),
      highConfidence: count(database, 'SELECT COUNT(*) AS count FROM fix_candidates WHERE confidence >= ?', [
        DEFAULT_MIN_PATCH_CONFIDENCE,
      ]),
      byClassification: fixCandidatesByClassification,
    },
    patches: {
      total: count(database, 'SELECT COUNT(*) AS count FROM patches'),
      passed: passedPatchCount,
      failed: failedPatchCount,
      pending: patchValidationByStatus.pending ?? 0,
      validationPassRate:
        completedPatchValidations > 0 ? roundFraction(passedPatchCount / completedPatchValidations) : null,
    },
    reviews: {
      total: reviewCount,
      approved: approvalCount,
      prCandidate: reviewsByDecision.pr_candidate ?? 0,
      rejected: reviewsByDecision.rejected ?? 0,
      ignored: reviewsByDecision.ignored ?? 0,
      approvalRate: reviewCount > 0 ? roundFraction(approvalCount / reviewCount) : null,
    },
  };
}

function count(database: DatabaseType, sql: string, parameters: unknown[] = []): number {
  const row = database.prepare(sql).get(...parameters) as CountRow | undefined;
  return row?.count ?? 0;
}

function countByKey(database: DatabaseType, sql: string, parameters: unknown[] = []): Record<string, number> {
  const rows = database.prepare(sql).all(...parameters) as CountByKeyRow[];
  const counts: Record<string, number> = {};

  for (const row of rows) {
    counts[row.key ?? 'unknown'] = row.count;
  }

  return counts;
}

function roundFraction(value: number): number {
  return Number(value.toFixed(4));
}
