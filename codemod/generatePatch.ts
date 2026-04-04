import path from 'node:path';
import { type ImportDeclaration, type ImportSpecifier, Node, Project, type SourceFile, SyntaxKind } from 'ts-morph';
import type { CircularDependency } from '../analyzer/analyzer.js';
import type {
  DirectImportFixPlan,
  ExtractSharedFixPlan,
  HostStateUpdateFixPlan,
  ImportTypeFixPlan,
  PublicSeamBypassFixPlan,
  SemanticAnalysisResult,
  TypeRuntimeSplitFixPlan,
} from '../analyzer/semantic.js';

export interface GeneratedPatch {
  patchText: string;
  touchedFiles: string[];
  validationStatus: string;
  validationSummary: string;
  fileSnapshots: FileSnapshot[];
}

export interface FileSnapshot {
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

  if (analysis.plan.kind === 'type_runtime_split') {
    return generateTypeRuntimeSplitPatch(repoPath, analysis.plan);
  }

  if (analysis.plan.kind === 'direct_import') {
    return generateDirectImportPatch(repoPath, analysis.plan);
  }

  if (analysis.plan.kind === 'public_seam_bypass') {
    return generatePublicSeamBypassPatch(repoPath, analysis.plan);
  }

  if (analysis.plan.kind === 'extract_shared') {
    return generateExtractSharedPatch(repoPath, analysis.plan);
  }

  if (analysis.plan.kind === 'host_state_update') {
    return generateHostStateUpdatePatch(repoPath, analysis.plan);
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
    fileSnapshots: [...touchedFiles.values()],
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
  const sharedFilePath = path.resolve(repoPath, plan.sharedFile);
  const sharedRelativePath = plan.sharedFile;

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
  if (sourceFileNeedsSharedImport(sourceFile, plan.symbols)) {
    addNamedImport(sourceFile, sharedImportSpecifierFromSource, plan.symbols);
  }
  if (plan.preserveSourceExports) {
    addNamedExport(sourceFile, sharedImportSpecifierFromSource, plan.symbols);
  }

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
    fileSnapshots: snapshots,
  };
}

async function generateDirectImportPatch(repoPath: string, plan: DirectImportFixPlan): Promise<GeneratedPatch | null> {
  return generateDirectImportLikePatch(
    repoPath,
    plan.imports,
    'Generated direct-import patch candidate. Validation has not run yet.',
  );
}

async function generatePublicSeamBypassPatch(
  repoPath: string,
  plan: PublicSeamBypassFixPlan,
): Promise<GeneratedPatch | null> {
  return generateDirectImportLikePatch(
    repoPath,
    plan.imports,
    'Generated public-seam bypass patch candidate. Validation has not run yet.',
  );
}

async function generateTypeRuntimeSplitPatch(
  repoPath: string,
  plan: TypeRuntimeSplitFixPlan,
): Promise<GeneratedPatch | null> {
  const project = createProject();
  const touchedFiles = new Map<string, FileSnapshot>();

  for (const importPlan of plan.imports) {
    const snapshot = rewriteTypeRuntimeSplitPlanEntry(project, repoPath, importPlan);
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
    validationSummary: 'Generated mixed type/runtime split patch candidate. Validation has not run yet.',
    fileSnapshots: [...touchedFiles.values()],
  };
}

