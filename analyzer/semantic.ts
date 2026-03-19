import fs from 'node:fs';
import path from 'node:path';
import { type ExportDeclaration, type ImportDeclaration, Node, Project, type SourceFile, SyntaxKind } from 'ts-morph';
import type { Classification } from '../db/index.js';

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

export interface SemanticAnalysisResult {
  classification: Classification;
  confidence: number;
  reasons: string[];
  plan?: ImportTypeFixPlan | DirectImportFixPlan | ExtractSharedFixPlan;
}

interface DirectImportSearchResult {
  plan?: DirectImportFixPlan['imports'];
  sawBarrelScenario: boolean;
}

export class SemanticAnalyzer {
  public project: Project;

  constructor(public repoPath: string) {
    this.project = new Project({
      compilerOptions: {
        allowJs: true,
        resolveJsonModule: true,
      },
      skipAddingFilesFromTsConfig: true,
    });
  }

  public analyzeCycle(cyclePath: string[]): SemanticAnalysisResult {
    const uniqueFiles = [...new Set(cyclePath)];
    const directImportResult = uniqueFiles.length > 2 ? this.buildDirectImportPlan(uniqueFiles) : undefined;

    if (directImportResult?.plan && directImportResult.plan.length > 0) {
      const { barrelFile, targetFile, symbols } = directImportResult.plan[0];
      return {
        classification: 'autofix_direct_import',
        confidence: 0.85,
        reasons: [
          `Cycle can be resolved by importing ${symbols.join(', ')} directly from ${targetFile} instead of ${barrelFile}.`,
        ],
        plan: {
          kind: 'direct_import',
          imports: directImportResult.plan,
        },
      };
    }

    if (uniqueFiles.length > 2) {
      if (directImportResult?.sawBarrelScenario) {
        return {
          classification: 'suggest_manual',
          confidence: 0.6,
          reasons: ['Barrel re-export graph is ambiguous or side-effectful, so a direct-import rewrite is not safe.'],
        };
      }

      /* v8 ignore next 5 */
      return {
        classification: 'unsupported',
        confidence: 1,
        reasons: ['Only two-file cycles are supported for autofix in v1.'],
      };
    }

    const [fileA, fileB] = uniqueFiles;
    const sfA = this.loadCycleSourceFile(fileA);
    const sfB = this.loadCycleSourceFile(fileB);

    if (!sfA || !sfB) {
      /* v8 ignore next 5 */
      return {
        classification: 'unsupported',
        confidence: 1,
        reasons: ['Files participating in the cycle could not be read or found.'],
      };
    }

    const importsAToB = this.findImportsTo(sfA, fileB);
    const importsBToA = this.findImportsTo(sfB, fileA);

    if (importsAToB.length === 0 && importsBToA.length === 0) {
      return {
        classification: 'suggest_manual',
        confidence: 0.8,
        reasons: ['Could not statically resolve explicit imports between the two files.'],
      };
    }

    const typeOnlyImports = this.buildImportTypePlan(fileA, fileB, importsAToB, importsBToA);
    if (typeOnlyImports.length > 0) {
      return {
        classification: 'autofix_import_type',
        confidence: 0.9,
        reasons: ['Cycle can be resolved by converting concrete imports to type-only imports.'],
        plan: {
          kind: 'import_type',
          imports: typeOnlyImports,
        },
      };
    }

    const symbolsFromBUsedInA = this.getImportedSymbolNames(importsAToB);
    const symbolsFromAUsedInB = this.getImportedSymbolNames(importsBToA);
    const extractionPlan = this.buildExtractSharedPlan(
      fileA,
      fileB,
      sfA,
      sfB,
      symbolsFromAUsedInB,
      symbolsFromBUsedInA,
    );

    if (extractionPlan) {
      const { sourceFile, targetFile, symbols, sharedFile, preserveSourceExports } = extractionPlan;

      return {
        classification: 'autofix_extract_shared',
        confidence: 0.8,
        reasons: [
          `Cycle can be resolved by extracting ${symbols.join(', ')} from ${sourceFile} into ${sharedFile} while preserving the ${sourceFile} API.`,
        ],
        plan: {
          kind: 'extract_shared',
          sourceFile,
          targetFile,
          symbols,
          sharedFile,
          preserveSourceExports,
        },
      };
    }

    // fallback
    return {
      classification: 'suggest_manual',
      confidence: 0.5,
      reasons: ['Implementation logic extraction requires deeper symbol analysis. Defaulting to manual review.'],
    };
  }

