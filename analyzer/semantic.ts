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

export type PlanningStrategy = 'import_type' | 'direct_import' | 'extract_shared';
export type StrategySignalValue = boolean | number | string;

const missingCycleFilesReason = 'Files participating in the cycle could not be read or found.';

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
  plan?: ImportTypeFixPlan | DirectImportFixPlan | ExtractSharedFixPlan;
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
  plan?: ImportTypeFixPlan | DirectImportFixPlan | ExtractSharedFixPlan;
  upstreamabilityScore?: number;
  planner?: CyclePlanningResult;
}

interface DirectImportSearchResult {
  plan?: DirectImportFixPlan['imports'];
  sawBarrelScenario: boolean;
}

interface CyclePlanningContext {
  cyclePath: string[];
  uniqueFiles: string[];
  cycleShape: 'two_file' | 'multi_file';
  sourceFiles: Map<string, SourceFile | undefined>;
  importsAToB: ImportDeclaration[];
  importsBToA: ImportDeclaration[];
  cycleSignals: Record<string, StrategySignalValue>;
}

interface StrategyDefinition {
  strategy: PlanningStrategy;
  describeApplicability: (context: CyclePlanningContext) => {
    applicable: boolean;
    summary: string;
    signals: Record<string, StrategySignalValue>;
  };
  evaluate: (context: CyclePlanningContext) => StrategyAttempt;
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
    const planning = this.planCycle(cyclePath);
    const selectedAttempt =
      planning.selectedStrategy === undefined
        ? undefined
        : planning.attempts.find(
            (attempt) => attempt.strategy === planning.selectedStrategy && attempt.status === 'candidate',
          );

    if (selectedAttempt?.classification && selectedAttempt.confidence !== undefined) {
      return {
        classification: selectedAttempt.classification,
        confidence: selectedAttempt.confidence,
        reasons: selectedAttempt.reasons,
        plan: selectedAttempt.plan,
        upstreamabilityScore: selectedAttempt.score,
        planner: planning,
      };
    }

