import type { ImportDeclaration, SourceFile } from 'ts-morph';
import type { Classification } from '../../db/index.js';

export interface ImportTypeFixPlan {
  kind: 'import_type';
  imports: Array<{
    sourceFile: string;
    targetFile: string;
  }>;
}

export interface DirectImportFixPlan {
  kind: 'direct_import';
  imports: Array<{
    sourceFile: string;
    barrelFile: string;
    targetFile: string;
    symbols: string[];
  }>;
}

export interface ExtractSharedFixPlan {
  kind: 'extract_shared';
  sourceFile: string;
  targetFile: string;
  symbols: string[];
  sharedFile: string;
  preserveSourceExports: boolean;
}

export interface HostStateUpdateFixPlan {
  kind: 'host_state_update';
  sourceFile: string;
  targetFile: string;
  importedFunction: string;
  persistenceModule: string;
  persistenceModuleKind: 'package' | 'repo_file';
  persistenceFunction: string;
  stateObjectProperty: string;
  updatedProperty: string;
  mirrorHostProperty?: string;
  trimValue: boolean;
}

export type PlanningStrategy = 'import_type' | 'direct_import' | 'extract_shared' | 'host_state_update';
export type StrategySignalValue = boolean | number | string;

export const missingCycleFilesReason = 'Files participating in the cycle could not be read or found.';

export interface StrategyAttempt {
  strategy: PlanningStrategy;
  status: 'candidate' | 'rejected' | 'not_applicable';
  summary: string;
  reasons: string[];
  signals: Record<string, StrategySignalValue>;
  score?: number;
  scoreBreakdown?: string[];
  classification?: Classification;
  confidence?: number;
  plan?: ImportTypeFixPlan | DirectImportFixPlan | ExtractSharedFixPlan | HostStateUpdateFixPlan;
}

export interface CyclePlanningResult {
  cycleFiles: string[];
  cycleSize: number;
  cycleShape: 'two_file' | 'multi_file';
  cycleSignals: Record<string, StrategySignalValue>;
  fallbackClassification: Classification;
  fallbackConfidence: number;
  fallbackReasons: string[];
  selectedStrategy?: PlanningStrategy;
  selectedClassification?: Classification;
  selectedScore?: number;
  selectionSummary: string;
  attempts: StrategyAttempt[];
}

export interface SemanticAnalysisResult {
  classification: Classification;
  confidence: number;
  reasons: string[];
  plan?: ImportTypeFixPlan | DirectImportFixPlan | ExtractSharedFixPlan | HostStateUpdateFixPlan;
  upstreamabilityScore?: number;
  planner?: CyclePlanningResult;
}

export interface DirectImportSearchResult {
  plan?: DirectImportFixPlan['imports'];
  sawBarrelScenario: boolean;
}

export interface CyclePlanningContext {
  cyclePath: string[];
  uniqueFiles: string[];
  cycleShape: 'two_file' | 'multi_file';
  sourceFiles: Map<string, SourceFile | undefined>;
  importsAToB: ImportDeclaration[];
  importsBToA: ImportDeclaration[];
  cycleSignals: Record<string, StrategySignalValue>;
}

export interface StrategyDefinition {
  strategy: PlanningStrategy;
  describeApplicability: (context: CyclePlanningContext) => {
    applicable: boolean;
    summary: string;
    signals: Record<string, StrategySignalValue>;
  };
  evaluate: (context: CyclePlanningContext) => StrategyAttempt;
}
