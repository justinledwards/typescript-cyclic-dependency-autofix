import type { AcceptanceBenchmarkCaseDTO, BenchmarkCaseDTO } from '../../db/index.js';
import { getAcceptanceBenchmarkCases, getBenchmarkCases, getDb } from '../../db/index.js';
import type {
  HistoricalEvidenceSnapshot,
  PlannerRepositoryProfile,
  PlanningStrategy,
  StrategyHistoricalEvidence,
} from './types.js';

const STRATEGIES: PlanningStrategy[] = ['import_type', 'direct_import', 'extract_shared', 'host_state_update'];

const STRATEGY_LABELS: Record<PlanningStrategy, string[]> = {
  import_type: ['import_type', 'type_runtime_split'],
  direct_import: ['direct_import', 'barrel_reexport_cleanup', 'public_seam_bypass', 'export_graph_rewrite'],
  extract_shared: ['extract_shared', 'leaf_cluster_extraction'],
  host_state_update: [
    'host_owned_state_update',
    'stateful_singleton_split',
    'ownership_localization',
    'internal_surface_split',
  ],
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

interface ReplayEvidenceRow {
  classification: string;
  replay_bundle: string | null;
}

interface BenchmarkSignalsShape {
  repository_profile?: {
    package_manager?: PlannerRepositoryProfile['packageManager'];
    workspace_mode?: PlannerRepositoryProfile['workspaceMode'];
  };
}

interface AcceptanceFeatureVectorShape {
  packageManager?: PlannerRepositoryProfile['packageManager'];
  workspaceMode?: PlannerRepositoryProfile['workspaceMode'];
}

interface ReplayBundleShape {
  validation?: {
    failureCategory?: string | null;
  };
}

export function createEmptyHistoricalEvidenceSnapshot(): HistoricalEvidenceSnapshot {
  return {
    totalBenchmarkCases: 0,
    totalAcceptanceBenchmarkCases: 0,
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

  const acceptanceBenchmarkCases = getAcceptanceBenchmarkCases.all() as AcceptanceBenchmarkCaseDTO[];
  snapshot.totalAcceptanceBenchmarkCases = acceptanceBenchmarkCases.length;
  for (const acceptanceCase of acceptanceBenchmarkCases) {
    applyAcceptanceBenchmarkCase(snapshot, acceptanceCase, repositoryProfile);
  }

  applyReviewEvidence(snapshot, loadReviewEvidenceRows());
  applyReplayEvidence(snapshot, loadReplayEvidenceRows());

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

function applyAcceptanceBenchmarkCase(
  snapshot: HistoricalEvidenceSnapshot,
  benchmarkCase: AcceptanceBenchmarkCaseDTO,
  repositoryProfile?: PlannerRepositoryProfile,
): void {
  const strategy = CLASSIFICATION_TO_STRATEGY[benchmarkCase.classification];
  if (!strategy) {
    return;
  }

  const evidence = snapshot.strategies[strategy];
  const featureVector = parseAcceptanceFeatureVector(benchmarkCase.feature_vector);

  if (repositoryProfile) {
    let profileMatches = 0;
    if (featureVector.packageManager === repositoryProfile.packageManager) {
      profileMatches += 1;
    }
    if (featureVector.workspaceMode === repositoryProfile.workspaceMode) {
      profileMatches += 1;
    }
    evidence.acceptanceProfileMatches = (evidence.acceptanceProfileMatches ?? 0) + profileMatches;
  }

  switch (benchmarkCase.acceptability) {
    case 'accepted': {
      evidence.acceptedBenchmarks = (evidence.acceptedBenchmarks ?? 0) + 1;
      break;
    }
    case 'rejected': {
      evidence.rejectedBenchmarks = (evidence.rejectedBenchmarks ?? 0) + 1;

      switch (benchmarkCase.rejection_reason) {
        case 'diff_noisy': {
          evidence.diffNoisyRejections = (evidence.diffNoisyRejections ?? 0) + 1;
          break;
        }
        case 'repo_conventions_mismatch': {
          evidence.repoConventionsMismatchRejections = (evidence.repoConventionsMismatchRejections ?? 0) + 1;
          break;
        }
        case 'semantic_wrong': {
          evidence.semanticWrongRejections = (evidence.semanticWrongRejections ?? 0) + 1;
          break;
        }
        case 'validation_weak': {
          evidence.validationWeakRejections = (evidence.validationWeakRejections ?? 0) + 1;
          break;
        }
        default: {
          evidence.otherRejections = (evidence.otherRejections ?? 0) + 1;
          break;
        }
      }
      break;
    }
    case 'needs_review': {
      evidence.needsReviewBenchmarks = (evidence.needsReviewBenchmarks ?? 0) + 1;
      break;
    }
    default: {
      evidence.needsReviewBenchmarks = (evidence.needsReviewBenchmarks ?? 0) + 1;
      break;
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
    acceptedBenchmarks: 0,
    rejectedBenchmarks: 0,
    needsReviewBenchmarks: 0,
    acceptanceProfileMatches: 0,
    semanticWrongRejections: 0,
    repoConventionsMismatchRejections: 0,
    diffNoisyRejections: 0,
    validationWeakRejections: 0,
    otherRejections: 0,
    originalCyclePersistedFailures: 0,
    newCyclesIntroducedFailures: 0,
    repoValidationFailures: 0,
    typecheckFailures: 0,
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

function parseAcceptanceFeatureVector(value: string): AcceptanceFeatureVectorShape {
  try {
    const parsed = JSON.parse(value) as AcceptanceFeatureVectorShape;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function parseReplayFailureCategory(value: string | null): string | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as ReplayBundleShape;
    return typeof parsed.validation?.failureCategory === 'string' ? parsed.validation.failureCategory : null;
  } catch {
    return null;
  }
}

function loadReviewEvidenceRows(): ReviewEvidenceRow[] {
  return getDb()
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
}

function applyReviewEvidence(snapshot: HistoricalEvidenceSnapshot, reviewRows: ReviewEvidenceRow[]): void {
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

    const reviewed = applyReviewDecision(evidence, row.decision);
    if (reviewed) {
      snapshot.totalReviewedPatches += 1;
    }
  }
}

function applyReviewDecision(evidence: StrategyHistoricalEvidence, decision: string | null): boolean {
  switch (decision) {
    case 'approved': {
      evidence.approvedReviews += 1;
      return true;
    }
    case 'rejected': {
      evidence.rejectedReviews += 1;
      return true;
    }
    case 'pr_candidate': {
      evidence.prCandidates += 1;
      return true;
    }
    case 'ignored': {
      evidence.ignoredReviews += 1;
      return true;
    }
    default: {
      return false;
    }
  }
}

function loadReplayEvidenceRows(): ReplayEvidenceRow[] {
  return getDb()
    .prepare(
      `
        SELECT
          fc.classification,
          pr.replay_bundle
        FROM fix_candidates fc
        INNER JOIN patches p ON p.fix_candidate_id = fc.id
        INNER JOIN patch_replays pr ON pr.patch_id = p.id
      `,
    )
    .all() as ReplayEvidenceRow[];
}

function applyReplayEvidence(snapshot: HistoricalEvidenceSnapshot, replayRows: ReplayEvidenceRow[]): void {
  for (const row of replayRows) {
    const strategy = CLASSIFICATION_TO_STRATEGY[row.classification];
    if (!strategy) {
      continue;
    }

    const failureCategory = parseReplayFailureCategory(row.replay_bundle);
    if (!failureCategory) {
      continue;
    }

    incrementReplayFailure(snapshot.strategies[strategy], failureCategory);
  }
}

function incrementReplayFailure(evidence: StrategyHistoricalEvidence, failureCategory: string): void {
  switch (failureCategory) {
    case 'new_cycles_introduced': {
      evidence.newCyclesIntroducedFailures = (evidence.newCyclesIntroducedFailures ?? 0) + 1;
      break;
    }
    case 'original_cycle_persisted': {
      evidence.originalCyclePersistedFailures = (evidence.originalCyclePersistedFailures ?? 0) + 1;
      break;
    }
    case 'repo_validation_failed': {
      evidence.repoValidationFailures = (evidence.repoValidationFailures ?? 0) + 1;
      break;
    }
    case 'typecheck_failed': {
      evidence.typecheckFailures = (evidence.typecheckFailures ?? 0) + 1;
      break;
    }
    default: {
      break;
    }
  }
}
