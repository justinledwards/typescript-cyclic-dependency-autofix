import path from 'node:path';
import type { CycleFeatureVector, CycleGraphSummary, PlannerRepositoryProfile } from './types.js';

export function extractCycleFeatures(args: {
  uniqueFiles: string[];
  cycleShape: 'two_file' | 'multi_file';
  graphSummary: CycleGraphSummary;
  cycleSignals: {
    explicitImportEdges: number;
    loadedFiles: number;
    missingFiles: number;
  };
  repositoryProfile?: PlannerRepositoryProfile;
}): CycleFeatureVector {
  const { uniqueFiles, cycleShape, cycleSignals, graphSummary, repositoryProfile } = args;

  return {
    cycleSize: uniqueFiles.length,
    cycleShape,
    explicitImportEdges: cycleSignals.explicitImportEdges,
    loadedFiles: cycleSignals.loadedFiles,
    missingFiles: cycleSignals.missingFiles,
    hasBarrelFile: uniqueFiles.some((filePath) => /^index\.[cm]?[jt]sx?$/.test(path.basename(filePath))),
    hasSharedModuleFile: uniqueFiles.some((filePath) => filePath.includes('.shared.')),
    typescriptFileCount: uniqueFiles.filter((filePath) => /\.[cm]?tsx?$/.test(filePath)).length,
    tsxFileCount: uniqueFiles.filter((filePath) => /\.[cm]?tsx$/.test(filePath)).length,
    packageManager: repositoryProfile?.packageManager ?? 'unknown',
    workspaceMode: repositoryProfile?.workspaceMode ?? 'unknown',
    validationCommandCount: repositoryProfile?.validationCommandCount ?? 0,
    barrelModuleCount: graphSummary.metrics.barrelModuleCount,
    sideEffectModuleCount: graphSummary.metrics.sideEffectModuleCount,
    exportEdgeCount: graphSummary.metrics.exportEdgeCount,
    movableSymbolCount: graphSummary.metrics.movableSymbolCount,
    symbolNodeCount: graphSummary.metrics.symbolNodeCount,
    symbolEdgeCount: graphSummary.metrics.symbolEdgeCount,
    symbolSccCount: graphSummary.metrics.symbolSccCount,
  };
}