async function generateHostStateUpdatePatch(
  repoPath: string,
  plan: HostStateUpdateFixPlan,
): Promise<GeneratedPatch | null> {
  const project = createProject();
  const sourceFile = getProjectSourceFile(project, repoPath, plan.sourceFile);
  const before = sourceFile.getFullText();
  const targetPath = path.resolve(repoPath, plan.targetFile);

  if (sourceFile.getFunctions().some((declaration) => declaration.getName() === plan.importedFunction)) {
    return null;
  }

  let removedImport = false;
  for (const importDecl of sourceFile.getImportDeclarations()) {
    if (!resolvesToFile(repoPath, sourceFile, importDecl.getModuleSpecifierValue(), targetPath)) {
      continue;
    }

    for (const namedImport of importDecl.getNamedImports()) {
      const localName = namedImport.getAliasNode()?.getText() ?? namedImport.getName();
      if (localName === plan.importedFunction) {
        namedImport.remove();
        removedImport = true;
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

  if (!removedImport) {
    return null;
  }

  const persistenceModuleSpecifier =
    plan.persistenceModuleKind === 'repo_file'
      ? moduleSpecifierForFile(path.dirname(sourceFile.getFilePath()), path.resolve(repoPath, plan.persistenceModule))
      : plan.persistenceModule;
  addNamedImport(sourceFile, persistenceModuleSpecifier, [plan.persistenceFunction]);

  insertHelperAfterImports(sourceFile, buildHostStateUpdateHelper(plan));

  return {
    patchText: buildPatchText([
      {
        path: plan.sourceFile,
        before,
        after: sourceFile.getFullText(),
      },
    ]),
    touchedFiles: [plan.sourceFile],
    validationStatus: 'pending',
    validationSummary: 'Generated localized host-state update candidate. Validation has not run yet.',
    fileSnapshots: [
      {
        path: plan.sourceFile,
        before,
        after: sourceFile.getFullText(),
      },
    ],
  };
}

async function generateDirectImportLikePatch(
  repoPath: string,
  importPlans: DirectImportFixPlan['imports'],
  validationSummary: string,
): Promise<GeneratedPatch | null> {
  const project = createProject();
  const touchedFiles = new Map<string, FileSnapshot>();

  for (const importPlan of importPlans) {
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
    validationSummary,
    fileSnapshots: [...touchedFiles.values()],
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

function rewriteTypeRuntimeSplitPlanEntry(
  project: Project,
  repoPath: string,
  importPlan: TypeRuntimeSplitFixPlan['imports'][number],
): FileSnapshot | undefined {
  const sourceFile = getProjectSourceFile(project, repoPath, importPlan.sourceFile);
  const barrelPath = path.resolve(repoPath, importPlan.barrelFile);
  const targetPath = path.resolve(repoPath, importPlan.targetFile);
  const before = sourceFile.getFullText();
  let changed = false;

  const typeOnlySymbolSet = new Set(importPlan.typeOnlySymbols);
  const runtimeSymbolSet = new Set(importPlan.runtimeSymbols);

  for (const importDecl of sourceFile.getImportDeclarations()) {
    if (
      rewriteTypeRuntimeSplitImportDeclaration(
        repoPath,
        sourceFile,
        importDecl,
        barrelPath,
        targetPath,
        typeOnlySymbolSet,
        runtimeSymbolSet,
      )
    ) {
      changed = true;
    }
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

function buildImportClauseText(
  clauseKind: 'import' | 'import type',
  namedImports: string[],
  moduleSpecifier: string,
): string {
  return `${clauseKind} { ${namedImports.join(', ')} } from '${moduleSpecifier}';`;
}

function formatNamedImportSpecifier(namedImport: ImportSpecifier): string {
  return namedImport.getText().replace(/^type\s+/, '');
}

function rewriteTypeRuntimeSplitImportDeclaration(
  repoPath: string,
  sourceFile: SourceFile,
  importDecl: ImportDeclaration,
  barrelPath: string,
  targetPath: string,
  typeOnlySymbolSet: Set<string>,
  runtimeSymbolSet: Set<string>,
): boolean {
  if (!resolvesToFile(repoPath, sourceFile, importDecl.getModuleSpecifierValue(), barrelPath)) {
    return false;
  }

  if (importDecl.getDefaultImport() || importDecl.getNamespaceImport()) {
    return false;
  }

  const namedImports = importDecl.getNamedImports();
  const typeOnlyNamedImports = namedImports.filter((namedImport) => typeOnlySymbolSet.has(namedImport.getName()));
  const runtimeNamedImports = namedImports.filter((namedImport) => runtimeSymbolSet.has(namedImport.getName()));

  if (typeOnlyNamedImports.length === 0 && runtimeNamedImports.length === 0) {
    return false;
  }

  const typeOnlyImportText =
    typeOnlyNamedImports.length > 0
      ? buildImportClauseText(
          'import type',
          typeOnlyNamedImports.map((namedImport) => formatNamedImportSpecifier(namedImport)),
          moduleSpecifierForFile(path.dirname(sourceFile.getFilePath()), barrelPath),
        )
      : '';
  const runtimeImportText =
    runtimeNamedImports.length > 0
      ? buildImportClauseText(
          'import',
          runtimeNamedImports.map((namedImport) => formatNamedImportSpecifier(namedImport)),
          moduleSpecifierForFile(path.dirname(sourceFile.getFilePath()), targetPath),
        )
      : '';

  if (typeOnlyNamedImports.length > 0 && runtimeNamedImports.length > 0) {
    importDecl.replaceWithText([typeOnlyImportText, runtimeImportText].filter(Boolean).join('\n'));
    return true;
  }

  if (typeOnlyNamedImports.length > 0) {
    importDecl.setIsTypeOnly(true);
    return true;
  }

  if (runtimeNamedImports.length > 0) {
    importDecl.setModuleSpecifier(moduleSpecifierForFile(path.dirname(sourceFile.getFilePath()), targetPath));
    return true;
  }

  return false;
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
  const beforeLines = splitPatchLines(snapshot.before);
  const afterLines = splitPatchLines(snapshot.after);
  const operations = diffPatchLines(beforeLines, afterLines);
  const hunks = buildUnifiedDiffHunks(operations);

  return [`--- a/${snapshot.path}`, `+++ b/${snapshot.path}`, ...hunks].join('\n');
}

type DiffOperation =
  | { type: 'context'; line: string; beforeLineNumber: number; afterLineNumber: number }
  | { type: 'delete'; line: string; beforeLineNumber: number }
  | { type: 'add'; line: string; afterLineNumber: number };

function splitPatchLines(text: string): string[] {
  const normalized = text.replaceAll('\r\n', '\n');
  const lines = normalized.split('\n');

  if (normalized.endsWith('\n')) {
    lines.pop();
  }

  return lines;
}

function diffPatchLines(beforeLines: string[], afterLines: string[]): DiffOperation[] {
  const lcsLengths = Array.from({ length: beforeLines.length + 1 }, () =>
    Array.from({ length: afterLines.length + 1 }, () => 0),
  );

  for (let beforeIndex = beforeLines.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = afterLines.length - 1; afterIndex >= 0; afterIndex -= 1) {
      lcsLengths[beforeIndex][afterIndex] =
        beforeLines[beforeIndex] === afterLines[afterIndex]
          ? lcsLengths[beforeIndex + 1][afterIndex + 1] + 1
          : Math.max(lcsLengths[beforeIndex + 1][afterIndex], lcsLengths[beforeIndex][afterIndex + 1]);
    }
  }

  const operations: DiffOperation[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  let beforeLineNumber = 1;
  let afterLineNumber = 1;

  while (beforeIndex < beforeLines.length && afterIndex < afterLines.length) {
    if (beforeLines[beforeIndex] === afterLines[afterIndex]) {
      operations.push({
        type: 'context',
        line: beforeLines[beforeIndex],
        beforeLineNumber,
        afterLineNumber,
      });
      beforeIndex += 1;
      afterIndex += 1;
      beforeLineNumber += 1;
      afterLineNumber += 1;
      continue;
    }

    if (lcsLengths[beforeIndex + 1][afterIndex] >= lcsLengths[beforeIndex][afterIndex + 1]) {
      operations.push({
        type: 'delete',
        line: beforeLines[beforeIndex],
        beforeLineNumber,
      });
      beforeIndex += 1;
      beforeLineNumber += 1;
      continue;
    }

    operations.push({
      type: 'add',
      line: afterLines[afterIndex],
      afterLineNumber,
    });
    afterIndex += 1;
    afterLineNumber += 1;
  }

  while (beforeIndex < beforeLines.length) {
    operations.push({
      type: 'delete',
      line: beforeLines[beforeIndex],
      beforeLineNumber,
    });
    beforeIndex += 1;
    beforeLineNumber += 1;
  }

  while (afterIndex < afterLines.length) {
    operations.push({
      type: 'add',
      line: afterLines[afterIndex],
      afterLineNumber,
    });
    afterIndex += 1;
    afterLineNumber += 1;
  }

  return operations;
}

function buildUnifiedDiffHunks(operations: DiffOperation[], contextLines = 3): string[] {
  const hunks: string[] = [];
  let operationIndex = 0;

  while (operationIndex < operations.length) {
    while (operationIndex < operations.length && operations[operationIndex].type === 'context') {
      operationIndex += 1;
    }

    if (operationIndex >= operations.length) {
      break;
    }

    const hunkStartIndex = Math.max(0, operationIndex - contextLines);
    let hunkEndIndex = operationIndex;
    let lastChangedIndex = operationIndex;

    while (hunkEndIndex < operations.length) {
      if (operations[hunkEndIndex].type !== 'context') {
        lastChangedIndex = hunkEndIndex;
      }

      if (hunkEndIndex - lastChangedIndex > contextLines) {
        break;
      }

      hunkEndIndex += 1;
    }

    const hunkOperations = operations.slice(
      hunkStartIndex,
      Math.min(operations.length, lastChangedIndex + contextLines + 1),
    );
    hunks.push(formatUnifiedDiffHunk(hunkOperations));
    operationIndex = lastChangedIndex + contextLines + 1;
  }

  return hunks;
}

function formatUnifiedDiffHunk(operations: DiffOperation[]): string {
  const beforeLines = operations.filter((operation) => operation.type !== 'add');
  const afterLines = operations.filter((operation) => operation.type !== 'delete');
  const beforeStart = beforeLines[0]?.beforeLineNumber ?? 0;
  const afterStart = afterLines[0]?.afterLineNumber ?? 0;

  return [
    `@@ -${beforeStart},${beforeLines.length} +${afterStart},${afterLines.length} @@`,
    ...operations.map((operation) => {
      if (operation.type === 'context') {
        return ` ${operation.line}`;
      }

      if (operation.type === 'delete') {
        return `-${operation.line}`;
      }

      return `+${operation.line}`;
    }),
  ].join('\n');
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

function sourceFileNeedsSharedImport(sourceFile: SourceFile, symbols: string[]): boolean {
  const extractedNameSet = new Set(symbols);
  return sourceFile
    .getDescendantsOfKind(SyntaxKind.Identifier)
    .some((identifier) => extractedNameSet.has(identifier.getText()));
}

function insertHelperAfterImports(sourceFile: SourceFile, helperText: string) {
  const statements = sourceFile.getStatements();
  const importStatementCount = statements.filter((statement) => Node.isImportDeclaration(statement)).length;
  sourceFile.insertStatements(importStatementCount, `\n${helperText}\n`);
}

function buildHostStateUpdateHelper(plan: HostStateUpdateFixPlan): string {
  const normalizedValueName = plan.trimValue ? 'trimmed' : 'next';
  const hostPropertyGuard = plan.mirrorHostProperty ? ` || !('${plan.mirrorHostProperty}' in host)` : '';
  const mirrorHostTypeSegment = plan.mirrorHostProperty ? `; ${plan.mirrorHostProperty}: string` : '';
  const stateType = `{ ${plan.updatedProperty}: string } & Record<string, unknown>`;
  const hostType = `{ ${plan.stateObjectProperty}: ${stateType}${mirrorHostTypeSegment} } & Record<string, unknown>`;
  const lines = [
    `function ${plan.importedFunction}(host: unknown, next: string) {`,
    `  if (!host || typeof host !== 'object') {`,
    `    return;`,
    `  }`,
    `  if (!('${plan.stateObjectProperty}' in host)${hostPropertyGuard}) {`,
    `    return;`,
    `  }`,
    `  const settingsHost = host as ${hostType};`,
  ];

  if (plan.trimValue) {
    lines.push(`  const trimmed = next.trim();`);
  }

  lines.push(
    `  if (!${normalizedValueName} || String(settingsHost.${plan.stateObjectProperty}.${plan.updatedProperty}) === ${normalizedValueName}) {`,
    `    return;`,
    `  }`,
    `  const settings: ${stateType} = {`,
    `    ...settingsHost.${plan.stateObjectProperty},`,
    `    ${plan.updatedProperty}: ${normalizedValueName},`,
    `  };`,
    `  settingsHost.${plan.stateObjectProperty} = settings;`,
  );

  if (plan.mirrorHostProperty) {
    lines.push(`  settingsHost.${plan.mirrorHostProperty} = String(settings.${plan.updatedProperty});`);
  }

  lines.push(`  ${plan.persistenceFunction}(settings);`, `}`);

  return lines.join('\n');
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