  private getImportedSymbolNames(importNodes: ImportDeclaration[]): string[] {
    const names = new Set<string>();
    for (const imp of importNodes) {
      for (const named of imp.getNamedImports()) {
        names.add(named.getName());
      }
    }
    return [...names];
  }

  private isExtractable(sourceFile: SourceFile, symbolNames: string[], cycleFiles: string[]): boolean {
    if (symbolNames.length === 0) return false;

    for (const name of symbolNames) {
      const statement =
        sourceFile.getInterface(name) ||
        sourceFile.getTypeAlias(name) ||
        sourceFile.getFunction(name) ||
        this.getVariableStatementByDeclarationName(sourceFile, name);

      /* v8 ignore next */
      if (!statement) return false;

      // Ensure it is exported
      if (Node.isExportable(statement) && !statement.isExported()) {
        /* v8 ignore next */
        return false;
      }

      // V1 check: No classes for now
      if (Node.isClassDeclaration(statement)) return false;

      // Check if it depends on other files in the cycle (which would recreate the cycle in shared.ts)
      if (this.hasDependenciesOnFiles(statement, cycleFiles)) {
        return false;
      }
    }
    return true;
  }

  private hasDependenciesOnFiles(node: Node, targetFiles: string[]): boolean {
    const identifiers = node.getDescendantsOfKind(SyntaxKind.Identifier);
    const targetBaseNames = targetFiles.map((f) => path.basename(f, path.extname(f)));

    return identifiers.some((id) => this.isImportedFromFiles(id, targetBaseNames));
  }

  private isImportedFromFiles(id: Node, targetBaseNames: string[]): boolean {
    const sf = id.getSourceFile();
    const idText = id.getText();

    for (const imp of sf.getImportDeclarations()) {
      const moduleSpecifier = imp.getModuleSpecifierValue();
      const isTargetFile = targetBaseNames.some((base) => moduleSpecifier.includes(base));

      if (isTargetFile) {
        const isImported = imp.getNamedImports().some((named) => named.getName() === idText);
        if (isImported) return true;
      }
    }
    return false;
  }

  private getVariableStatementByDeclarationName(sourceFile: SourceFile, name: string): Node | undefined {
    const decl = sourceFile.getVariableDeclaration(name);
    return decl?.getVariableStatement();
  }

  private loadCycleSourceFile(filePath: string): SourceFile | undefined {
    const absolutePath = path.join(this.repoPath, filePath);
    const existingSourceFile = this.project.getSourceFile(absolutePath) || this.project.getSourceFile(filePath);

    if (existingSourceFile) {
      return existingSourceFile;
    }

    if (!fs.existsSync(absolutePath)) {
      return undefined;
    }

    return this.project.addSourceFileAtPath(absolutePath);
  }

  private buildImportTypePlan(
    fileA: string,
    fileB: string,
    importsAToB: ImportDeclaration[],
    importsBToA: ImportDeclaration[],
  ): ImportTypeFixPlan['imports'] {
    const importPlans: ImportTypeFixPlan['imports'] = [];

    if (this.checkTypeOnlyImports(importsAToB)) {
      importPlans.push({ sourceFile: fileA, targetFile: fileB });
    }

    if (this.checkTypeOnlyImports(importsBToA)) {
      importPlans.push({ sourceFile: fileB, targetFile: fileA });
    }

    return importPlans;
  }

