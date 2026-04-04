import path from 'node:path';
import type {
  CycleFeatureVector,
  DirectImportFixPlan,
  ExtractSharedFixPlan,
  HistoricalEvidenceSnapshot,
  HostStateUpdateFixPlan,
  ImportTypeFixPlan,
  PlanningStrategy,
  StrategyAttempt,
  StrategySignalValue,
  TypeRuntimeSplitFixPlan,
} from './types.js';

export function scoreImportTypePlan(importPlans: ImportTypeFixPlan['imports']): {
  score: number;
  breakdown: string[];
  signals: Record<string, StrategySignalValue>;
} {
  const touchedFiles = new Set(importPlans.map((plan) => plan.sourceFile));
  const score = clampScore(0.97 - Math.max(0, touchedFiles.size - 1) * 0.03);
  return {
    score,
    breakdown: [
      'base 0.97 for least-invasive rewrite',
      touchedFiles.size > 1 ? `-0.03 for touching ${touchedFiles.size} files` : 'no penalty for single touched file',
    ],
    signals: {
      touchedFiles: touchedFiles.size,
      importEdges: importPlans.length,
      introducesNewFile: false,
      preservesSourceExports: true,
    },
  };
}

export function scoreTypeRuntimeSplitPlan(plan: TypeRuntimeSplitFixPlan): {
  score: number;
  breakdown: string[];
  signals: Record<string, StrategySignalValue>;
} {
  const touchedFiles = new Set(plan.imports.map((entry) => entry.sourceFile));
  const runtimeSymbolCount = plan.imports.reduce((count, entry) => count + entry.runtimeSymbols.length, 0);
  const typeOnlySymbolCount = plan.imports.reduce((count, entry) => count + entry.typeOnlySymbols.length, 0);
  const score = clampScore(
    0.92 -
      Math.max(0, touchedFiles.size - 1) * 0.02 +
      Math.min(0.04, plan.splitDeclarations * 0.01) +
      Math.min(0.03, runtimeSymbolCount * 0.005),
  );
  return {
    score,
    breakdown: [
      'base 0.92 for splitting mixed type/runtime imports without introducing a new file',
      touchedFiles.size > 1 ? `-0.02 for touching ${touchedFiles.size} files` : 'no penalty for single touched file',
      plan.splitDeclarations > 0
        ? `+${Math.min(0.04, plan.splitDeclarations * 0.01).toFixed(2)} for ${plan.splitDeclarations} split declaration(s)`
        : 'no split bonus',
      runtimeSymbolCount > 0
        ? `+${Math.min(0.03, runtimeSymbolCount * 0.005).toFixed(2)} for ${runtimeSymbolCount} runtime symbol(s) rewritten to a direct import`
        : 'no runtime rewrite bonus',
    ],
    signals: {
      touchedFiles: touchedFiles.size,
      importEdges: plan.imports.length,
      splitDeclarations: plan.splitDeclarations,
      runtimeSymbolCount,
      typeOnlySymbolCount,
      introducesNewFile: false,
      preservesSourceExports: true,
    },
  };
}

export function scoreDirectImportPlan(importPlans: DirectImportFixPlan['imports']): {
  score: number;
  breakdown: string[];
  signals: Record<string, StrategySignalValue>;
} {
  const touchedFiles = new Set(importPlans.map((plan) => plan.sourceFile));
  const seamBypassCount = importPlans.filter((plan) => {
    const normalizedBarrel = plan.barrelFile.toLowerCase();
    return (
      normalizedBarrel.includes('/api.') ||
      normalizedBarrel.startsWith('api.') ||
      normalizedBarrel.includes('/plugin-sdk/') ||
      normalizedBarrel.includes('/setup-surface.') ||
      normalizedBarrel.startsWith('setup-surface.') ||
      normalizedBarrel.includes('/setup-core.') ||
      normalizedBarrel.startsWith('setup-core.')
    );
  }).length;
  const score = clampScore(0.89 - Math.max(0, touchedFiles.size - 1) * 0.04);
  return {
    score,
    breakdown: [
      'base 0.89 for removing a barrel hop',
      touchedFiles.size > 1 ? `-0.04 for touching ${touchedFiles.size} files` : 'no penalty for single touched file',
      seamBypassCount > 0
        ? `semantic note: ${seamBypassCount} import(s) bypass a public re-export seam`
        : 'no public-seam bypass signal',
    ],
    signals: {
      touchedFiles: touchedFiles.size,
      importEdges: importPlans.length,
      introducesNewFile: false,
      preservesSourceExports: true,
      bypassesBarrel: true,
      bypassesPublicSeam: seamBypassCount > 0,
    },
  };
}

