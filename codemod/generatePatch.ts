import path from 'node:path';
import { type ImportDeclaration, Project, type SourceFile } from 'ts-morph';
import type { CircularDependency } from '../analyzer/analyzer.js';
import type {
  DirectImportFixPlan,
  ExtractSharedFixPlan,
  ImportTypeFixPlan,
  SemanticAnalysisResult,
} from '../analyzer/semantic.js';

export interface GeneratedPatch {
  patchText: string;
  touchedFiles: string[];
  validationStatus: string;
  validationSummary: string;
}

interface FileSnapshot {
  path: string;
  before: string;
  after: string;
}

export async function generatePatchForCycle(
  repoPath: string,
  _cycle: CircularDependency,
  analysis: SemanticAnalysisResult,
): Promise<GeneratedPatch | null> {
  if (!analysis.plan) {
    return null;
  }

  if (analysis.plan.kind === 'import_type') {
    return generateImportTypePatch(repoPath, analysis.plan);
  }

  if (analysis.plan.kind === 'direct_import') {
    return generateDirectImportPatch(repoPath, analysis.plan);
  }

  if (analysis.plan.kind === 'extract_shared') {
    return generateExtractSharedPatch(repoPath, analysis.plan);
  }

  return null;
}

async function generateImportTypePatch(repoPath: string, plan: ImportTypeFixPlan): Promise<GeneratedPatch | null> {
  const project = createProject();
  const touchedFiles = new Map<string, FileSnapshot>();

  for (const importPlan of plan.imports) {
    const sourceFile = getProjectSourceFile(project, repoPath, importPlan.sourceFile);
    const targetPath = path.resolve(repoPath, importPlan.targetFile);
    const before = sourceFile.getFullText();

    let changed = false;
    for (const importDecl of sourceFile.getImportDeclarations()) {
      if (!resolvesToFile(repoPath, sourceFile, importDecl.getModuleSpecifierValue(), targetPath)) {
        continue;
      }

      if (
        importDecl.getDefaultImport() ||
        importDecl.getNamespaceImport() ||
        importDecl.getNamedImports().length === 0
      ) {
        continue;
      }

      if (!importDecl.isTypeOnly()) {
        importDecl.setIsTypeOnly(true);
        changed = true;
      }
    }

    if (!changed) {
      continue;
    }

    touchedFiles.set(importPlan.sourceFile, {
      path: importPlan.sourceFile,
      before,
      after: sourceFile.getFullText(),
    });
  }

  if (touchedFiles.size === 0) {
    return null;
  }

  return {
    patchText: buildPatchText([...touchedFiles.values()]),
    touchedFiles: [...touchedFiles.keys()],
    validationStatus: 'pending',
    validationSummary: 'Generated import-type patch candidate. Validation has not run yet.',
  };
}

async function generateExtractSharedPatch(
  repoPath: string,
  plan: ExtractSharedFixPlan,
): Promise<GeneratedPatch | null> {
  if (plan.symbols.length === 0) {
    return null;
  }

  const project = createProject();
  const sourceFile = getProjectSourceFile(project, repoPath, plan.sourceFile);
  const targetFile = getProjectSourceFile(project, repoPath, plan.targetFile);
  const sharedFilePath = chooseSharedFilePath(repoPath, plan.sourceFile, plan.targetFile);
  const sharedRelativePath = path.relative(repoPath, sharedFilePath).split(path.sep).join('/');

  const sourceBefore = sourceFile.getFullText();
  const targetBefore = targetFile.getFullText();
  const extractedDeclarations: string[] = [];
  const extractedNames = new Set(plan.symbols);

  for (const symbol of plan.symbols) {
    const declaration = findExtractableDeclaration(sourceFile, symbol);
    if (!declaration) {
      return null;
    }

    extractedDeclarations.push(declaration.getText());
    declaration.remove();
  }

  cleanupImports(targetFile, plan.sourceFile, extractedNames, repoPath);
  cleanupImports(sourceFile, plan.targetFile, extractedNames, repoPath);

  const sharedImportSpecifier = moduleSpecifierForFile(
    path.dirname(path.resolve(repoPath, plan.targetFile)),
    sharedFilePath,
  );
  const sharedImportSpecifierFromSource = moduleSpecifierForFile(
    path.dirname(path.resolve(repoPath, plan.sourceFile)),
    sharedFilePath,
  );

  addNamedImport(targetFile, sharedImportSpecifier, plan.symbols);
  addNamedImport(sourceFile, sharedImportSpecifierFromSource, plan.symbols);
  addNamedExport(sourceFile, sharedImportSpecifierFromSource, plan.symbols);

  const extension = path.extname(sharedFilePath);
  const sharedFile = project.createSourceFile(sharedFilePath, `${extractedDeclarations.join('\n\n')}\n`, {
    overwrite: true,
  });

  if (extension === '.tsx') {
    sharedFile.formatText();
  }

  const snapshots: FileSnapshot[] = [
    {
      path: plan.sourceFile,
      before: sourceBefore,
      after: sourceFile.getFullText(),
    },
    {
      path: plan.targetFile,
      before: targetBefore,
      after: targetFile.getFullText(),
    },
    {
      path: sharedRelativePath,
      before: '',
      after: sharedFile.getFullText(),
    },
  ];

  return {
    patchText: buildPatchText(snapshots),
    touchedFiles: snapshots.map((snapshot) => snapshot.path),
    validationStatus: 'pending',
    validationSummary: 'Generated shared-file extraction candidate. Validation has not run yet.',
  };
}

