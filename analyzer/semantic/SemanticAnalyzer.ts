import fs from 'node:fs';
import path from 'node:path';
import {
  type FunctionDeclaration,
  type Identifier,
  type ImportDeclaration,
  Node,
  Project,
  type SourceFile,
  SyntaxKind,
} from 'ts-morph';
import type { Classification } from '../../db/index.js';
import { createEmptyHistoricalEvidenceSnapshot } from './evidence.js';
import { extractCycleFeatures } from './features.js';
import { buildCycleGraph, findDirectImportPlanFromGraph } from './graph.js';
import {
  applyHistoricalEvidence,
  createNotApplicableAttempt,
  createRejectedAttempt,
  rankCandidateAttempts,
  scoreDirectImportPlan,
  scoreExtractSharedPlan,
  scoreHostStateUpdatePlan,
  scoreImportTypePlan,
  selectBestAttempt,
} from './scoring.js';
import type {
  CyclePlanningContext,
  CyclePlanningResult,
  ExtractSharedFixPlan,
  HistoricalEvidenceSnapshot,
  HostStateUpdateFixPlan,
  ImportTypeFixPlan,
  PlannerRepositoryProfile,
  SemanticAnalysisResult,
  StrategyAttempt,
  StrategyDefinition,
} from './types.js';
import { missingCycleFilesReason } from './types.js';

type PersistenceModuleKind = 'package' | 'repo_file';

type HostStateHelperStatementResult =
  | { kind: 'alias'; settingsValueName: string }
  | { kind: 'host_assignment' }
  | {
      kind: 'persistence';
      persistenceFunction: string;
      persistenceModule: string;
      persistenceModuleKind: PersistenceModuleKind;
    }
  | { kind: 'mirror'; mirrorHostProperty: string }
  | { kind: 'ignored' }
  | { kind: 'reject' };

export class SemanticAnalyzer {
  public project: Project;