export function scorePublicSeamBypassPlan(importPlans: DirectImportFixPlan['imports']): {
  score: number;
  breakdown: string[];
  signals: Record<string, StrategySignalValue>;
} {
  const directImportScore = scoreDirectImportPlan(importPlans);
  const seamImports = importPlans.filter((plan) => {
    const normalizedBarrel = plan.barrelFile.toLowerCase();
    return (
      normalizedBarrel.includes('/api.') ||
      normalizedBarrel.startsWith('api.') ||
      normalizedBarrel.includes('/plugin-sdk/') ||
      normalizedBarrel.includes('/setup-surface.') ||
      normalizedBarrel.startsWith('setup-surface.') ||
      normalizedBarrel.includes('/setup-core.') ||
      normalizedBarrel.startsWith('setup-core.')
    );
  }).length;

  return {
    score: clampScore(directImportScore.score + (seamImports > 0 ? 0.05 : 0)),
    breakdown: [
      ...directImportScore.breakdown,
      seamImports > 0
        ? `+0.05 for ${seamImports} public-seam import(s) bypassing an API or setup surface`
        : 'no additional public-seam bonus',
    ],
    signals: {
      ...directImportScore.signals,
      publicSeamBypassImports: seamImports,
    },
  };
}

export function scoreExtractSharedPlan(plan: ExtractSharedFixPlan): {
  score: number;
  breakdown: string[];
  signals: Record<string, StrategySignalValue>;
} {
  const symbolNamedSharedFile = plan.symbols.length === 1 && path.basename(plan.sharedFile).includes(plan.symbols[0]);
  const setterLikeExtraction =
    plan.symbols.length === 1 && /^(set|update|apply|assign)[A-Z_]/.test(plan.symbols[0] ?? '');
  const score = clampScore(
    0.68 +
      (plan.preserveSourceExports ? 0.08 : 0) +
      (plan.symbols.length === 1 ? 0.06 : 0) +
      (symbolNamedSharedFile ? 0.04 : 0) -
      (setterLikeExtraction ? 0.05 : 0) -
      Math.max(0, plan.symbols.length - 1) * 0.03,
  );
  return {
    score,
    breakdown: [
      'base 0.68 for introducing a shared module',
      plan.preserveSourceExports ? '+0.08 for preserving the source module API' : 'no API-preservation bonus',
      plan.symbols.length === 1
        ? '+0.06 for single-symbol extraction'
        : `-${Math.max(0, plan.symbols.length - 1) * 0.03} for extracting multiple symbols`,
      symbolNamedSharedFile ? '+0.04 for a symbol-driven shared filename' : 'no filename clarity bonus',
      setterLikeExtraction
        ? '-0.05 because setter-like helpers usually read better as localized ownership updates'
        : 'no setter-localization penalty',
    ],
    signals: {
      touchedFiles: 3,
      symbolCount: plan.symbols.length,
      introducesNewFile: true,
      preservesSourceExports: plan.preserveSourceExports,
      setterLikeExtraction,
      sharedFile: plan.sharedFile,
      sourceFile: plan.sourceFile,
      targetFile: plan.targetFile,
    },
  };
}

export function scoreHostStateUpdatePlan(plan: HostStateUpdateFixPlan): {
  score: number;
  breakdown: string[];
  signals: Record<string, StrategySignalValue>;
} {
  const score = clampScore(0.87 + (plan.mirrorHostProperty ? 0.01 : 0) + (plan.trimValue ? 0.01 : 0));
  return {
    score,
    breakdown: [
      'base 0.87 for localizing a cross-module state setter without introducing a new file',
      plan.mirrorHostProperty ? '+0.01 for preserving a mirrored host field update' : 'no mirrored-host bonus',
      plan.trimValue ? '+0.01 for preserving value normalization in the localized helper' : 'no normalization bonus',
    ],
    signals: {
      touchedFiles: 1,
      introducesNewFile: false,
      preservesSourceExports: false,
      importedFunction: plan.importedFunction,
      persistenceFunction: plan.persistenceFunction,
      updatedProperty: plan.updatedProperty,
    },
  };
}

export function selectBestAttempt(attempts: StrategyAttempt[]): StrategyAttempt | undefined {
  return rankCandidateAttempts(attempts)[0];
}