  private buildExtractSharedPlan(
    fileA: string,
    fileB: string,
    sourceFileA: SourceFile,
    sourceFileB: SourceFile,
    symbolsFromAUsedInB: string[],
    symbolsFromBUsedInA: string[],
  ): ExtractSharedFixPlan | undefined {
    if (this.isExtractable(sourceFileB, symbolsFromBUsedInA, [fileA])) {
      return this.createExtractSharedPlan(fileB, fileA, symbolsFromBUsedInA);
    }

    if (this.isExtractable(sourceFileA, symbolsFromAUsedInB, [fileB])) {
      return this.createExtractSharedPlan(fileA, fileB, symbolsFromAUsedInB);
    }

    return undefined;
  }

  private createExtractSharedPlan(sourceFile: string, targetFile: string, symbols: string[]): ExtractSharedFixPlan {
    return {
      kind: 'extract_shared',
      sourceFile,
      targetFile,
      symbols,
      sharedFile: this.chooseSharedFilePath(sourceFile, targetFile, symbols),
      preserveSourceExports: true,
    };
  }

  private chooseSharedFilePath(sourceFile: string, targetFile: string, symbols: string[]): string {
    const sourceDir = path.dirname(sourceFile);
    const sourceExt = path.extname(sourceFile);
    const targetExt = path.extname(targetFile);
    const preferredExt = sourceExt === targetExt ? sourceExt : '.ts';
    const sourceStem = path.basename(sourceFile, sourceExt);
    const targetStem = path.basename(targetFile, targetExt);
    const parentStem = sourceDir === '.' ? sourceStem : path.basename(sourceDir);
    const candidateStems = new Set<string>();

    if (symbols.length === 1) {
      candidateStems.add(this.formatSharedModuleStem(symbols[0], sourceStem));
    }

    if (!this.isGenericSharedStem(sourceStem)) {
      candidateStems.add(sourceStem);
    }

    if (!this.isGenericSharedStem(parentStem)) {
      candidateStems.add(parentStem);
    }

    if (symbols.length === 1 && !this.isGenericSharedStem(sourceStem)) {
      candidateStems.add(`${sourceStem}-${this.formatSharedModuleStem(symbols[0], sourceStem)}`);
    }

    candidateStems.add(`${sourceStem}-${targetStem}`);

    for (const candidateStem of candidateStems) {
      const sharedFile = this.normalizeRepoRelativePath(path.join(sourceDir, `${candidateStem}.shared${preferredExt}`));
      if (sharedFile === sourceFile || sharedFile === targetFile) {
        continue;
      }

      if (!this.pathExistsInRepo(sharedFile)) {
        return sharedFile;
      }
    }

    return this.normalizeRepoRelativePath(path.join(sourceDir, `${sourceStem}-${targetStem}.shared${preferredExt}`));
  }

  private formatSharedModuleStem(symbol: string, referenceStem: string): string {
    if (referenceStem.includes('-')) {
      return this.toSeparatedCase(symbol, '-');
    }

    if (referenceStem.includes('_')) {
      return this.toSeparatedCase(symbol, '_');
    }

    return symbol;
  }

  private toSeparatedCase(value: string, separator: '-' | '_'): string {
    return value
      .replaceAll(/([a-z0-9])([A-Z])/g, `$1${separator}$2`)
      .replaceAll(/[^a-zA-Z0-9]+/g, separator)
      .replaceAll(new RegExp(`${separator}+`, 'g'), separator)
      .replaceAll(new RegExp(`^${separator}|${separator}$`, 'g'), '')
      .toLowerCase();
  }

  private isGenericSharedStem(stem: string): boolean {
    return stem.length <= 1 || ['index', 'types', 'type', 'utils', 'shared'].includes(stem.toLowerCase());
  }

  private pathExistsInRepo(relativePath: string): boolean {
    const absolutePath = path.join(this.repoPath, relativePath);
    return !!this.project.getSourceFile(absolutePath) || fs.existsSync(absolutePath);
  }

  private normalizeRepoRelativePath(filePath: string): string {
    return filePath.split(path.sep).join('/');
  }