async function generateDirectImportPatch(repoPath: string, plan: DirectImportFixPlan): Promise<GeneratedPatch | null> {
  const project = createProject();
  const touchedFiles = new Map<string, FileSnapshot>();

  for (const importPlan of plan.imports) {
    const snapshot = rewriteDirectImportPlanEntry(project, repoPath, importPlan);
    if (!snapshot) {
      continue;
    }

    touchedFiles.set(importPlan.sourceFile, snapshot);
  }

  if (touchedFiles.size === 0) {
    return null;
  }

  return {
    patchText: buildPatchText([...touchedFiles.values()]),
    touchedFiles: [...touchedFiles.keys()],
    validationStatus: 'pending',
    validationSummary: 'Generated direct-import patch candidate. Validation has not run yet.',
  };
}

function rewriteDirectImportPlanEntry(
  project: Project,
  repoPath: string,
  importPlan: DirectImportFixPlan['imports'][number],
): FileSnapshot | undefined {
  const sourceFile = getProjectSourceFile(project, repoPath, importPlan.sourceFile);
  const barrelPath = path.resolve(repoPath, importPlan.barrelFile);
  const targetPath = path.resolve(repoPath, importPlan.targetFile);
  const before = sourceFile.getFullText();
  let changed = false;

  for (const importDecl of sourceFile.getImportDeclarations()) {
    if (!matchesDirectImportDeclaration(repoPath, sourceFile, importDecl, barrelPath, importPlan.symbols)) {
      continue;
    }

    importDecl.setModuleSpecifier(moduleSpecifierForFile(path.dirname(sourceFile.getFilePath()), targetPath));
    changed = true;
  }

  if (!changed) {
    return undefined;
  }

  return {
    path: importPlan.sourceFile,
    before,
    after: sourceFile.getFullText(),
  };
}

function matchesDirectImportDeclaration(
  repoPath: string,
  sourceFile: SourceFile,
  importDecl: ImportDeclaration,
  barrelPath: string,
  symbols: string[],
): boolean {
  if (!resolvesToFile(repoPath, sourceFile, importDecl.getModuleSpecifierValue(), barrelPath)) {
    return false;
  }

  if (importDecl.getDefaultImport() || importDecl.getNamespaceImport() || importDecl.getNamedImports().length === 0) {
    return false;
  }

  const importedNames = importDecl.getNamedImports().map((namedImport) => namedImport.getName());
  if (importedNames.length !== symbols.length) {
    return false;
  }

  const importedNameSet = new Set(importedNames);
  return symbols.every((symbol) => importedNameSet.has(symbol));
}

function createProject() {
  return new Project({
    compilerOptions: {
      allowJs: true,
      jsx: 2,
      resolveJsonModule: true,
    },
    skipAddingFilesFromTsConfig: true,
  });
}

function getProjectSourceFile(project: Project, repoPath: string, relativeFilePath: string): SourceFile {
  const absolutePath = path.resolve(repoPath, relativeFilePath);
  return project.addSourceFileAtPath(absolutePath);
}