export function rankCandidateAttempts(attempts: StrategyAttempt[]): StrategyAttempt[] {
  const rankedAttempts: StrategyAttempt[] = [];

  for (const attempt of attempts) {
    if (attempt.status !== 'candidate') {
      continue;
    }

    let insertAt = 0;
    while (insertAt < rankedAttempts.length && compareAttempts(rankedAttempts[insertAt], attempt) < 0) {
      insertAt += 1;
    }

    rankedAttempts.splice(insertAt, 0, attempt);
  }

  return rankedAttempts;
}

export function applyHistoricalEvidence(
  attempt: StrategyAttempt,
  features: CycleFeatureVector,
  historicalEvidence: HistoricalEvidenceSnapshot,
): StrategyAttempt {
  if (attempt.status !== 'candidate') {
    return attempt;
  }

  const evidence = historicalEvidence.strategies[attempt.strategy];
  if (!evidence) {
    return attempt;
  }

  const reviewedCount =
    evidence.approvedReviews + evidence.rejectedReviews + evidence.prCandidates + evidence.ignoredReviews;
  const validatedCount = evidence.passedValidations + evidence.failedValidations;
  const acceptanceReviewedCount = (evidence.acceptedBenchmarks ?? 0) + (evidence.rejectedBenchmarks ?? 0);
  const semanticWrongPenalty = Math.min(0.05, (evidence.semanticWrongRejections ?? 0) * 0.02);
  const noisyDiffRejections = (evidence.diffNoisyRejections ?? 0) + (evidence.repoConventionsMismatchRejections ?? 0);
  const structuralFailureCount =
    (evidence.originalCyclePersistedFailures ?? 0) + (evidence.newCyclesIntroducedFailures ?? 0);
  const validationFailureCount = (evidence.repoValidationFailures ?? 0) + (evidence.typecheckFailures ?? 0);
  const accumulator = {
    score: attempt.score ?? 0,
    breakdown: [...(attempt.scoreBreakdown ?? [])],
  };

  applyBenchmarkEvidence(accumulator, evidence);
  applyReviewEvidence(accumulator, evidence, reviewedCount);
  applyValidationEvidence(accumulator, evidence, validatedCount);
  applyAcceptanceEvidence(accumulator, evidence, acceptanceReviewedCount);
  applyPenaltyEvidence(accumulator, attempt, features, {
    semanticWrongPenalty,
    noisyDiffRejections,
    structuralFailureCount,
    validationFailureCount,
    validationWeakRejections: evidence.validationWeakRejections ?? 0,
  });
  applyFeatureBiases(accumulator, attempt, features);

  return {
    ...attempt,
    score: clampScore(accumulator.score),
    scoreBreakdown: accumulator.breakdown,
    signals: {
      ...attempt.signals,
      historicalBenchmarkMatches: evidence.benchmarkMatches,
      historicalPatternMatches: evidence.patternMatches ?? 0,
      historicalProfileMatches: evidence.profileMatches,
      historicalAcceptanceBenchmarks:
        (evidence.acceptedBenchmarks ?? 0) + (evidence.rejectedBenchmarks ?? 0) + (evidence.needsReviewBenchmarks ?? 0),
      historicalAcceptancePatternMatches: evidence.acceptancePatternMatches ?? 0,
      historicalReviewedPatches: reviewedCount,
      historicalValidatedPatches: validatedCount,
      historicalStructuralFailures: structuralFailureCount,
      historicalValidationFailures: validationFailureCount,
    },
  };
}

interface ScoreAccumulator {
  score: number;
  breakdown: string[];
}

function applyBenchmarkEvidence(
  accumulator: ScoreAccumulator,
  evidence: HistoricalEvidenceSnapshot['strategies'][PlanningStrategy],
): void {
  if (evidence.benchmarkMatches > 0) {
    const benchmarkBonus = Math.min(0.03, evidence.benchmarkMatches * 0.005);
    accumulator.score += benchmarkBonus;
    accumulator.breakdown.push(
      `+${benchmarkBonus.toFixed(2)} from ${evidence.benchmarkMatches} matching benchmark case(s)`,
    );
  }

  if ((evidence.patternMatches ?? 0) > 0) {
    const patternBonus = Math.min(0.04, (evidence.patternMatches ?? 0) * 0.01);
    accumulator.score += patternBonus;
    accumulator.breakdown.push(`+${patternBonus.toFixed(2)} from benchmark cases with matching graph-pattern labels`);
  }

  if (evidence.profileMatches > 0) {
    const profileBonus = Math.min(0.02, evidence.profileMatches * 0.01);
    accumulator.score += profileBonus;
    accumulator.breakdown.push(`+${profileBonus.toFixed(2)} from repository-profile matches in historical cases`);
  }

  if ((evidence.acceptanceProfileMatches ?? 0) > 0) {
    const acceptanceProfileBonus = Math.min(0.02, (evidence.acceptanceProfileMatches ?? 0) * 0.005);
    accumulator.score += acceptanceProfileBonus;
    accumulator.breakdown.push(
      `+${acceptanceProfileBonus.toFixed(2)} from acceptance benchmark cases with matching repo profiles`,
    );
  }

  if ((evidence.acceptancePatternMatches ?? 0) > 0) {
    const acceptancePatternBonus = Math.min(0.03, (evidence.acceptancePatternMatches ?? 0) * 0.01);
    accumulator.score += acceptancePatternBonus;
    accumulator.breakdown.push(
      `+${acceptancePatternBonus.toFixed(2)} from acceptance benchmark cases with matching graph-pattern labels`,
    );
  }
}

