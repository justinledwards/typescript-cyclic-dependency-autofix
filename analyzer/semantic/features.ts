import path from 'node:path';
import type { CycleFeatureVector, PlannerRepositoryProfile } from './types.js';

export function extractCycleFeatures(args: {
  uniqueFiles: string[];
  cycleShape: 'two_file' | 'multi_file';
  cycleSignals: {
    explicitImportEdges: number;
    loadedFiles: number;
    missingFiles: number;
  };
  repositoryProfile?: PlannerRepositoryProfile;
}): CycleFeatureVector {
  const { uniqueFiles, cycleShape, cycleSignals, repositoryProfile } = args;

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
  };
}