function resolvesToFile(
  repoPath: string,
  sourceFile: SourceFile,
  moduleSpecifier: string,
  targetFilePath: string,
): boolean {
  if (!moduleSpecifier.startsWith('.') && !path.isAbsolute(moduleSpecifier)) {
    return false;
  }

  const sourceDir = path.dirname(sourceFile.getFilePath());
  const resolvedPath = path.isAbsolute(moduleSpecifier) ? moduleSpecifier : path.resolve(sourceDir, moduleSpecifier);

  const normalizedTarget = stripKnownExtensions(path.resolve(repoPath, targetFilePath));
  return stripKnownExtensions(resolvedPath) === normalizedTarget;
}

function stripKnownExtensions(filePath: string): string {
  return filePath.replace(/\.(ts|tsx|js|jsx)$/, '');
}

function buildPatchText(snapshots: FileSnapshot[]): string {
  return snapshots
    .filter((snapshot) => snapshot.before !== snapshot.after)
    .map((snapshot) => createUnifiedPatch(snapshot))
    .join('\n');
}

function createUnifiedPatch(snapshot: FileSnapshot): string {
  const beforeLines = snapshot.before.split('\n');
  const afterLines = snapshot.after.split('\n');

  return [
    `--- a/${snapshot.path}`,
    `+++ b/${snapshot.path}`,
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ].join('\n');
}

function chooseSharedFilePath(repoPath: string, sourceFile: string, targetFile: string): string {
  const sourceDir = path.dirname(path.resolve(repoPath, sourceFile));
  const sourceExt = path.extname(sourceFile);
  const targetExt = path.extname(targetFile);
  const preferredExt = sourceExt === targetExt ? sourceExt : '.ts';
  const sourceStem = path.basename(sourceFile, sourceExt);
  const targetStem = path.basename(targetFile, targetExt);

  return path.join(sourceDir, `${sourceStem}-${targetStem}.shared${preferredExt}`);
}

function findExtractableDeclaration(sourceFile: SourceFile, symbol: string) {
  return (
    sourceFile.getInterface(symbol) ||
    sourceFile.getTypeAlias(symbol) ||
    sourceFile.getFunction(symbol) ||
    sourceFile.getVariableDeclaration(symbol)?.getVariableStatement()
  );
}

function cleanupImports(sourceFile: SourceFile, targetFile: string, extractedNames: Set<string>, repoPath: string) {
  const targetPath = path.resolve(repoPath, targetFile);

  for (const importDecl of sourceFile.getImportDeclarations()) {
    if (!resolvesToFile(repoPath, sourceFile, importDecl.getModuleSpecifierValue(), targetPath)) {
      continue;
    }

    for (const namedImport of importDecl.getNamedImports()) {
      if (extractedNames.has(namedImport.getName())) {
        namedImport.remove();
      }
    }

    if (
      importDecl.getNamedImports().length === 0 &&
      !importDecl.getDefaultImport() &&
      !importDecl.getNamespaceImport()
    ) {
      importDecl.remove();
    }
  }
}

function addNamedImport(sourceFile: SourceFile, moduleSpecifier: string, names: string[]) {
  const existingImport = sourceFile
    .getImportDeclarations()
    .find((importDecl) => importDecl.getModuleSpecifierValue() === moduleSpecifier);

  if (existingImport) {
    const existingNames = new Set(existingImport.getNamedImports().map((namedImport) => namedImport.getName()));
    for (const name of names) {
      if (!existingNames.has(name)) {
        existingImport.addNamedImport(name);
      }
    }
    return;
  }

  sourceFile.addImportDeclaration({
    moduleSpecifier,
    namedImports: names,
  });
}

function addNamedExport(sourceFile: SourceFile, moduleSpecifier: string, names: string[]) {
  const existingExport = sourceFile
    .getExportDeclarations()
    .find((exportDecl) => exportDecl.getModuleSpecifierValue() === moduleSpecifier);

  if (existingExport) {
    const existingNames = new Set(existingExport.getNamedExports().map((namedExport) => namedExport.getName()));
    for (const name of names) {
      if (!existingNames.has(name)) {
        existingExport.addNamedExport(name);
      }
    }
    return;
  }

  sourceFile.addExportDeclaration({
    moduleSpecifier,
    namedExports: names,
  });
}

function moduleSpecifierForFile(fromDir: string, toFile: string): string {
  const relativePath = path.relative(fromDir, toFile).split(path.sep).join('/');
  const withoutExtension = relativePath.replace(/\.(ts|tsx|js|jsx)$/, '');
  return withoutExtension.startsWith('.') ? withoutExtension : `./${withoutExtension}`;
}
