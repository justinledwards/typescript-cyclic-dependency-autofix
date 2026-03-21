import type { BenchmarkCaseDTO } from '../../db/index.js';
import { getBenchmarkCases, getDb } from '../../db/index.js';
import type {
  HistoricalEvidenceSnapshot,
  PlannerRepositoryProfile,
  PlanningStrategy,
  StrategyHistoricalEvidence,
} from './types.js';

const STRATEGIES: PlanningStrategy[] = ['import_type', 'direct_import', 'extract_shared', 'host_state_update'];

const STRATEGY_LABELS: Record<PlanningStrategy, string[]> = {
  import_type: ['import_type', 'type_runtime_split'],
  direct_import: ['direct_import', 'barrel_reexport_cleanup'],
  extract_shared: ['extract_shared', 'leaf_cluster_extraction'],
  host_state_update: ['host_owned_state_update', 'stateful_singleton_split'],
};

const CLASSIFICATION_TO_STRATEGY: Partial<Record<string, PlanningStrategy>> = {
  autofix_import_type: 'import_type',
  autofix_direct_import: 'direct_import',
  autofix_extract_shared: 'extract_shared',
  autofix_host_state_update: 'host_state_update',
};

interface ReviewEvidenceRow {
  classification: string;
  validation_status: string | null;
  decision: string | null;
}

interface BenchmarkSignalsShape {
  repository_profile?: {
    package_manager?: PlannerRepositoryProfile['packageManager'];
    workspace_mode?: PlannerRepositoryProfile['workspaceMode'];
  };
}

export function createEmptyHistoricalEvidenceSnapshot(): HistoricalEvidenceSnapshot {
  return {
    totalBenchmarkCases: 0,
    totalReviewedPatches: 0,
    totalValidatedPatches: 0,
    strategies: {
      import_type: createEmptyStrategyEvidence(),
      direct_import: createEmptyStrategyEvidence(),
      extract_shared: createEmptyStrategyEvidence(),
      host_state_update: createEmptyStrategyEvidence(),
    },
  };
}

export function loadHistoricalEvidence(repositoryProfile?: PlannerRepositoryProfile): HistoricalEvidenceSnapshot {
  const snapshot = createEmptyHistoricalEvidenceSnapshot();
  const benchmarkCases = getBenchmarkCases.all() as BenchmarkCaseDTO[];

  snapshot.totalBenchmarkCases = benchmarkCases.length;
  for (const benchmarkCase of benchmarkCases) {
    applyBenchmarkCase(snapshot, benchmarkCase, repositoryProfile);
  }

  const reviewRows = getDb()
    .prepare(
      `
        SELECT
          fc.classification,
          p.validation_status,
          rd.decision
        FROM fix_candidates fc
        LEFT JOIN patches p ON p.fix_candidate_id = fc.id
        LEFT JOIN review_decisions rd ON rd.patch_id = p.id
      `,
    )
    .all() as ReviewEvidenceRow[];

  for (const row of reviewRows) {
    const strategy = CLASSIFICATION_TO_STRATEGY[row.classification];
    if (!strategy) {
      continue;
    }

    const evidence = snapshot.strategies[strategy];
    if (row.validation_status === 'passed') {
      evidence.passedValidations += 1;
      snapshot.totalValidatedPatches += 1;
    } else if (row.validation_status === 'failed') {
      evidence.failedValidations += 1;
      snapshot.totalValidatedPatches += 1;
    }

    switch (row.decision) {
      case 'approved': {
        evidence.approvedReviews += 1;
        snapshot.totalReviewedPatches += 1;
        break;
      }
      case 'rejected': {
        evidence.rejectedReviews += 1;
        snapshot.totalReviewedPatches += 1;
        break;
      }
      case 'pr_candidate': {
        evidence.prCandidates += 1;
        snapshot.totalReviewedPatches += 1;
        break;
      }
      case 'ignored': {
        evidence.ignoredReviews += 1;
        snapshot.totalReviewedPatches += 1;
        break;
      }
      default: {
        break;
      }
    }
  }

  return snapshot;
}

function applyBenchmarkCase(
  snapshot: HistoricalEvidenceSnapshot,
  benchmarkCase: BenchmarkCaseDTO,
  repositoryProfile?: PlannerRepositoryProfile,
): void {
  const labels = parseJsonArray(benchmarkCase.strategy_labels);
  const signals = parseBenchmarkSignals(benchmarkCase.validation_signals);

  for (const strategy of STRATEGIES) {
    if (!labels.some((label) => STRATEGY_LABELS[strategy].includes(label))) {
      continue;
    }

    const evidence = snapshot.strategies[strategy];
    evidence.benchmarkMatches += 1;

    if (repositoryProfile && signals.repository_profile) {
      if (signals.repository_profile.package_manager === repositoryProfile.packageManager) {
        evidence.profileMatches += 1;
      }
      if (signals.repository_profile.workspace_mode === repositoryProfile.workspaceMode) {
        evidence.profileMatches += 1;
      }
    }
  }
}

function createEmptyStrategyEvidence(): StrategyHistoricalEvidence {
  return {
    benchmarkMatches: 0,
    profileMatches: 0,
    approvedReviews: 0,
    rejectedReviews: 0,
    prCandidates: 0,
    ignoredReviews: 0,
    passedValidations: 0,
    failedValidations: 0,
  };
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseBenchmarkSignals(value: string): BenchmarkSignalsShape {
  try {
    const parsed = JSON.parse(value) as BenchmarkSignalsShape;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