function applyReviewEvidence(
  accumulator: ScoreAccumulator,
  evidence: HistoricalEvidenceSnapshot['strategies'][PlanningStrategy],
  reviewedCount: number,
): void {
  if (reviewedCount === 0) {
    return;
  }

  const positiveReviewWeight = evidence.approvedReviews + evidence.prCandidates * 0.5;
  const approvalRatio = positiveReviewWeight / reviewedCount;
  const reviewDelta = clampSignedAdjustment((approvalRatio - 0.5) * 0.08, 0.04);
  if (reviewDelta === 0) {
    return;
  }

  accumulator.score += reviewDelta;
  accumulator.breakdown.push(
    `${formatSignedScore(reviewDelta)} from review outcomes (${reviewedCount} reviewed patch(es))`,
  );
}

function applyValidationEvidence(
  accumulator: ScoreAccumulator,
  evidence: HistoricalEvidenceSnapshot['strategies'][PlanningStrategy],
  validatedCount: number,
): void {
  if (validatedCount === 0) {
    return;
  }

  const validationRatio = evidence.passedValidations / validatedCount;
  const validationDelta = clampSignedAdjustment((validationRatio - 0.5) * 0.06, 0.03);
  if (validationDelta === 0) {
    return;
  }

  accumulator.score += validationDelta;
  accumulator.breakdown.push(
    `${formatSignedScore(validationDelta)} from validation history (${evidence.passedValidations}/${validatedCount} passed)`,
  );
}

function applyAcceptanceEvidence(
  accumulator: ScoreAccumulator,
  evidence: HistoricalEvidenceSnapshot['strategies'][PlanningStrategy],
  acceptanceReviewedCount: number,
): void {
  if (acceptanceReviewedCount === 0) {
    return;
  }

  const acceptanceRatio = (evidence.acceptedBenchmarks ?? 0) / acceptanceReviewedCount;
  const acceptanceDelta = clampSignedAdjustment((acceptanceRatio - 0.5) * 0.12, 0.06);
  if (acceptanceDelta === 0) {
    return;
  }

  accumulator.score += acceptanceDelta;
  accumulator.breakdown.push(
    `${formatSignedScore(acceptanceDelta)} from acceptance benchmark outcomes (${evidence.acceptedBenchmarks ?? 0}/${acceptanceReviewedCount} accepted)`,
  );
}

function applyPenaltyEvidence(
  accumulator: ScoreAccumulator,
  attempt: StrategyAttempt,
  features: CycleFeatureVector,
  penalties: {
    semanticWrongPenalty: number;
    noisyDiffRejections: number;
    structuralFailureCount: number;
    validationFailureCount: number;
    validationWeakRejections: number;
  },
): void {
  if (penalties.semanticWrongPenalty > 0) {
    accumulator.score -= penalties.semanticWrongPenalty;
    accumulator.breakdown.push(
      `-${penalties.semanticWrongPenalty.toFixed(2)} because similar fixes were marked semantically wrong`,
    );
  }

  if (
    (attempt.signals.introducesNewFile === true || attempt.strategy === 'extract_shared') &&
    penalties.noisyDiffRejections > 0
  ) {
    const noisyDiffPenalty = Math.min(0.03, penalties.noisyDiffRejections * 0.01);
    accumulator.score -= noisyDiffPenalty;
    accumulator.breakdown.push(
      `-${noisyDiffPenalty.toFixed(2)} because similar rewrites were rejected for noisy diffs or repo-convention mismatch`,
    );
  }

  if (penalties.validationWeakRejections > 0 && features.validationCommandCount > 0) {
    const validationWeakPenalty = Math.min(0.02, penalties.validationWeakRejections * 0.01);
    accumulator.score -= validationWeakPenalty;
    accumulator.breakdown.push(
      `-${validationWeakPenalty.toFixed(2)} because similar candidates were rejected for weak validation coverage`,
    );
  }

  if (penalties.structuralFailureCount > 0) {
    const structuralFailurePenalty = Math.min(0.04, penalties.structuralFailureCount * 0.01);
    accumulator.score -= structuralFailurePenalty;
    accumulator.breakdown.push(
      `-${structuralFailurePenalty.toFixed(2)} from replay history where the rewrite preserved or introduced cycles`,
    );
  }

  if (penalties.validationFailureCount > 0) {
    const validationFailurePenalty = Math.min(0.03, penalties.validationFailureCount * 0.01);
    accumulator.score -= validationFailurePenalty;
    accumulator.breakdown.push(
      `-${validationFailurePenalty.toFixed(2)} from replay history where repo validation or typecheck failed`,
    );
  }
}