  constructor(
    public repoPath: string,
    private readonly plannerOptions: {
      repositoryProfile?: PlannerRepositoryProfile;
      historicalEvidence?: HistoricalEvidenceSnapshot;
    } = {},
  ) {
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
    const rankedCandidates = rankCandidateAttempts(attempts);
    const selectedAttempt = rankedCandidates[0] ?? selectBestAttempt(attempts);
    const fallbackDecision = this.determineFallbackDecision(context, attempts);

    return {
      cycleFiles: context.uniqueFiles,
      cycleSize: context.uniqueFiles.length,
      cycleShape: context.cycleShape,
      cycleSignals: context.cycleSignals,
      features: context.features,
      graphSummary: context.graphSummary,
      fallbackClassification: selectedAttempt?.classification ?? fallbackDecision.classification,
      fallbackConfidence: selectedAttempt?.confidence ?? fallbackDecision.confidence,
      fallbackReasons: selectedAttempt?.reasons ?? fallbackDecision.reasons,
      selectedStrategy: selectedAttempt?.strategy,
      selectedClassification: selectedAttempt?.classification,
      selectedScore: selectedAttempt?.score,
      selectionSummary: selectedAttempt
        ? `Selected ${selectedAttempt.strategy} with score ${selectedAttempt.score ?? 0} after evaluating ${attempts.length} strategies; ${rankedCandidates.length} candidate(s) cleared the safety filters.`
        : `No strategy cleared the safety filters; falling back to ${fallbackDecision.classification}.`,
      rankedCandidates,
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
    const graphSummary = buildCycleGraph({
      cycleFiles: uniqueFiles,
      isWithinRepo: (absolutePath) => this.isWithinRepo(absolutePath),
      loadSourceFile: (repoRelativePath) => this.loadCycleSourceFile(repoRelativePath),
      resolveModulePath: (filePath, moduleSpecifier) =>
        this.resolveModulePath(path.join(this.repoPath, filePath), moduleSpecifier),
      toRepoRelativePath: (absolutePath) => this.toRepoRelativePath(absolutePath),
    });
    const cycleSignals = {
      explicitImportEdges: importsAToB.length + importsBToA.length,
      loadedFiles: [...sourceFiles.values()].filter(Boolean).length,
      missingFiles: [...sourceFiles.values()].filter((sourceFile) => !sourceFile).length,
      barrelModules: graphSummary.metrics.barrelModuleCount,
      sideEffectModules: graphSummary.metrics.sideEffectModuleCount,
      symbolSccs: graphSummary.metrics.symbolSccCount,
    };

    return {
      cyclePath,
      uniqueFiles,
      cycleShape,
      sourceFiles,
      importsAToB,
      importsBToA,
      cycleSignals,
      repositoryProfile: this.plannerOptions.repositoryProfile,
      historicalEvidence: this.plannerOptions.historicalEvidence ?? createEmptyHistoricalEvidenceSnapshot(),
      graphSummary,
      features: extractCycleFeatures({
        uniqueFiles,
        cycleShape,
        graphSummary,
        cycleSignals,
        repositoryProfile: this.plannerOptions.repositoryProfile,
      }),
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
            return createRejectedAttempt('import_type', missingCycleFilesReason, [missingCycleFilesReason], {
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
        evaluate: (context) => this.evaluateDirectImportAttempt(context.uniqueFiles, context.graphSummary),
      },
      {
        strategy: 'host_state_update',
        describeApplicability: (context) => ({
          applicable: context.cycleShape === 'two_file',
          summary:
            context.cycleShape === 'two_file'
              ? 'Host-owned state update localization can be evaluated for two-file cycles.'
              : 'Host-owned state update localization is only supported for two-file cycles.',
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
            return createRejectedAttempt('host_state_update', missingCycleFilesReason, [missingCycleFilesReason], {
              fileA: fileA ?? 'unknown',
              fileB: fileB ?? 'unknown',
            });
          }

          return this.evaluateHostStateUpdateAttempt(
            fileA,
            fileB,
            sourceFileA,
            sourceFileB,
            context.importsAToB,
            context.importsBToA,
          );
        },
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
            return createRejectedAttempt('extract_shared', missingCycleFilesReason, [missingCycleFilesReason], {
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
      return createNotApplicableAttempt(strategy.strategy, applicability.summary, applicability.signals);
    }

    const attempt = strategy.evaluate(context);
    return applyHistoricalEvidence(attempt, context.features, context.historicalEvidence);
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
      return createRejectedAttempt(
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

    const scoring = scoreImportTypePlan(importPlans);
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
      return createRejectedAttempt(
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

    const scoring = scoreExtractSharedPlan(extractionPlan);
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

  private evaluateDirectImportAttempt(
    cycleFiles: string[],
    graphSummary: CyclePlanningContext['graphSummary'],
  ): StrategyAttempt {
    const directImportResult = findDirectImportPlanFromGraph(graphSummary, cycleFiles);
    if (!directImportResult.plan || directImportResult.plan.length === 0) {
      if (directImportResult.ambiguousResolution) {
        return createRejectedAttempt(
          'direct_import',
          'Barrel re-export graph is ambiguous or side-effectful.',
          ['Barrel re-export graph is ambiguous or side-effectful, so a direct-import rewrite is not safe.'],
          {
            cycleSize: cycleFiles.length,
          },
        );
      }

      return createRejectedAttempt(
        'direct_import',
        'No safe barrel import rewrite was found for this cycle.',
        ['No safe barrel import chain was detected between the cycle participants.'],
        {
          cycleSize: cycleFiles.length,
        },
      );
    }

    const scoring = scoreDirectImportPlan(directImportResult.plan);
    const firstPlan = directImportResult.plan[0];
    return {
      strategy: 'direct_import',
      status: 'candidate',
      summary: `Rewrite ${directImportResult.plan.length} re-export seam import edge(s) to direct imports.`,
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

  private evaluateHostStateUpdateAttempt(
    fileA: string,
    fileB: string,
    sourceFileA: SourceFile,
    sourceFileB: SourceFile,
    importsAToB: ImportDeclaration[],
    importsBToA: ImportDeclaration[],
  ): StrategyAttempt {
    const plan =
      this.buildHostStateUpdatePlan(fileA, fileB, sourceFileA, sourceFileB, importsAToB) ??
      this.buildHostStateUpdatePlan(fileB, fileA, sourceFileB, sourceFileA, importsBToA);

    if (!plan) {
      return createRejectedAttempt(
        'host_state_update',
        'No imported setter could be localized safely into the caller-owned host state.',
        [
          'Imported runtime symbols either perform too much work, mutate state they do not own, or require local helpers that could not be reduced to a safe persisted state update.',
        ],
        {
          fileA,
          fileB,
          importEdges: importsAToB.length + importsBToA.length,
        },
      );
    }

    const scoring = scoreHostStateUpdatePlan(plan);
    return {
      strategy: 'host_state_update',
      status: 'candidate',
      summary: `Localize ${plan.importedFunction} into ${plan.sourceFile} and persist ${plan.updatedProperty} without creating a shared module.`,
      reasons: [
        `Cycle can be resolved by localizing the imported setter ${plan.importedFunction} into ${plan.sourceFile}, because the caller already owns ${plan.stateObjectProperty}.${plan.updatedProperty}.`,
      ],
      signals: scoring.signals,
      score: scoring.score,
      scoreBreakdown: scoring.breakdown,
      classification: 'autofix_host_state_update',
      confidence: 0.84,
      plan,
    };
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

  private buildHostStateUpdatePlan(
    sourceFilePath: string,
    targetFilePath: string,
    sourceFile: SourceFile,
    targetFile: SourceFile,
    importDeclarations: ImportDeclaration[],
  ): HostStateUpdateFixPlan | undefined {
    const targetModuleKey = this.createRepoFileModuleKey(targetFilePath);

    for (const importDecl of importDeclarations) {
      if (importDecl.getDefaultImport() || importDecl.getNamespaceImport()) {
        continue;
      }

      for (const namedImport of importDecl.getNamedImports()) {
        const plan = this.tryBuildHostStateUpdatePlanForNamedImport(
          sourceFilePath,
          targetFilePath,
          sourceFile,
          targetFile,
          namedImport,
          targetModuleKey,
        );
        if (plan) {
          return plan;
        }
      }
    }

    return undefined;
  }

  private tryBuildHostStateUpdatePlanForNamedImport(
    sourceFilePath: string,
    targetFilePath: string,
    sourceFile: SourceFile,
    targetFile: SourceFile,
    namedImport: { getAliasNode(): Identifier | undefined; getName(): string },
    targetModuleKey: string,
  ): HostStateUpdateFixPlan | undefined {
    const importedFunction = this.getImportLocalName(namedImport);
    if (this.hasConflictingLocalName(sourceFile, importedFunction, new Set([targetModuleKey]))) {
      return undefined;
    }

    const setterFunction = targetFile.getFunction(namedImport.getName());
    if (!setterFunction?.isExported()) {
      return undefined;
    }

    const setterPattern = this.parseHostStateSetter(setterFunction);
    if (!setterPattern) {
      return undefined;
    }

    const persistencePattern = this.analyzeHostStatePersistenceHelper(
      targetFile,
      setterPattern.helperFunctionName,
      setterPattern.stateObjectProperty,
      setterPattern.updatedProperty,
      sourceFilePath,
      targetFilePath,
    );
    if (!persistencePattern) {
      return undefined;
    }

    const allowedPersistenceKeys = new Set<string>([
      this.getPersistenceModuleKey(persistencePattern.persistenceModuleKind, persistencePattern.persistenceModule),
    ]);
    if (this.hasConflictingLocalName(sourceFile, persistencePattern.persistenceFunction, allowedPersistenceKeys)) {
      return undefined;
    }

    return {
      kind: 'host_state_update',
      sourceFile: sourceFilePath,
      targetFile: targetFilePath,
      importedFunction,
      persistenceModule: persistencePattern.persistenceModule,
      persistenceModuleKind: persistencePattern.persistenceModuleKind,
      persistenceFunction: persistencePattern.persistenceFunction,
      stateObjectProperty: setterPattern.stateObjectProperty,
      updatedProperty: setterPattern.updatedProperty,
      mirrorHostProperty: persistencePattern.mirrorHostProperty,
      trimValue: setterPattern.trimValue,
    };
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

  private parseHostStateSetter(functionDeclaration: FunctionDeclaration):
    | {
        helperFunctionName: string;
        stateObjectProperty: string;
        updatedProperty: string;
        trimValue: boolean;
      }
    | undefined {
    const body = functionDeclaration.getBody();
    const parameters = functionDeclaration.getParameters();
    if (!body || !Node.isBlock(body) || parameters.length !== 2) {
      return undefined;
    }

    const hostParamName = parameters[0]?.getName();
    const valueParamName = parameters[1]?.getName();
    if (!hostParamName || !valueParamName) {
      return undefined;
    }

    let normalizedValueName = valueParamName;
    let trimValue = false;
    let helperFunctionName: string | undefined;
    let stateObjectProperty: string | undefined;
    let updatedProperty: string | undefined;

    for (const statement of body.getStatements()) {
      const trimmedVariable = this.extractTrimmedVariableName(statement, valueParamName);
      if (trimmedVariable) {
        normalizedValueName = trimmedVariable;
        trimValue = true;
        continue;
      }

      if (this.matchesEmptyGuard(statement, normalizedValueName)) {
        continue;
      }

      const equalityGuard = this.extractEqualityGuard(statement, hostParamName, normalizedValueName);
      if (equalityGuard) {
        stateObjectProperty ??= equalityGuard.stateObjectProperty;
        updatedProperty ??= equalityGuard.updatedProperty;
        continue;
      }

      const setterCall = this.extractHostStateSetterCall(statement, hostParamName, normalizedValueName);
      if (setterCall) {
        helperFunctionName = setterCall.helperFunctionName;
        stateObjectProperty ??= setterCall.stateObjectProperty;
        updatedProperty ??= setterCall.updatedProperty;
        continue;
      }

      return undefined;
    }

    if (!helperFunctionName || !stateObjectProperty || !updatedProperty) {
      return undefined;
    }

    return {
      helperFunctionName,
      stateObjectProperty,
      updatedProperty,
      trimValue,
    };
  }

  private analyzeHostStatePersistenceHelper(
    targetFile: SourceFile,
    helperFunctionName: string,
    stateObjectProperty: string,
    updatedProperty: string,
    sourceFilePath: string,
    targetFilePath: string,
  ):
    | {
        persistenceModule: string;
        persistenceModuleKind: PersistenceModuleKind;
        persistenceFunction: string;
        mirrorHostProperty?: string;
      }
    | undefined {
    const helperFunction = targetFile.getFunction(helperFunctionName);
    const body = helperFunction?.getBody();
    const hostParamName = helperFunction?.getParameters()[0]?.getName();
    const settingsParamName = helperFunction?.getParameters()[1]?.getName();
    if (
      !helperFunction ||
      !body ||
      !Node.isBlock(body) ||
      !hostParamName ||
      !settingsParamName ||
      helperFunction.getParameters().length !== 2
    ) {
      return undefined;
    }

    const settingsValueNames = new Set<string>([settingsParamName]);

    const collectedPattern = this.collectHostStatePersistencePattern(
      body.getStatements(),
      targetFile,
      hostParamName,
      stateObjectProperty,
      updatedProperty,
      settingsValueNames,
      settingsParamName,
      sourceFilePath,
      targetFilePath,
    );
    if (!collectedPattern) {
      return undefined;
    }

    return {
      persistenceModule: collectedPattern.persistenceModule,
      persistenceModuleKind: collectedPattern.persistenceModuleKind,
      persistenceFunction: collectedPattern.persistenceFunction,
      mirrorHostProperty: collectedPattern.mirrorHostProperty,
    };
  }

  private collectHostStatePersistencePattern(
    statements: Node[],
    targetFile: SourceFile,
    hostParamName: string,
    stateObjectProperty: string,
    updatedProperty: string,
    settingsValueNames: Set<string>,
    settingsParamName: string,
    sourceFilePath: string,
    targetFilePath: string,
  ):
    | {
        persistenceModule: string;
        persistenceModuleKind: PersistenceModuleKind;
        persistenceFunction: string;
        mirrorHostProperty?: string;
      }
    | undefined {
    let persistenceFunction: string | undefined;
    let persistenceModule: string | undefined;
    let persistenceModuleKind: PersistenceModuleKind | undefined;
    let mirrorHostProperty: string | undefined;

    for (const statement of statements) {
      const statementResult = this.classifyHostStateHelperStatement(
        targetFile,
        statement,
        hostParamName,
        stateObjectProperty,
        updatedProperty,
        settingsValueNames,
        settingsParamName,
        sourceFilePath,
        targetFilePath,
        persistenceFunction,
      );

      const nextPattern = this.applyHostStateHelperStatementResult(
        statementResult,
        settingsValueNames,
        persistenceFunction,
        persistenceModule,
        persistenceModuleKind,
        mirrorHostProperty,
      );
      if (!nextPattern) {
        return undefined;
      }

      persistenceFunction = nextPattern.persistenceFunction;
      persistenceModule = nextPattern.persistenceModule;
      persistenceModuleKind = nextPattern.persistenceModuleKind;
      mirrorHostProperty = nextPattern.mirrorHostProperty;
    }

    if (!persistenceFunction || !persistenceModule || !persistenceModuleKind) {
      return undefined;
    }

    return {
      persistenceModule,
      persistenceModuleKind,
      persistenceFunction,
      mirrorHostProperty,
    };
  }

  private applyHostStateHelperStatementResult(
    statementResult: HostStateHelperStatementResult,
    settingsValueNames: Set<string>,
    persistenceFunction: string | undefined,
    persistenceModule: string | undefined,
    persistenceModuleKind: PersistenceModuleKind | undefined,
    mirrorHostProperty: string | undefined,
  ):
    | {
        persistenceFunction: string | undefined;
        persistenceModule: string | undefined;
        persistenceModuleKind: PersistenceModuleKind | undefined;
        mirrorHostProperty: string | undefined;
      }
    | undefined {
    if (statementResult.kind === 'alias') {
      settingsValueNames.add(statementResult.settingsValueName);
      return {
        persistenceFunction,
        persistenceModule,
        persistenceModuleKind,
        mirrorHostProperty,
      };
    }

    if (statementResult.kind === 'host_assignment' || statementResult.kind === 'ignored') {
      return {
        persistenceFunction,
        persistenceModule,
        persistenceModuleKind,
        mirrorHostProperty,
      };
    }

    if (statementResult.kind === 'persistence') {
      if (persistenceFunction !== undefined) {
        return undefined;
      }

      return {
        persistenceFunction: statementResult.persistenceFunction,
        persistenceModule: statementResult.persistenceModule,
        persistenceModuleKind: statementResult.persistenceModuleKind,
        mirrorHostProperty,
      };
    }

    if (statementResult.kind === 'mirror') {
      if (this.isConflictingMirrorHostProperty(mirrorHostProperty, statementResult.mirrorHostProperty)) {
        return undefined;
      }

      return {
        persistenceFunction,
        persistenceModule,
        persistenceModuleKind,
        mirrorHostProperty: statementResult.mirrorHostProperty,
      };
    }

    return undefined;
  }

  private classifyHostStateHelperStatement(
    targetFile: SourceFile,
    statement: Node,
    hostParamName: string,
    stateObjectProperty: string,
    updatedProperty: string,
    settingsValueNames: ReadonlySet<string>,
    settingsParamName: string,
    sourceFilePath: string,
    targetFilePath: string,
    persistenceFunction: string | undefined,
  ): HostStateHelperStatementResult {
    const normalizedSettingsValue = this.extractSettingsAliasVariable(
      statement,
      settingsValueNames,
      settingsParamName,
      updatedProperty,
    );
    if (normalizedSettingsValue) {
      return { kind: 'alias', settingsValueName: normalizedSettingsValue };
    }

    const hostStateAssignment = [...settingsValueNames].some((settingsValueName) =>
      this.extractHostStateAssignment(statement, hostParamName, stateObjectProperty, settingsValueName),
    );
    if (hostStateAssignment) {
      return { kind: 'host_assignment' };
    }

    const persistenceCall = [...settingsValueNames]
      .map((settingsValueName) =>
        this.extractImportedPersistenceCall(targetFile, statement, settingsValueName, sourceFilePath, targetFilePath),
      )
      .find(Boolean);
    if (persistenceCall) {
      return {
        kind: 'persistence',
        persistenceFunction: persistenceCall.persistenceFunction,
        persistenceModule: persistenceCall.persistenceModule,
        persistenceModuleKind: persistenceCall.persistenceModuleKind,
      };
    }

    const mirrorAssignment = this.extractMirrorHostPropertyAssignment(
      statement,
      hostParamName,
      stateObjectProperty,
      updatedProperty,
      settingsValueNames,
    );
    if (mirrorAssignment) {
      return { kind: 'mirror', mirrorHostProperty: mirrorAssignment };
    }

    if (
      this.isIgnorableHostStateHelperStatement(
        targetFile,
        statement,
        hostParamName,
        stateObjectProperty,
        updatedProperty,
        settingsValueNames,
        persistenceFunction,
      )
    ) {
      return { kind: 'ignored' };
    }

    return { kind: 'reject' };
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

  private getImportLocalName(namedImport: { getAliasNode(): Identifier | undefined; getName(): string }): string {
    return namedImport.getAliasNode()?.getText() ?? namedImport.getName();
  }

  private hasConflictingLocalName(
    sourceFile: SourceFile,
    symbolName: string,
    allowedModuleKeys = new Set<string>(),
  ): boolean {
    return (
      this.hasConflictingLocalDeclaration(sourceFile, symbolName) ||
      this.hasConflictingImportBinding(sourceFile, symbolName, allowedModuleKeys)
    );
  }

  private isAllowedImportBinding(
    sourceFile: SourceFile,
    importDecl: ImportDeclaration,
    allowedModuleKeys: Set<string>,
  ): boolean {
    const moduleKey = this.getImportModuleKey(sourceFile, importDecl.getModuleSpecifierValue());
    return !!moduleKey && allowedModuleKeys.has(moduleKey);
  }

  private getImportModuleKey(sourceFile: SourceFile, moduleSpecifier: string): string | undefined {
    if (!moduleSpecifier.startsWith('.') && !path.isAbsolute(moduleSpecifier)) {
      return this.createPackageModuleKey(moduleSpecifier);
    }

    const resolvedPath = this.resolveModulePath(sourceFile.getFilePath(), moduleSpecifier);
    return resolvedPath ? this.createRepoFileModuleKey(this.toRepoRelativePath(resolvedPath)) : undefined;
  }

  private createRepoFileModuleKey(filePath: string): string {
    return `file:${this.normalizeRepoRelativePath(filePath)}`;
  }

  private createPackageModuleKey(packageName: string): string {
    return `pkg:${packageName}`;
  }

  private getPersistenceModuleKey(moduleKind: PersistenceModuleKind, persistenceModule: string): string {
    return moduleKind === 'repo_file'
      ? this.createRepoFileModuleKey(persistenceModule)
      : this.createPackageModuleKey(persistenceModule);
  }

  private hasConflictingLocalDeclaration(sourceFile: SourceFile, symbolName: string): boolean {
    return (
      sourceFile.getFunctions().some((declaration) => declaration.getName() === symbolName) ||
      sourceFile.getInterfaces().some((declaration) => declaration.getName() === symbolName) ||
      sourceFile.getTypeAliases().some((declaration) => declaration.getName() === symbolName) ||
      sourceFile.getClasses().some((declaration) => declaration.getName() === symbolName) ||
      sourceFile.getVariableDeclarations().some((declaration) => declaration.getName() === symbolName)
    );
  }

  private hasConflictingImportBinding(
    sourceFile: SourceFile,
    symbolName: string,
    allowedModuleKeys: Set<string>,
  ): boolean {
    for (const importDecl of sourceFile.getImportDeclarations()) {
      if (this.hasConflictingDefaultOrNamespaceImport(sourceFile, importDecl, symbolName, allowedModuleKeys)) {
        return true;
      }

      for (const namedImport of importDecl.getNamedImports()) {
        if (this.getImportLocalName(namedImport) !== symbolName) {
          continue;
        }

        if (this.isReusableNamedImport(sourceFile, importDecl, namedImport, symbolName, allowedModuleKeys)) {
          continue;
        }

        return true;
      }
    }

    return false;
  }

  private hasConflictingDefaultOrNamespaceImport(
    sourceFile: SourceFile,
    importDecl: ImportDeclaration,
    symbolName: string,
    allowedModuleKeys: Set<string>,
  ): boolean {
    const defaultImportMatches = importDecl.getDefaultImport()?.getText() === symbolName;
    const namespaceImportMatches = importDecl.getNamespaceImport()?.getText() === symbolName;

    return (
      (defaultImportMatches || namespaceImportMatches) &&
      !this.isAllowedImportBinding(sourceFile, importDecl, allowedModuleKeys)
    );
  }

  private isReusableNamedImport(
    sourceFile: SourceFile,
    importDecl: ImportDeclaration,
    namedImport: { getAliasNode(): Identifier | undefined; getName(): string },
    symbolName: string,
    allowedModuleKeys: Set<string>,
  ): boolean {
    return (
      this.isAllowedImportBinding(sourceFile, importDecl, allowedModuleKeys) &&
      namedImport.getName() === symbolName &&
      !namedImport.getAliasNode()
    );
  }

  private isConflictingMirrorHostProperty(currentProperty: string | undefined, nextProperty: string): boolean {
    return currentProperty !== undefined && currentProperty !== nextProperty;
  }

  private extractTrimmedVariableName(statement: Node, valueParamName: string): string | undefined {
    if (!Node.isVariableStatement(statement)) {
      return undefined;
    }

    const declaration = statement.getDeclarations()[0];
    const initializer = declaration?.getInitializer();
    if (!declaration || !initializer || !Node.isCallExpression(initializer)) {
      return undefined;
    }

    const expression = initializer.getExpression();
    if (!Node.isPropertyAccessExpression(expression) || expression.getName() !== 'trim') {
      return undefined;
    }

    return expression.getExpression().getText() === valueParamName ? declaration.getName() : undefined;
  }

  private matchesEmptyGuard(statement: Node, valueName: string): boolean {
    if (!Node.isIfStatement(statement)) {
      return false;
    }

    const expression = statement.getExpression();
    if (!Node.isPrefixUnaryExpression(expression) || expression.getOperatorToken() !== SyntaxKind.ExclamationToken) {
      return false;
    }

    return expression.getOperand().getText() === valueName && this.isImmediateReturn(statement.getThenStatement());
  }

  private extractEqualityGuard(
    statement: Node,
    hostParamName: string,
    valueName: string,
  ): { stateObjectProperty: string; updatedProperty: string } | undefined {
    if (!Node.isIfStatement(statement) || !this.isImmediateReturn(statement.getThenStatement())) {
      return undefined;
    }

    const expression = statement.getExpression();
    if (
      !Node.isBinaryExpression(expression) ||
      expression.getOperatorToken().getKind() !== SyntaxKind.EqualsEqualsEqualsToken
    ) {
      return undefined;
    }

    const leftChain = this.getPropertyAccessChain(expression.getLeft());
    if (
      !leftChain ||
      leftChain.length !== 3 ||
      leftChain[0] !== hostParamName ||
      expression.getRight().getText() !== valueName
    ) {
      return undefined;
    }

    return {
      stateObjectProperty: leftChain[1] ?? '',
      updatedProperty: leftChain[2] ?? '',
    };
  }

  private extractHostStateSetterCall(
    statement: Node,
    hostParamName: string,
    valueName: string,
  ): { helperFunctionName: string; stateObjectProperty: string; updatedProperty: string } | undefined {
    if (!Node.isExpressionStatement(statement)) {
      return undefined;
    }

    const expression = statement.getExpression();
    if (!Node.isCallExpression(expression) || !Node.isIdentifier(expression.getExpression())) {
      return undefined;
    }

    const [hostArgument, settingsArgument] = expression.getArguments();
    if (!hostArgument || !settingsArgument || hostArgument.getText() !== hostParamName) {
      return undefined;
    }

    if (!Node.isObjectLiteralExpression(settingsArgument)) {
      return undefined;
    }

    if (settingsArgument.getProperties().length !== 2) {
      return undefined;
    }

    const spreadAssignment = settingsArgument.getProperties().find((property) => Node.isSpreadAssignment(property));
    const propertyAssignment = settingsArgument.getProperties().find((property) => Node.isPropertyAssignment(property));
    if (!spreadAssignment || !propertyAssignment) {
      return undefined;
    }

    const spreadChain = this.getPropertyAccessChain(spreadAssignment.getExpression());
    if (!spreadChain || spreadChain.length !== 2 || spreadChain[0] !== hostParamName) {
      return undefined;
    }

    const initializer = propertyAssignment.getInitializer();
    if (!initializer || initializer.getText() !== valueName) {
      return undefined;
    }

    return {
      helperFunctionName: expression.getExpression().getText(),
      stateObjectProperty: spreadChain[1] ?? '',
      updatedProperty: propertyAssignment.getName(),
    };
  }

  private extractHostStateAssignment(
    statement: Node,
    hostParamName: string,
    stateObjectProperty: string,
    valueName: string,
  ): boolean {
    if (!Node.isExpressionStatement(statement)) {
      return false;
    }

    const expression = statement.getExpression();
    if (!Node.isBinaryExpression(expression) || expression.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) {
      return false;
    }

    const leftChain = this.getPropertyAccessChain(expression.getLeft());
    if (
      !leftChain ||
      leftChain.length !== 2 ||
      leftChain[0] !== hostParamName ||
      leftChain[1] !== stateObjectProperty ||
      !Node.isIdentifier(expression.getRight())
    ) {
      return false;
    }

    return expression.getRight().getText() === valueName;
  }

  private extractImportedPersistenceCall(
    sourceFile: SourceFile,
    statement: Node,
    settingsValueName: string,
    sourceFilePath: string,
    targetFilePath: string,
  ):
    | {
        persistenceFunction: string;
        persistenceModule: string;
        persistenceModuleKind: PersistenceModuleKind;
      }
    | undefined {
    if (!Node.isExpressionStatement(statement)) {
      return undefined;
    }

    const expression = statement.getExpression();
    if (!Node.isCallExpression(expression) || !Node.isIdentifier(expression.getExpression())) {
      return undefined;
    }

    const argument = expression.getArguments()[0];
    if (!argument || argument.getText() !== settingsValueName) {
      return undefined;
    }

    const importedBinding = this.findImportedBinding(sourceFile, expression.getExpression().getText());
    if (!importedBinding) {
      return undefined;
    }

    if (importedBinding.persistenceModuleKind === 'repo_file') {
      const sourceAbsolute = path.resolve(this.repoPath, sourceFilePath);
      const targetAbsolute = path.resolve(this.repoPath, targetFilePath);
      const persistenceAbsolute = path.resolve(this.repoPath, importedBinding.persistenceModule);
      if (persistenceAbsolute === sourceAbsolute || persistenceAbsolute === targetAbsolute) {
        return undefined;
      }
    }

    return importedBinding;
  }

  private extractMirrorHostPropertyAssignment(
    statement: Node,
    hostParamName: string,
    stateObjectProperty: string,
    updatedProperty: string,
    settingsValueNames: ReadonlySet<string>,
  ): string | undefined {
    if (!Node.isExpressionStatement(statement)) {
      return undefined;
    }

    const expression = statement.getExpression();
    if (!Node.isBinaryExpression(expression) || expression.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) {
      return undefined;
    }

    const leftChain = this.getPropertyAccessChain(expression.getLeft());
    const rightChain = this.getPropertyAccessChain(expression.getRight());
    if (
      !leftChain ||
      leftChain.length !== 2 ||
      leftChain[0] !== hostParamName ||
      !this.isMirrorAssignmentSource(
        rightChain,
        hostParamName,
        stateObjectProperty,
        updatedProperty,
        settingsValueNames,
      )
    ) {
      return undefined;
    }

    return leftChain[1];
  }

  private isMirrorAssignmentSource(
    rightChain: string[] | undefined,
    hostParamName: string,
    stateObjectProperty: string,
    updatedProperty: string,
    settingsValueNames: ReadonlySet<string>,
  ): boolean {
    if (!rightChain) {
      return false;
    }

    return (
      (rightChain.length === 3 &&
        rightChain[0] === hostParamName &&
        rightChain[1] === stateObjectProperty &&
        rightChain[2] === updatedProperty) ||
      (rightChain.length === 2 && settingsValueNames.has(rightChain[0] ?? '') && rightChain[1] === updatedProperty)
    );
  }

  private extractSettingsAliasVariable(
    statement: Node,
    settingsValueNames: ReadonlySet<string>,
    settingsParamName: string,
    updatedProperty: string,
  ): string | undefined {
    if (!Node.isVariableStatement(statement)) {
      return undefined;
    }

    const declaration = statement.getDeclarations()[0];
    const initializer = declaration?.getInitializer();
    if (
      !declaration ||
      declaration.getNameNode().getKind() !== SyntaxKind.Identifier ||
      !initializer ||
      !Node.isObjectLiteralExpression(initializer)
    ) {
      return undefined;
    }

    const hasSettingsSpread = initializer
      .getProperties()
      .some(
        (property) => Node.isSpreadAssignment(property) && settingsValueNames.has(property.getExpression().getText()),
      );
    if (!hasSettingsSpread) {
      return undefined;
    }

    const writesUpdatedProperty = initializer
      .getProperties()
      .some((property) => Node.isPropertyAssignment(property) && property.getName() === updatedProperty);
    if (!writesUpdatedProperty) {
      return undefined;
    }

    const initializerText = initializer.getText();
    if (!initializerText.includes(settingsParamName)) {
      return undefined;
    }

    return declaration.getName();
  }

  private isIgnorableHostStateHelperStatement(
    sourceFile: SourceFile,
    statement: Node,
    hostParamName: string,
    stateObjectProperty: string,
    updatedProperty: string,
    settingsValueNames: ReadonlySet<string>,
    persistenceFunction: string | undefined,
  ): boolean {
    if (Node.isReturnStatement(statement) || Node.isThrowStatement(statement)) {
      return false;
    }

    const propertyChains = statement
      .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
      .map((expression) => this.getPropertyAccessChain(expression))
      .filter((chain): chain is string[] => Array.isArray(chain));

    if (
      propertyChains.some(
        (chain) =>
          chain[0] === hostParamName &&
          chain[1] === stateObjectProperty &&
          (chain.length > 2 || chain[2] === updatedProperty),
      )
    ) {
      return false;
    }

    if (propertyChains.some((chain) => settingsValueNames.has(chain[0] ?? '') && chain[1] === updatedProperty)) {
      return false;
    }

    for (const callExpression of statement.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = callExpression.getExpression();
      if (!Node.isIdentifier(callee)) {
        continue;
      }

      if (persistenceFunction && callee.getText() === persistenceFunction) {
        return false;
      }

      if (this.findImportedBinding(sourceFile, callee.getText())) {
        return false;
      }
    }

    return true;
  }

  private findImportedBinding(
    sourceFile: SourceFile,
    localName: string,
  ):
    | {
        persistenceFunction: string;
        persistenceModule: string;
        persistenceModuleKind: 'package' | 'repo_file';
      }
    | undefined {
    for (const importDecl of sourceFile.getImportDeclarations()) {
      const moduleSpecifier = importDecl.getModuleSpecifierValue();

      if (importDecl.getDefaultImport()?.getText() === localName) {
        return this.toImportedBinding(moduleSpecifier, localName, sourceFile);
      }

      const namedImport = importDecl
        .getNamedImports()
        .find((candidate) => this.getImportLocalName(candidate) === localName);
      if (namedImport) {
        return this.toImportedBinding(moduleSpecifier, namedImport.getName(), sourceFile);
      }
    }

    return undefined;
  }

  private toImportedBinding(
    moduleSpecifier: string,
    localName: string,
    sourceFile: SourceFile,
  ): {
    persistenceFunction: string;
    persistenceModule: string;
    persistenceModuleKind: PersistenceModuleKind;
  } {
    if (!moduleSpecifier.startsWith('.') && !path.isAbsolute(moduleSpecifier)) {
      return {
        persistenceFunction: localName,
        persistenceModule: moduleSpecifier,
        persistenceModuleKind: 'package',
      };
    }

    const resolvedModulePath = this.resolveModulePath(sourceFile.getFilePath(), moduleSpecifier);
    return {
      persistenceFunction: localName,
      persistenceModule: resolvedModulePath ? this.toRepoRelativePath(resolvedModulePath) : moduleSpecifier,
      persistenceModuleKind: 'repo_file',
    };
  }

  private getPropertyAccessChain(node: Node): string[] | undefined {
    if (Node.isIdentifier(node)) {
      return [node.getText()];
    }

    if (!Node.isPropertyAccessExpression(node)) {
      return undefined;
    }

    const leftChain = this.getPropertyAccessChain(node.getExpression());
    return leftChain ? [...leftChain, node.getName()] : undefined;
  }

  private isImmediateReturn(statement: Node): boolean {
    if (Node.isReturnStatement(statement)) {
      return true;
    }

    const [firstStatement] = Node.isBlock(statement) ? statement.getStatements() : [];
    return (
      Node.isBlock(statement) &&
      statement.getStatements().length === 1 &&
      !!firstStatement &&
      Node.isReturnStatement(firstStatement)
    );
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
