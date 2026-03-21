import path from 'node:path';
import type {
  DirectImportFixPlan,
  ExtractSharedFixPlan,
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
  let bestAttempt: StrategyAttempt | undefined;

  for (const attempt of attempts) {
    if (attempt.status !== 'candidate') {
      continue;
    }

    if (!bestAttempt) {
      bestAttempt = attempt;
      continue;
    }

    const scoreDelta = (attempt.score ?? 0) - (bestAttempt.score ?? 0);
    const confidenceDelta = (attempt.confidence ?? 0) - (bestAttempt.confidence ?? 0);

    if (scoreDelta > 0 || (scoreDelta === 0 && confidenceDelta > 0)) {
      bestAttempt = attempt;
    }
  }

  return bestAttempt;
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