function applyFeatureBiases(
  accumulator: ScoreAccumulator,
  attempt: StrategyAttempt,
  features: CycleFeatureVector,
): void {
  switch (attempt.strategy) {
    case 'direct_import': {
      applyDirectImportFeatureBiases(accumulator, features);
      break;
    }
    case 'extract_shared': {
      applyExtractSharedFeatureBiases(accumulator, features);
      break;
    }
    case 'host_state_update': {
      applyHostStateFeatureBiases(accumulator, features);
      break;
    }
    default: {
      break;
    }
  }
}

function applyDirectImportFeatureBiases(accumulator: ScoreAccumulator, features: CycleFeatureVector): void {
  if (features.hasBarrelFile) {
    accumulator.score += 0.01;
    accumulator.breakdown.push('+0.01 because the cycle already contains a barrel entrypoint');
  }

  if ((features.cyclePublicSeamEdgeCount ?? 0) > 0) {
    accumulator.score += 0.03;
    accumulator.breakdown.push('+0.03 because the cycle currently routes through a public API seam');
  }

  if ((features.exportEdgeCount ?? 0) > 0) {
    accumulator.score += 0.01;
    accumulator.breakdown.push('+0.01 because the cycle already exposes a re-export graph to simplify');
  }
}

function applyExtractSharedFeatureBiases(accumulator: ScoreAccumulator, features: CycleFeatureVector): void {
  if (features.validationCommandCount > 2) {
    accumulator.score -= 0.01;
    accumulator.breakdown.push('-0.01 because new shared modules are more fragile under heavier repo validation');
  }

  if ((features.cyclePublicSeamEdgeCount ?? 0) > 0) {
    accumulator.score -= 0.03;
    accumulator.breakdown.push('-0.03 because public seam cycles are usually cleaner as import-surface rewrites');
  }

  if ((features.ownershipLocalizationEdgeCount ?? 0) > 0) {
    accumulator.score -= 0.03;
    accumulator.breakdown.push('-0.03 because setter-shaped cycle edges are usually cleaner as ownership localization');
  }
}

function applyHostStateFeatureBiases(accumulator: ScoreAccumulator, features: CycleFeatureVector): void {
  if ((features.ownershipLocalizationEdgeCount ?? 0) > 0) {
    accumulator.score += 0.03;
    accumulator.breakdown.push('+0.03 because the cycle already includes setter-shaped ownership-localization edges');
  }

  if ((features.cyclePublicSeamEdgeCount ?? 0) > 0) {
    accumulator.score -= 0.02;
    accumulator.breakdown.push(
      '-0.02 because public seam cycles usually want import-surface rewrites, not localized setters',
    );
  }
}

export function createNotApplicableAttempt(
  strategy: PlanningStrategy,
  summary: string,
  signals: Record<string, StrategySignalValue>,
): StrategyAttempt {
  return {
    strategy,
    status: 'not_applicable',
    summary,
    reasons: [summary],
    signals,
  };
}

export function createRejectedAttempt(
  strategy: PlanningStrategy,
  summary: string,
  reasons: string[],
  signals: Record<string, StrategySignalValue>,
): StrategyAttempt {
  return {
    strategy,
    status: 'rejected',
    summary,
    reasons,
    signals,
  };
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}

function compareAttempts(left: StrategyAttempt, right: StrategyAttempt): number {
  const scoreDelta = (right.score ?? 0) - (left.score ?? 0);
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  return (right.confidence ?? 0) - (left.confidence ?? 0);
}

function clampSignedAdjustment(value: number, cap: number): number {
  return Number(Math.max(-cap, Math.min(cap, value)).toFixed(2));
}

function formatSignedScore(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
}
