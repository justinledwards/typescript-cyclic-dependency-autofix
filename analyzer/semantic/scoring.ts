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

export function scoreDirectImportPlan(importPlans: DirectImportFixPlan['imports']): {
  score: number;
  breakdown: string[];
  signals: Record<string, StrategySignalValue>;
} {
  const touchedFiles = new Set(importPlans.map((plan) => plan.sourceFile));
  const score = clampScore(0.89 - Math.max(0, touchedFiles.size - 1) * 0.04);
  return {
    score,
    breakdown: [
      'base 0.89 for removing a barrel hop',
      touchedFiles.size > 1 ? `-0.04 for touching ${touchedFiles.size} files` : 'no penalty for single touched file',
    ],
    signals: {
      touchedFiles: touchedFiles.size,
      importEdges: importPlans.length,
      introducesNewFile: false,
      preservesSourceExports: true,
      bypassesBarrel: true,
    },
  };
}

export function scoreExtractSharedPlan(plan: ExtractSharedFixPlan): {
  score: number;
  breakdown: string[];
  signals: Record<string, StrategySignalValue>;
} {
  const symbolNamedSharedFile = plan.symbols.length === 1 && path.basename(plan.sharedFile).includes(plan.symbols[0]);
  const score = clampScore(
    0.68 +
      (plan.preserveSourceExports ? 0.08 : 0) +
      (plan.symbols.length === 1 ? 0.06 : 0) +
      (symbolNamedSharedFile ? 0.04 : 0) -
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
    ],
    signals: {
      touchedFiles: 3,
      symbolCount: plan.symbols.length,
      introducesNewFile: true,
      preservesSourceExports: plan.preserveSourceExports,
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
  const score = clampScore(0.85 + (plan.mirrorHostProperty ? 0.01 : 0) + (plan.trimValue ? 0.01 : 0));
  return {
    score,
    breakdown: [
      'base 0.85 for removing a cross-module state setter without introducing a new file',
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

  let adjustedScore = attempt.score ?? 0;
  const breakdown = [...(attempt.scoreBreakdown ?? [])];

  if (evidence.benchmarkMatches > 0) {
    const benchmarkBonus = Math.min(0.03, evidence.benchmarkMatches * 0.005);
    adjustedScore += benchmarkBonus;
    breakdown.push(`+${benchmarkBonus.toFixed(2)} from ${evidence.benchmarkMatches} matching benchmark case(s)`);
  }

  if (evidence.profileMatches > 0) {
    const profileBonus = Math.min(0.02, evidence.profileMatches * 0.01);
    adjustedScore += profileBonus;
    breakdown.push(`+${profileBonus.toFixed(2)} from repository-profile matches in historical cases`);
  }

  const reviewedCount =
    evidence.approvedReviews + evidence.rejectedReviews + evidence.prCandidates + evidence.ignoredReviews;
  if (reviewedCount > 0) {
    const positiveReviewWeight = evidence.approvedReviews + evidence.prCandidates * 0.5;
    const approvalRatio = positiveReviewWeight / reviewedCount;
    const reviewDelta = clampSignedAdjustment((approvalRatio - 0.5) * 0.08, 0.04);
    if (reviewDelta !== 0) {
      adjustedScore += reviewDelta;
      breakdown.push(`${formatSignedScore(reviewDelta)} from review outcomes (${reviewedCount} reviewed patch(es))`);
    }
  }

  const validatedCount = evidence.passedValidations + evidence.failedValidations;
  if (validatedCount > 0) {
    const validationRatio = evidence.passedValidations / validatedCount;
    const validationDelta = clampSignedAdjustment((validationRatio - 0.5) * 0.06, 0.03);
    if (validationDelta !== 0) {
      adjustedScore += validationDelta;
      breakdown.push(
        `${formatSignedScore(validationDelta)} from validation history (${evidence.passedValidations}/${validatedCount} passed)`,
      );
    }
  }

  if (attempt.strategy === 'direct_import' && features.hasBarrelFile) {
    adjustedScore += 0.01;
    breakdown.push('+0.01 because the cycle already contains a barrel entrypoint');
  }

  if (attempt.strategy === 'extract_shared' && features.validationCommandCount > 2) {
    adjustedScore -= 0.01;
    breakdown.push('-0.01 because new shared modules are more fragile under heavier repo validation');
  }

  return {
    ...attempt,
    score: clampScore(adjustedScore),
    scoreBreakdown: breakdown,
    signals: {
      ...attempt.signals,
      historicalBenchmarkMatches: evidence.benchmarkMatches,
      historicalProfileMatches: evidence.profileMatches,
      historicalReviewedPatches: reviewedCount,
      historicalValidatedPatches: validatedCount,
    },
  };
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