  private buildDirectImportPlan(cycleFiles: string[]): DirectImportSearchResult {
    let sawBarrelScenario = false;

    for (const sourceFilePath of cycleFiles) {
      const searchResult = this.findDirectImportCandidateForSource(sourceFilePath, cycleFiles);
      sawBarrelScenario ||= searchResult.sawBarrelScenario;
      if (searchResult.plan) {
        return searchResult;
      }
    }

    return {
      sawBarrelScenario,
    };
  }

  private findDirectImportCandidateForSource(sourceFilePath: string, cycleFiles: string[]): DirectImportSearchResult {
    const sourceFile = this.loadCycleSourceFile(sourceFilePath);
    if (!sourceFile) {
      return { sawBarrelScenario: false };
    }

    let sawBarrelScenario = false;

    for (const barrelFilePath of cycleFiles) {
      if (barrelFilePath === sourceFilePath) {
        continue;
      }

      const barrelFile = this.loadCycleSourceFile(barrelFilePath);
      if (!barrelFile || !this.hasReExportDeclarations(barrelFile)) {
        continue;
      }

      const importDeclarations = this.findImportsTo(sourceFile, barrelFilePath);
      if (importDeclarations.length === 0) {
        continue;
      }

      sawBarrelScenario = true;

      const candidate = this.findDirectImportCandidateForDeclarations(
        sourceFilePath,
        barrelFilePath,
        barrelFile,
        importDeclarations,
        cycleFiles,
      );
      if (candidate) {
        return {
          sawBarrelScenario: true,
          plan: [candidate],
        };
      }
    }

    return { sawBarrelScenario };
  }

  private findDirectImportCandidateForDeclarations(
    sourceFilePath: string,
    barrelFilePath: string,
    barrelFile: SourceFile,
    importDeclarations: ImportDeclaration[],
    cycleFiles: string[],
  ): DirectImportFixPlan['imports'][number] | undefined {
    for (const importDecl of importDeclarations) {
      const candidate = this.tryBuildDirectImportCandidate(
        sourceFilePath,
        barrelFilePath,
        barrelFile,
        importDecl,
        cycleFiles,
      );
      if (candidate) {
        return candidate;
      }
    }

    return undefined;
  }

  private tryBuildDirectImportCandidate(
    sourceFilePath: string,
    barrelFilePath: string,
    barrelFile: SourceFile,
    importDecl: ImportDeclaration,
    cycleFiles: string[],
  ): DirectImportFixPlan['imports'][number] | undefined {
    if (importDecl.getDefaultImport() || importDecl.getNamespaceImport() || importDecl.getNamedImports().length === 0) {
      return undefined;
    }

    const importedNames = importDecl.getNamedImports().map((namedImport) => namedImport.getName());
    const resolution = this.resolveDirectImportTarget(barrelFile, importedNames);
    if (!resolution) {
      return undefined;
    }

    if (!this.isWithinRepo(resolution.targetFile)) {
      return undefined;
    }

    const targetFilePath = this.toRepoRelativePath(resolution.targetFile);
    if (targetFilePath === sourceFilePath || targetFilePath === barrelFilePath) {
      return undefined;
    }

    const targetSourceFile = this.loadCycleSourceFile(targetFilePath);
    if (targetSourceFile && this.hasDependenciesOnFiles(targetSourceFile, cycleFiles)) {
      return undefined;
    }

    return {
      sourceFile: sourceFilePath,
      barrelFile: barrelFilePath,
      targetFile: targetFilePath,
      symbols: importedNames,
    };
  }

  private resolveDirectImportTarget(
    barrelFile: SourceFile,
    importedNames: string[],
    visited = new Set<string>(),
  ): { targetFile: string; symbols: string[] } | undefined {
    if (!this.isPureBarrelModule(barrelFile)) {
      return undefined;
    }

    let resolvedTarget: string | undefined;

    for (const importedName of importedNames) {
      const resolved = this.resolveExportedSymbol(barrelFile, importedName, new Set(visited));
      if (!resolved) {
        return undefined;
      }

      if (resolvedTarget && resolvedTarget !== resolved.targetFile) {
        return undefined;
      }

      resolvedTarget = resolved.targetFile;
    }

    return resolvedTarget
      ? {
          targetFile: resolvedTarget,
          symbols: importedNames,
        }
      : undefined;
  }

