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

export interface GraphModuleSummary {
  file: string;
  exportedSymbols: string[];
  localExportedSymbols: string[];
  movableSymbols: string[];
  moduleKind: 'declaration_only' | 'mixed' | 'pure_barrel';
  hasReExports: boolean;
  hasTopLevelSideEffects: boolean;
}

export interface GraphImportEdge {
  from: string;
  to: string;
  kind: 'side_effect' | 'type' | 'value';
  symbols: string[];
  withinCycle: boolean;
}

export interface GraphExportEdge {
  from: string;
  to: string;
  kind: 'named_reexport' | 'namespace_reexport';
  exportedName: string;
  localName: string | null;
}

export interface GraphSymbolNode {
  id: string;
  file: string;
  symbol: string;
  kind: 'class' | 'enum' | 'function' | 'interface' | 'type_alias' | 'variable';
  exported: boolean;
  movable: boolean;
}

export interface GraphSymbolEdge {
  from: string;
  to: string;
  kind: 'import' | 'reference';
}

export interface GraphExportResolution {
  barrelFile: string;
  exportedName: string;
  targetFile: string | null;
  targetSymbol: string | null;
  ambiguous: boolean;
}

export interface CycleGraphSummary {
  modules: GraphModuleSummary[];
  importEdges: GraphImportEdge[];
  exportEdges: GraphExportEdge[];
  symbolNodes: GraphSymbolNode[];
  symbolEdges: GraphSymbolEdge[];
  symbolSccs: string[][];
  exportResolutions: GraphExportResolution[];
  metrics: {
    moduleCount: number;
    importEdgeCount: number;
    exportEdgeCount: number;
    symbolNodeCount: number;
    symbolEdgeCount: number;
    symbolSccCount: number;
    barrelModuleCount: number;
    sideEffectModuleCount: number;
    movableSymbolCount: number;
  };
}

export interface PlannerRepositoryProfile {
  packageManager: 'bun' | 'npm' | 'pnpm' | 'unknown' | 'yarn';
  workspaceMode: 'single-package' | 'unknown' | 'workspace';
  validationCommandCount: number;
}

export interface CycleFeatureVector {
  cycleSize: number;
  cycleShape: 'two_file' | 'multi_file';
  explicitImportEdges: number;
  loadedFiles: number;
  missingFiles: number;
  hasBarrelFile: boolean;
  hasSharedModuleFile: boolean;
  typescriptFileCount: number;
  tsxFileCount: number;
  packageManager: PlannerRepositoryProfile['packageManager'];
  workspaceMode: PlannerRepositoryProfile['workspaceMode'];
  validationCommandCount: number;
  barrelModuleCount?: number;
  sideEffectModuleCount?: number;
  exportEdgeCount?: number;
  movableSymbolCount?: number;
  symbolNodeCount?: number;
  symbolEdgeCount?: number;
  symbolSccCount?: number;
}

export interface StrategyHistoricalEvidence {
  benchmarkMatches: number;
  profileMatches: number;
  approvedReviews: number;
  rejectedReviews: number;
  prCandidates: number;
  ignoredReviews: number;
  passedValidations: number;
  failedValidations: number;
  acceptedBenchmarks?: number;
  rejectedBenchmarks?: number;
  needsReviewBenchmarks?: number;
  acceptanceProfileMatches?: number;
  semanticWrongRejections?: number;
  repoConventionsMismatchRejections?: number;
  diffNoisyRejections?: number;
  validationWeakRejections?: number;
  otherRejections?: number;
  originalCyclePersistedFailures?: number;
  newCyclesIntroducedFailures?: number;
  repoValidationFailures?: number;
  typecheckFailures?: number;
}

export interface HistoricalEvidenceSnapshot {
  totalBenchmarkCases: number;
  totalAcceptanceBenchmarkCases: number;
  totalReviewedPatches: number;
  totalValidatedPatches: number;
  strategies: Record<PlanningStrategy, StrategyHistoricalEvidence>;
}

export const missingCycleFilesReason = 'Files participating in the cycle could not be read or found.';

export interface StrategyAttempt {
  strategy: PlanningStrategy;
  status: 'candidate' | 'rejected' | 'not_applicable';
  summary: string;
  reasons: string[];
  signals: Record<string, StrategySignalValue>;
  baseScore?: number;
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
  features: CycleFeatureVector;
  graphSummary?: CycleGraphSummary;
  fallbackClassification: Classification;
  fallbackConfidence: number;
  fallbackReasons: string[];
  selectedStrategy?: PlanningStrategy;
  selectedClassification?: Classification;
  selectedScore?: number;
  selectionSummary: string;
  rankedCandidates: StrategyAttempt[];
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
  ambiguousResolution?: boolean;
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
  repositoryProfile?: PlannerRepositoryProfile;
  historicalEvidence: HistoricalEvidenceSnapshot;
  graphSummary: CycleGraphSummary;
  features: CycleFeatureVector;
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
