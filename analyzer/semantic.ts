import fs from 'node:fs';
import path from 'node:path';
import { type ImportDeclaration, Node, Project, type SourceFile, SyntaxKind } from 'ts-morph';
import type { Classification } from '../db/index.js';

export interface SemanticAnalysisResult {
  classification: Classification;
  confidence: number;
  reasons: string[];
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
    // Basic deduplication of cyclical array
    const uniqueFiles = [...new Set(cyclePath)];
    if (uniqueFiles.length > 2) {
      /* v8 ignore next 5 */
      return {
        classification: 'unsupported',
        confidence: 1,
        reasons: ['Only two-file cycles are supported for autofix in v1.'],
      };
    }

    const [fileA, fileB] = uniqueFiles;

    // Attempt to load files
    const absPathA = path.join(this.repoPath, fileA);
    const absPathB = path.join(this.repoPath, fileB);

    let sfA = this.project.getSourceFile(absPathA) || this.project.getSourceFile(fileA);
    let sfB = this.project.getSourceFile(absPathB) || this.project.getSourceFile(fileB);

    if (!sfA && fs.existsSync(absPathA)) sfA = this.project.addSourceFileAtPath(absPathA);
    if (!sfB && fs.existsSync(absPathB)) sfB = this.project.addSourceFileAtPath(absPathB);

    if (!sfA || !sfB) {
      /* v8 ignore next 5 */
      return {
        classification: 'unsupported',
        confidence: 1,
        reasons: ['Files participating in the cycle could not be read or found.'],
      };
    }

    // Initial naive AST-based assessment
    const importsAToB = this.findImportsTo(sfA, fileB);
    const importsBToA = this.findImportsTo(sfB, fileA);

    if (importsAToB.length === 0 && importsBToA.length === 0) {
      return {
        classification: 'suggest_manual',
        confidence: 0.8,
        reasons: ['Could not statically resolve explicit imports between the two files.'],
      };
    }

    // Check for import type conversion opportunities
    const typeOnlyOpportunitesA = this.checkTypeOnlyImports(importsAToB);
    const typeOnlyOpportunitesB = this.checkTypeOnlyImports(importsBToA);

    if (typeOnlyOpportunitesA || typeOnlyOpportunitesB) {
      return {
        classification: 'autofix_import_type',
        confidence: 0.9,
        reasons: ['Cycle can be resolved by converting concrete imports to type-only imports.'],
      };
    }

    // Check for extraction opportunities
    const symbolsFromBUsedInA = this.getImportedSymbolNames(importsAToB);
    const symbolsFromAUsedInB = this.getImportedSymbolNames(importsBToA);

    const bIsExtractable = this.isExtractable(sfB, symbolsFromBUsedInA, [fileA]);
    const aIsExtractable = this.isExtractable(sfA, symbolsFromAUsedInB, [fileB]);

    if (bIsExtractable || aIsExtractable) {
      return {
        classification: 'autofix_extract_shared',
        confidence: 0.8,
        reasons: [
          `Cycle can be resolved by extracting ${
            bIsExtractable ? 'symbols from ' + fileB : 'symbols from ' + fileA
          } into a shared file.`,
        ],
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