  private resolveExportedSymbol(
    sourceFile: SourceFile,
    exportedName: string,
    visited: Set<string>,
  ): { targetFile: string } | undefined {
    const filePath = sourceFile.getFilePath();
    const visitKey = `${filePath}::${exportedName}`;
    if (visited.has(visitKey)) {
      return undefined;
    }
    visited.add(visitKey);

    if (!this.hasReExportDeclarations(sourceFile)) {
      return this.resolveLocalExportTarget(sourceFile, exportedName);
    }

    if (!this.isPureBarrelModule(sourceFile)) {
      return undefined;
    }

    return this.resolveExportedSymbolFromReExports(sourceFile, exportedName, visited);
  }

  private resolveLocalExportTarget(sourceFile: SourceFile, exportedName: string): { targetFile: string } | undefined {
    return sourceFile.getExportedDeclarations().has(exportedName)
      ? { targetFile: sourceFile.getFilePath() }
      : undefined;
  }

  private resolveExportedSymbolFromReExports(
    sourceFile: SourceFile,
    exportedName: string,
    visited: Set<string>,
  ): { targetFile: string } | undefined {
    let resolvedTarget: string | undefined;

    for (const exportDecl of sourceFile.getExportDeclarations()) {
      const resolved = this.resolveExportDeclarationTarget(exportDecl, exportedName, visited);
      if (!resolved) {
        continue;
      }

      if (resolvedTarget && resolvedTarget !== resolved.targetFile) {
        return undefined;
      }

      resolvedTarget = resolved.targetFile;
    }

    return resolvedTarget ? { targetFile: resolvedTarget } : undefined;
  }

  private resolveExportDeclarationTarget(
    exportDecl: ExportDeclaration,
    exportedName: string,
    visited: Set<string>,
  ): { targetFile: string } | undefined {
    const moduleSpecifier = exportDecl.getModuleSpecifierValue();
    if (!moduleSpecifier || exportDecl.getNamespaceExport()) {
      return undefined;
    }

    const namedExports = exportDecl.getNamedExports();
    if (namedExports.length === 0) {
      return undefined;
    }

    const matchingExport = namedExports.find(
      (namedExport) => this.getExportedSpecifierName(namedExport) === exportedName,
    );
    if (!matchingExport) {
      return undefined;
    }

    const resolvedPath = this.resolveModulePath(exportDecl.getSourceFile().getFilePath(), moduleSpecifier);
    if (!resolvedPath || !this.isWithinRepo(resolvedPath)) {
      return undefined;
    }

    const nextSourceFile = this.loadCycleSourceFile(this.toRepoRelativePath(resolvedPath));
    if (!nextSourceFile) {
      return undefined;
    }

    return this.resolveExportedSymbol(nextSourceFile, matchingExport.getName(), new Set(visited));
  }

  private getExportedSpecifierName(namedExport: {
    getAliasNode(): { getText(): string } | undefined;
    getName(): string;
  }): string {
    return namedExport.getAliasNode()?.getText() ?? namedExport.getName();
  }

  private isPureBarrelModule(sourceFile: SourceFile): boolean {
    const statements = sourceFile.getStatements();
    if (statements.some((statement) => !Node.isImportDeclaration(statement) && !Node.isExportDeclaration(statement))) {
      return false;
    }

    for (const importDecl of sourceFile.getImportDeclarations()) {
      if (
        !importDecl.isTypeOnly() &&
        importDecl.getNamedImports().length === 0 &&
        !importDecl.getDefaultImport() &&
        !importDecl.getNamespaceImport()
      ) {
        return false;
      }
    }

    const exportDeclarations = sourceFile.getExportDeclarations();
    return exportDeclarations.length > 0 && exportDeclarations.every((decl) => Boolean(decl.getModuleSpecifierValue()));
  }