    return {
      classification: planning.fallbackClassification,
      confidence: planning.fallbackConfidence,
      reasons: planning.fallbackReasons,
      planner: planning,
    };
  }

  public planCycle(cyclePath: string[]): CyclePlanningResult {
    const context = this.buildPlanningContext(cyclePath);
    const attempts = this.getStrategyDefinitions().map((strategy) => this.evaluateStrategy(strategy, context));
    const selectedAttempt = this.selectBestAttempt(attempts);
    const fallbackDecision = this.determineFallbackDecision(context, attempts);

    return {
      cycleFiles: context.uniqueFiles,
      cycleSize: context.uniqueFiles.length,
      cycleShape: context.cycleShape,
      cycleSignals: context.cycleSignals,
      fallbackClassification: selectedAttempt?.classification ?? fallbackDecision.classification,
      fallbackConfidence: selectedAttempt?.confidence ?? fallbackDecision.confidence,
      fallbackReasons: selectedAttempt?.reasons ?? fallbackDecision.reasons,
      selectedStrategy: selectedAttempt?.strategy,
      selectedClassification: selectedAttempt?.classification,
      selectedScore: selectedAttempt?.score,
      selectionSummary: selectedAttempt
        ? `Selected ${selectedAttempt.strategy} with score ${selectedAttempt.score ?? 0} after evaluating ${attempts.length} strategies.`
        : `No strategy cleared the safety filters; falling back to ${fallbackDecision.classification}.`,
      attempts,
    };
  }

  private buildPlanningContext(cyclePath: string[]): CyclePlanningContext {
    const uniqueFiles = [...new Set(cyclePath)];
    const cycleShape = uniqueFiles.length === 2 ? 'two_file' : 'multi_file';
    const sourceFiles = new Map<string, SourceFile | undefined>(
      uniqueFiles.map((filePath) => [filePath, this.loadCycleSourceFile(filePath)]),
    );
    const [fileA, fileB] = uniqueFiles;
    const sourceFileA = fileA ? sourceFiles.get(fileA) : undefined;
    const sourceFileB = fileB ? sourceFiles.get(fileB) : undefined;
    const importsAToB = sourceFileA && fileB ? this.findImportsTo(sourceFileA, fileB) : [];
    const importsBToA = sourceFileB && fileA ? this.findImportsTo(sourceFileB, fileA) : [];

    return {
      cyclePath,
      uniqueFiles,
      cycleShape,
      sourceFiles,
      importsAToB,
      importsBToA,
      cycleSignals: {
        explicitImportEdges: importsAToB.length + importsBToA.length,
        loadedFiles: [...sourceFiles.values()].filter(Boolean).length,
        missingFiles: [...sourceFiles.values()].filter((sourceFile) => !sourceFile).length,
      },
    };
  }

  private getStrategyDefinitions(): StrategyDefinition[] {
    return [
      {
        strategy: 'import_type',
        describeApplicability: (context) => ({
          applicable: context.cycleShape === 'two_file',
          summary:
            context.cycleShape === 'two_file'
              ? 'Type-only import conversion can be evaluated for two-file cycles.'
              : 'Type-only conversion is only supported for two-file cycles.',
          signals: {
            cycleShape: context.cycleShape,
            cycleSize: context.uniqueFiles.length,
          },
        }),
        evaluate: (context) => {
          const [fileA, fileB] = context.uniqueFiles;

          if (this.contextHasMissingFiles(context)) {
            return this.createRejectedAttempt('import_type', missingCycleFilesReason, [missingCycleFilesReason], {
              fileA: fileA ?? 'unknown',
              fileB: fileB ?? 'unknown',
            });
          }

          return this.evaluateImportTypeAttempt(fileA ?? '', fileB ?? '', context.importsAToB, context.importsBToA);
        },
      },
      {
        strategy: 'direct_import',
        describeApplicability: (context) => ({
          applicable: context.cycleShape === 'multi_file',
          summary:
            context.cycleShape === 'multi_file'
              ? 'Direct-import rewriting can be evaluated for barrel-driven multi-file cycles.'
              : 'Direct-import rewriting only applies to barrel-driven cycles with 3+ files.',
          signals: {
            cycleShape: context.cycleShape,
            cycleSize: context.uniqueFiles.length,
          },
        }),
        evaluate: (context) => this.evaluateDirectImportAttempt(context.uniqueFiles),
      },
      {
        strategy: 'extract_shared',
        describeApplicability: (context) => ({
          applicable: context.cycleShape === 'two_file',
          summary:
            context.cycleShape === 'two_file'
              ? 'Shared-module extraction can be evaluated for two-file cycles.'
              : 'Shared extraction is only supported for two-file cycles.',
          signals: {
            cycleShape: context.cycleShape,
            cycleSize: context.uniqueFiles.length,
          },
        }),
        evaluate: (context) => {
          const [fileA, fileB] = context.uniqueFiles;
          const sourceFileA = fileA ? context.sourceFiles.get(fileA) : undefined;
          const sourceFileB = fileB ? context.sourceFiles.get(fileB) : undefined;

          if (!fileA || !fileB || !sourceFileA || !sourceFileB) {
            return this.createRejectedAttempt('extract_shared', missingCycleFilesReason, [missingCycleFilesReason], {
              fileA: fileA ?? 'unknown',
              fileB: fileB ?? 'unknown',
            });
          }

          return this.evaluateExtractSharedAttempt(
            fileA,
            fileB,
            sourceFileA,
            sourceFileB,
            context.importsAToB,
            context.importsBToA,
          );
        },
      },
    ];
  }

  private evaluateStrategy(strategy: StrategyDefinition, context: CyclePlanningContext): StrategyAttempt {
    const applicability = strategy.describeApplicability(context);
    if (!applicability.applicable) {
      return this.createNotApplicableAttempt(strategy.strategy, applicability.summary, applicability.signals);
    }

    return strategy.evaluate(context);
  }

  private determineFallbackDecision(
    context: CyclePlanningContext,
    attempts: StrategyAttempt[],
  ): {
    classification: Classification;
    confidence: number;
    reasons: string[];
  } {
    if (context.cycleShape === 'multi_file') {
      const directImportAttempt = attempts.find((attempt) => attempt.strategy === 'direct_import');
      if (directImportAttempt?.reasons.some((reason) => reason.includes('Barrel re-export graph is ambiguous'))) {
        return {
          classification: 'suggest_manual',
          confidence: 0.6,
          reasons: ['Barrel re-export graph is ambiguous or side-effectful, so a direct-import rewrite is not safe.'],
        };
      }

      return {
        classification: 'unsupported',
        confidence: 1,
        reasons: [
          'Only two-file cycles are supported for autofix in v1, except for safe barrel direct-import rewrites.',
        ],
      };
    }

    if (this.contextHasMissingFiles(context)) {
      return {
        classification: 'unsupported',
        confidence: 1,
        reasons: [missingCycleFilesReason],
      };
    }

    if (context.importsAToB.length === 0 && context.importsBToA.length === 0) {
      return {
        classification: 'suggest_manual',
        confidence: 0.8,
        reasons: ['Could not statically resolve explicit imports between the two files.'],
      };
    }

    return {
      classification: 'suggest_manual',
      confidence: 0.5,
      reasons: ['Implementation logic extraction requires deeper symbol analysis. Defaulting to manual review.'],
    };
  }

  private contextHasMissingFiles(context: CyclePlanningContext): boolean {
    return [...context.sourceFiles.values()].some((sourceFile) => !sourceFile);
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

  private evaluateImportTypeAttempt(
    fileA: string,
    fileB: string,
    importsAToB: ImportDeclaration[],
    importsBToA: ImportDeclaration[],
  ): StrategyAttempt {
    const importPlans = this.buildImportTypePlan(fileA, fileB, importsAToB, importsBToA);
    if (importPlans.length === 0) {
      const importEdgeCount = importsAToB.length + importsBToA.length;
      return this.createRejectedAttempt(
        'import_type',
        'Imports cross the cycle, but at least one edge is used in runtime positions.',
        importEdgeCount === 0
          ? ['Could not statically resolve any explicit import edge that can be converted to type-only.']
          : ['At least one import edge is used at runtime, so a type-only rewrite would be unsafe.'],
        {
          importEdgeCount,
          fileA,
          fileB,
        },
      );
    }

    const scoring = this.scoreImportTypePlan(importPlans);
    return {
      strategy: 'import_type',
      status: 'candidate',
      summary: `Convert ${importPlans.length} import edge(s) to type-only imports.`,
      reasons: ['Cycle can be resolved by converting concrete imports to type-only imports.'],
      signals: scoring.signals,
      score: scoring.score,
      scoreBreakdown: scoring.breakdown,
      classification: 'autofix_import_type',
      confidence: 0.9,
      plan: {
        kind: 'import_type',
        imports: importPlans,
      },
    };
  }

  private evaluateExtractSharedAttempt(
    fileA: string,
    fileB: string,
    sourceFileA: SourceFile,
    sourceFileB: SourceFile,
    importsAToB: ImportDeclaration[],
    importsBToA: ImportDeclaration[],
  ): StrategyAttempt {
    const symbolsFromBUsedInA = this.getImportedSymbolNames(importsAToB);
    const symbolsFromAUsedInB = this.getImportedSymbolNames(importsBToA);
    const extractionPlan = this.buildExtractSharedPlan(
      fileA,
      fileB,
      sourceFileA,
      sourceFileB,
      symbolsFromAUsedInB,
      symbolsFromBUsedInA,
    );

    if (!extractionPlan) {
      return this.createRejectedAttempt(
        'extract_shared',
        'No leaf-like exported symbol could be extracted safely without recreating the cycle.',
        [
          'Imported symbols are either not exported, rely on runtime state from the cycle, or use declaration shapes that are not yet supported.',
        ],
        {
          symbolsFromAUsedInB: symbolsFromAUsedInB.join(',') || 'none',
          symbolsFromBUsedInA: symbolsFromBUsedInA.join(',') || 'none',
          fileA,
          fileB,
        },
      );
    }

    const scoring = this.scoreExtractSharedPlan(extractionPlan);
    return {
      strategy: 'extract_shared',
      status: 'candidate',
      summary: `Extract ${extractionPlan.symbols.join(', ')} into ${extractionPlan.sharedFile} and preserve ${extractionPlan.sourceFile}'s exports.`,
      reasons: [
        `Cycle can be resolved by extracting ${extractionPlan.symbols.join(', ')} from ${extractionPlan.sourceFile} into ${extractionPlan.sharedFile} while preserving the ${extractionPlan.sourceFile} API.`,
      ],
      signals: scoring.signals,
      score: scoring.score,
      scoreBreakdown: scoring.breakdown,
      classification: 'autofix_extract_shared',
      confidence: 0.8,
      plan: extractionPlan,
    };
  }

  private evaluateDirectImportAttempt(cycleFiles: string[]): StrategyAttempt {
    const directImportResult = this.buildDirectImportPlan(cycleFiles);
    if (!directImportResult.plan || directImportResult.plan.length === 0) {
      if (directImportResult.sawBarrelScenario) {
        return this.createRejectedAttempt(
          'direct_import',
          'Barrel re-export graph is ambiguous or side-effectful.',
          ['Barrel re-export graph is ambiguous or side-effectful, so a direct-import rewrite is not safe.'],
          {
            cycleSize: cycleFiles.length,
          },
        );
      }

      return this.createRejectedAttempt(
        'direct_import',
        'No safe barrel import rewrite was found for this cycle.',
        ['No safe barrel import chain was detected between the cycle participants.'],
        {
          cycleSize: cycleFiles.length,
        },
      );
    }

    const scoring = this.scoreDirectImportPlan(directImportResult.plan);
    const firstPlan = directImportResult.plan[0];
    return {
      strategy: 'direct_import',
      status: 'candidate',
      summary: `Rewrite ${directImportResult.plan.length} barrel import edge(s) to direct imports.`,
      reasons: [
        `Cycle can be resolved by importing ${firstPlan.symbols.join(', ')} directly from ${firstPlan.targetFile} instead of ${firstPlan.barrelFile}.`,
      ],
      signals: scoring.signals,
      score: scoring.score,
      scoreBreakdown: scoring.breakdown,
      classification: 'autofix_direct_import',
      confidence: 0.85,
      plan: {
        kind: 'direct_import',
        imports: directImportResult.plan,
      },
    };
  }

  private scoreImportTypePlan(importPlans: ImportTypeFixPlan['imports']): {
    score: number;
    breakdown: string[];
    signals: Record<string, StrategySignalValue>;
  } {
    const touchedFiles = new Set(importPlans.map((plan) => plan.sourceFile));
    const score = this.clampScore(0.97 - Math.max(0, touchedFiles.size - 1) * 0.03);
    return {
      score,
      breakdown: [
        `base 0.97 for least-invasive rewrite`,
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

  private scoreDirectImportPlan(importPlans: DirectImportFixPlan['imports']): {
    score: number;
    breakdown: string[];
    signals: Record<string, StrategySignalValue>;
  } {
    const touchedFiles = new Set(importPlans.map((plan) => plan.sourceFile));
    const score = this.clampScore(0.89 - Math.max(0, touchedFiles.size - 1) * 0.04);
    return {
      score,
      breakdown: [
        `base 0.89 for removing a barrel hop`,
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

  private scoreExtractSharedPlan(plan: ExtractSharedFixPlan): {
    score: number;
    breakdown: string[];
    signals: Record<string, StrategySignalValue>;
  } {
    const symbolNamedSharedFile = plan.symbols.length === 1 && path.basename(plan.sharedFile).includes(plan.symbols[0]);
    const score = this.clampScore(
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

  private selectBestAttempt(attempts: StrategyAttempt[]): StrategyAttempt | undefined {
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

  private createNotApplicableAttempt(
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

  private createRejectedAttempt(
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

  private clampScore(value: number): number {
    return Math.max(0, Math.min(1, Number(value.toFixed(2))));
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