  private hasReExportDeclarations(sourceFile: SourceFile): boolean {
    return sourceFile.getExportDeclarations().some((decl) => Boolean(decl.getModuleSpecifierValue()));
  }

  private resolveModulePath(filePath: string, moduleSpecifier: string): string | undefined {
    if (!moduleSpecifier.startsWith('.') && !path.isAbsolute(moduleSpecifier)) {
      return undefined;
    }

    const sourceDir = path.dirname(filePath);
    const resolvedPath = path.isAbsolute(moduleSpecifier) ? moduleSpecifier : path.resolve(sourceDir, moduleSpecifier);
    return this.findExistingModulePath(resolvedPath);
  }

  private findExistingModulePath(basePath: string): string | undefined {
    const candidates = [
      basePath,
      `${basePath}.ts`,
      `${basePath}.tsx`,
      `${basePath}.js`,
      `${basePath}.jsx`,
      path.join(basePath, 'index.ts'),
      path.join(basePath, 'index.tsx'),
      path.join(basePath, 'index.js'),
      path.join(basePath, 'index.jsx'),
    ];

    for (const candidate of candidates) {
      if (this.project.getSourceFile(candidate) || fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return undefined;
  }

  private toRepoRelativePath(absolutePath: string): string {
    return path.relative(this.repoPath, absolutePath).split(path.sep).join('/');
  }

  private isWithinRepo(absolutePath: string): boolean {
    const relativePath = path.relative(this.repoPath, absolutePath);
    return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
  }

  private findImportsTo(sourceFile: SourceFile, targetFilePath: string): ImportDeclaration[] {
    const imports: ImportDeclaration[] = [];
    const sourceDir = path.dirname(sourceFile.getFilePath());
    const targetAbsPath = path.isAbsolute(targetFilePath)
      ? targetFilePath
      : path.resolve(this.repoPath, targetFilePath);

    for (const importDecl of sourceFile.getImportDeclarations()) {
      const moduleSpecifier = importDecl.getModuleSpecifierValue();
      /* v8 ignore next */
      if (!moduleSpecifier.startsWith('.') && !path.isAbsolute(moduleSpecifier)) continue;

      const resolvedPath = path.resolve(sourceDir, moduleSpecifier);

      if (resolvedPath === targetAbsPath || resolvedPath === targetAbsPath.replace(/\.(ts|tsx|js|jsx)$/, '')) {
        imports.push(importDecl);
      }
    }
    return imports;
  }

  private checkTypeOnlyImports(importNodes: ImportDeclaration[]): boolean {
    if (importNodes.length === 0) return false;

    for (const imp of importNodes) {
      if (imp.isTypeOnly()) continue;

      if (!this.allNamedImportsAreTypeSafe(imp)) {
        return false;
      }

      if (imp.getDefaultImport() || imp.getNamespaceImport()) {
        return false;
      }
    }

    return true;
  }

  private allNamedImportsAreTypeSafe(imp: ImportDeclaration): boolean {
    for (const namedImport of imp.getNamedImports()) {
      const nameNode = namedImport.getNameNode();
      /* v8 ignore next */
      if (!Node.isIdentifier(nameNode)) return false;

      const references = nameNode.findReferencesAsNodes();
      const hasValueUsage = references.some((ref) => {
        if (ref === nameNode) return false;
        return !this.isInTypePosition(ref);
      });

      if (hasValueUsage) return false;
    }
    return true;
  }

  private isInTypePosition(node: Node): boolean {
    let current: Node | undefined = node.getParent();
    while (current) {
      const kind = current.getKind();
      if (
        kind === SyntaxKind.TypeReference ||
        kind === SyntaxKind.TypeAliasDeclaration ||
        kind === SyntaxKind.InterfaceDeclaration ||
        kind === SyntaxKind.AsExpression ||
        kind === SyntaxKind.TypeAssertionExpression ||
        kind === SyntaxKind.ImportSpecifier ||
        kind === SyntaxKind.ExportSpecifier
      ) {
        return true;
      }
      current = current.getParent();
    }
    return false;
  }
}
