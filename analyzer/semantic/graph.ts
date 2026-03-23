import {
  type ExportDeclaration,
  type ImportDeclaration,
  Node,
  type SourceFile,
  SyntaxKind,
  type VariableStatement,
} from 'ts-morph';
import type {
  CycleGraphSummary,
  DirectImportSearchResult,
  GraphExportEdge,
  GraphExportResolution,
  GraphImportEdge,
  GraphModuleSummary,
  GraphSymbolEdge,
  GraphSymbolNode,
} from './types.js';

interface BuildCycleGraphArgs {
  cycleFiles: string[];
  isWithinRepo: (absolutePath: string) => boolean;
  loadSourceFile: (repoRelativePath: string) => SourceFile | undefined;
  resolveModulePath: (filePath: string, moduleSpecifier: string) => string | undefined;
  toRepoRelativePath: (absolutePath: string) => string;
}

interface ImportedBindingTarget {
  localName: string;
  targetFile: string;
  targetSymbol: string;
}

interface LoadedGraphArtifacts {
  sourceFiles: Map<string, SourceFile>;
  modules: Map<string, GraphModuleSummary>;
  importEdges: GraphImportEdge[];
  exportEdges: GraphExportEdge[];
}

const EMPTY_GRAPH_SUMMARY: CycleGraphSummary = {
  modules: [],
  importEdges: [],
  exportEdges: [],
  symbolNodes: [],
  symbolEdges: [],
  symbolSccs: [],
  exportResolutions: [],
  patternCategories: [],
  metrics: {
    moduleCount: 0,
    importEdgeCount: 0,
    exportEdgeCount: 0,
    symbolNodeCount: 0,
    symbolEdgeCount: 0,
    symbolSccCount: 0,
    barrelModuleCount: 0,
    sideEffectModuleCount: 0,
    movableSymbolCount: 0,
    publicSeamModuleCount: 0,
    internalSurfaceModuleCount: 0,
    sharedModuleCount: 0,
    apiShimModuleCount: 0,
    pluginSdkModuleCount: 0,
    setupSurfaceModuleCount: 0,
    setupCoreModuleCount: 0,
    cycleValueEdgeCount: 0,
    cycleTypeEdgeCount: 0,
    cycleSideEffectEdgeCount: 0,
    cyclePublicSeamEdgeCount: 0,
    exportResolutionAmbiguityCount: 0,
    ownershipLocalizationEdgeCount: 0,
  },
};

const PUBLIC_SEAM_CATEGORIES = new Set(['api_shim', 'plugin_sdk_surface', 'setup_surface', 'setup_core']);

export function buildCycleGraph(args: BuildCycleGraphArgs): CycleGraphSummary {
  const cycleFiles = [...new Set(args.cycleFiles)];
  if (cycleFiles.length === 0) {
    return EMPTY_GRAPH_SUMMARY;
  }

  const { sourceFiles, modules, importEdges, exportEdges } = loadGraphArtifacts(cycleFiles, args);
  const symbolNodes = collectSymbolNodes(sourceFiles);
  const symbolNodeMap = new Map(symbolNodes.map((node) => [node.id, node]));
  const symbolEdges = collectSymbolEdges(sourceFiles, symbolNodeMap, importEdges);
  const symbolSccs = tarjanScc(symbolNodes, symbolEdges);
  const exportResolutions = buildExportResolutions(modules, exportEdges);
  const moduleSummaries = [...modules.values()];
  const moduleCategoryCounts = countModuleCategories(moduleSummaries);
  const cycleEdgeMetrics = summarizeCycleEdges(importEdges, modules);
  const ownershipLocalizationEdgeCount = countOwnershipLocalizationEdges(importEdges);
  const exportResolutionAmbiguityCount = exportResolutions.filter((resolution) => resolution.ambiguous).length;
  const patternCategories = inferGraphPatternCategories({
    modules: moduleSummaries,
    importEdges,
    exportEdges,
    exportResolutions,
    ownershipLocalizationEdgeCount,
    cycleEdgeMetrics,
  });

  return {
    modules: moduleSummaries,
    importEdges,
    exportEdges,
    symbolNodes,
    symbolEdges,
    symbolSccs,
    exportResolutions,
    patternCategories,
    metrics: {
      moduleCount: moduleSummaries.length,
      importEdgeCount: importEdges.length,
      exportEdgeCount: exportEdges.length,
      symbolNodeCount: symbolNodes.length,
      symbolEdgeCount: symbolEdges.length,
      symbolSccCount: symbolSccs.length,
      barrelModuleCount: moduleSummaries.filter((module) => module.moduleKind === 'pure_barrel').length,
      sideEffectModuleCount: moduleSummaries.filter((module) => module.hasTopLevelSideEffects).length,
      movableSymbolCount: symbolNodes.filter((node) => node.movable).length,
      publicSeamModuleCount: moduleCategoryCounts.publicSeamModuleCount,
      internalSurfaceModuleCount: moduleCategoryCounts.internalSurfaceModuleCount,
      sharedModuleCount: moduleCategoryCounts.sharedModuleCount,
      apiShimModuleCount: moduleCategoryCounts.apiShimModuleCount,
      pluginSdkModuleCount: moduleCategoryCounts.pluginSdkModuleCount,
      setupSurfaceModuleCount: moduleCategoryCounts.setupSurfaceModuleCount,
      setupCoreModuleCount: moduleCategoryCounts.setupCoreModuleCount,
      cycleValueEdgeCount: cycleEdgeMetrics.cycleValueEdgeCount,
      cycleTypeEdgeCount: cycleEdgeMetrics.cycleTypeEdgeCount,
      cycleSideEffectEdgeCount: cycleEdgeMetrics.cycleSideEffectEdgeCount,
      cyclePublicSeamEdgeCount: cycleEdgeMetrics.cyclePublicSeamEdgeCount,
      exportResolutionAmbiguityCount,
      ownershipLocalizationEdgeCount,
    },
  };
}

export function findDirectImportPlanFromGraph(
  graphSummary: CycleGraphSummary,
  cycleFiles: string[],
): DirectImportSearchResult {
  let sawBarrelScenario = false;
  let ambiguousResolution = false;
  const cycleFileSet = new Set(cycleFiles);
  const moduleByFile = new Map(graphSummary.modules.map((module) => [module.file, module]));
  const resolutionMap = new Map(
    graphSummary.exportResolutions.map((resolution) => [
      toResolutionKey(resolution.barrelFile, resolution.exportedName),
      resolution,
    ]),
  );

  for (const importEdge of graphSummary.importEdges) {
    const candidate = tryBuildDirectImportCandidate(importEdge, cycleFileSet, moduleByFile, resolutionMap);
    if (!candidate) {
      sawBarrelScenario ||= isReexportCycleEdge(importEdge, cycleFileSet, moduleByFile, resolutionMap);
      ambiguousResolution ||= isAmbiguousBarrelEdge(importEdge, cycleFileSet, moduleByFile, resolutionMap);
      continue;
    }

    return {
      sawBarrelScenario: true,
      ambiguousResolution,
      plan: [candidate],
    };
  }

  return {
    sawBarrelScenario,
    ambiguousResolution,
  };
}

function loadGraphArtifacts(cycleFiles: string[], args: BuildCycleGraphArgs): LoadedGraphArtifacts {
  const cycleFileSet = new Set(cycleFiles);
  const sourceFiles = new Map<string, SourceFile>();
  const modules = new Map<string, GraphModuleSummary>();
  const importEdgeMap = new Map<string, GraphImportEdge>();
  const exportEdgeMap = new Map<string, GraphExportEdge>();

  for (const file of cycleFiles) {
    const sourceFile = args.loadSourceFile(file);
    if (!sourceFile) {
      continue;
    }

    sourceFiles.set(file, sourceFile);
    modules.set(file, summarizeModule(sourceFile, file));

    for (const edge of collectImportEdges(sourceFile, file, cycleFileSet, args)) {
      importEdgeMap.set(importEdgeKey(edge), edge);
    }

    for (const edge of collectExportEdges(sourceFile, file, args)) {
      exportEdgeMap.set(exportEdgeKey(edge), edge);
    }
  }

  return {
    sourceFiles,
    modules,
    importEdges: [...importEdgeMap.values()],
    exportEdges: [...exportEdgeMap.values()],
  };
}

function summarizeModule(sourceFile: SourceFile, file: string): GraphModuleSummary {
  const declarations = collectTopLevelDeclarations(sourceFile);
  const exportedSymbols = [...sourceFile.getExportedDeclarations().keys()];
  const localSymbols = new Set(declarations.map((declaration) => declaration.symbol));
  const localExportedSymbols = exportedSymbols.filter((symbol) => localSymbols.has(symbol));
  const movableSymbols = declarations
    .filter((declaration) => declaration.movable)
    .map((declaration) => declaration.symbol);
  const statements = sourceFile.getStatements();
  const hasReExports = sourceFile.getExportDeclarations().some((decl) => Boolean(decl.getModuleSpecifierValue()));
  const hasOnlyImportExportStatements = statements.every(
    (statement) => Node.isImportDeclaration(statement) || Node.isExportDeclaration(statement),
  );
  const hasTopLevelSideEffects = statements.some((statement) => isSideEffectfulTopLevelStatement(statement));

  return {
    file,
    exportedSymbols,
    localExportedSymbols,
    movableSymbols,
    categories: classifyModuleCategories(file),
    moduleKind: determineModuleKind(hasReExports, hasOnlyImportExportStatements, hasTopLevelSideEffects),
    hasReExports,
    hasTopLevelSideEffects,
  };
}

function collectImportEdges(
  sourceFile: SourceFile,
  file: string,
  cycleFileSet: Set<string>,
  args: BuildCycleGraphArgs,
): GraphImportEdge[] {
  const edges: GraphImportEdge[] = [];

  for (const importDecl of sourceFile.getImportDeclarations()) {
    const targetFile = resolveImportEdgeTarget(file, importDecl.getModuleSpecifierValue(), args);
    if (!targetFile) {
      continue;
    }

    edges.push({
      from: file,
      to: targetFile,
      kind: getImportEdgeKind(importDecl),
      symbols: getImportSymbols(importDecl),
      withinCycle: cycleFileSet.has(targetFile),
    });
  }

  return edges;
}

function collectExportEdges(sourceFile: SourceFile, file: string, args: BuildCycleGraphArgs): GraphExportEdge[] {
  const edges: GraphExportEdge[] = [];

  for (const exportDecl of sourceFile.getExportDeclarations()) {
    const targetFile = resolveImportEdgeTarget(file, exportDecl.getModuleSpecifierValue(), args);
    if (!targetFile) {
      continue;
    }

    edges.push(...collectExportDeclarationEdges(exportDecl, file, targetFile));
  }

  return edges;
}

function collectExportDeclarationEdges(
  exportDecl: ExportDeclaration,
  file: string,
  targetFile: string,
): GraphExportEdge[] {
  const namespaceExport = exportDecl.getNamespaceExport();
  if (namespaceExport) {
    return [
      {
        from: file,
        to: targetFile,
        kind: 'namespace_reexport',
        exportedName: namespaceExport.getName(),
        localName: null,
      },
    ];
  }

  const namedExports = exportDecl.getNamedExports();
  if (namedExports.length === 0) {
    return [
      {
        from: file,
        to: targetFile,
        kind: 'namespace_reexport',
        exportedName: '*',
        localName: null,
      },
    ];
  }

  return namedExports.map((specifier) => ({
    from: file,
    to: targetFile,
    kind: 'named_reexport' as const,
    exportedName: specifier.getAliasNode()?.getText() ?? specifier.getNameNode().getText(),
    localName: specifier.getNameNode().getText(),
  }));
}

function collectSymbolNodes(sourceFiles: Map<string, SourceFile>): GraphSymbolNode[] {
  const nodes: GraphSymbolNode[] = [];

  for (const [file, sourceFile] of sourceFiles) {
    nodes.push(
      ...collectTopLevelDeclarations(sourceFile).map((node) => ({
        ...node,
        file,
        id: createSymbolNodeId(file, node.symbol),
      })),
    );
  }

  return nodes;
}

function collectSymbolEdges(
  sourceFiles: Map<string, SourceFile>,
  symbolNodeMap: Map<string, GraphSymbolNode>,
  importEdges: GraphImportEdge[],
): GraphSymbolEdge[] {
  const edges = new Map<string, GraphSymbolEdge>();
  const importBindingMap = buildImportBindingMap(sourceFiles, importEdges);

  for (const [file, sourceFile] of sourceFiles) {
    collectFileSymbolEdges(sourceFile, file, symbolNodeMap, importBindingMap.get(file) ?? [], edges);
  }

  return [...edges.values()];
}

function collectFileSymbolEdges(
  sourceFile: SourceFile,
  file: string,
  symbolNodeMap: Map<string, GraphSymbolNode>,
  importBindings: ImportedBindingTarget[],
  edges: Map<string, GraphSymbolEdge>,
): void {
  const localDeclarations = collectTopLevelDeclarations(sourceFile);
  const localSymbolMap = new Map(localDeclarations.map((declaration) => [declaration.symbol, declaration]));
  const importBindingMap = new Map(importBindings.map((binding) => [binding.localName, binding]));

  for (const declaration of localDeclarations) {
    const declarationNode = getDeclarationNode(sourceFile, declaration.symbol, declaration.kind);
    if (!declarationNode) {
      continue;
    }

    const fromId = createSymbolNodeId(file, declaration.symbol);
    for (const identifier of declarationNode.getDescendantsOfKind(SyntaxKind.Identifier)) {
      const identifierText = identifier.getText();
      if (identifierText === declaration.symbol) {
        continue;
      }

      const localTarget = localSymbolMap.get(identifierText);
      if (localTarget) {
        addSymbolEdge(edges, symbolNodeMap, fromId, createSymbolNodeId(file, localTarget.symbol), 'reference');
        continue;
      }

      const importedTarget = importBindingMap.get(identifierText);
      if (!importedTarget) {
        continue;
      }

      addSymbolEdge(
        edges,
        symbolNodeMap,
        fromId,
        createSymbolNodeId(importedTarget.targetFile, importedTarget.targetSymbol),
        'import',
      );
    }
  }
}

function addSymbolEdge(
  edges: Map<string, GraphSymbolEdge>,
  symbolNodeMap: Map<string, GraphSymbolNode>,
  from: string,
  to: string,
  kind: GraphSymbolEdge['kind'],
): void {
  if (from === to || !symbolNodeMap.has(from) || !symbolNodeMap.has(to)) {
    return;
  }

  edges.set(`${from}::${to}::${kind}`, {
    from,
    to,
    kind,
  });
}

function buildImportBindingMap(
  sourceFiles: Map<string, SourceFile>,
  importEdges: GraphImportEdge[],
): Map<string, ImportedBindingTarget[]> {
  const map = new Map<string, ImportedBindingTarget[]>();

  for (const [file, sourceFile] of sourceFiles) {
    const bindings: ImportedBindingTarget[] = [];

    for (const importDecl of sourceFile.getImportDeclarations()) {
      const matchingEdge = importEdges.find(
        (edge) =>
          edge.from === file &&
          edge.symbols.length === importDecl.getNamedImports().length &&
          edge.symbols.every((symbol) =>
            importDecl.getNamedImports().some((namedImport) => namedImport.getName() === symbol),
          ),
      );
      if (!matchingEdge) {
        continue;
      }

      for (const namedImport of importDecl.getNamedImports()) {
        bindings.push({
          localName: namedImport.getAliasNode()?.getText() ?? namedImport.getName(),
          targetFile: matchingEdge.to,
          targetSymbol: namedImport.getName(),
        });
      }
    }

    map.set(file, bindings);
  }

  return map;
}

function buildExportResolutions(
  modules: Map<string, GraphModuleSummary>,
  exportEdges: GraphExportEdge[],
): GraphExportResolution[] {
  const resolutions: GraphExportResolution[] = [];

  for (const module of modules.values()) {
    if (!module.hasReExports) {
      continue;
    }

    const exportedNames = new Set([
      ...module.exportedSymbols,
      ...exportEdges.filter((edge) => edge.from === module.file).map((edge) => edge.exportedName),
    ]);

    for (const exportedName of exportedNames) {
      if (exportedName === '*') {
        continue;
      }

      const resolution = resolveExportedSymbolFromGraph(modules, exportEdges, module.file, exportedName, new Set());
      resolutions.push({
        barrelFile: module.file,
        exportedName,
        targetFile: resolution?.targetFile ?? null,
        targetSymbol: resolution?.targetSymbol ?? null,
        ambiguous: resolution?.ambiguous ?? false,
      });
    }
  }

  return resolutions;
}

function resolveExportedSymbolFromGraph(
  modules: Map<string, GraphModuleSummary>,
  exportEdges: GraphExportEdge[],
  moduleFile: string,
  exportedName: string,
  visited: Set<string>,
): { targetFile: string | null; targetSymbol: string | null; ambiguous: boolean } | undefined {
  const visitKey = `${moduleFile}::${exportedName}`;
  if (visited.has(visitKey)) {
    return {
      targetFile: null,
      targetSymbol: null,
      ambiguous: true,
    };
  }

  visited.add(visitKey);
  const module = modules.get(moduleFile);
  if (!module) {
    return undefined;
  }

  const localResolution = resolveLocalExport(module, moduleFile, exportedName);
  if (localResolution) {
    return localResolution;
  }

  const candidateEdges = collectCandidateExportEdges(exportEdges, moduleFile, exportedName);
  if (candidateEdges.length === 0) {
    return undefined;
  }

  let resolvedTarget: { targetFile: string | null; targetSymbol: string | null; ambiguous: boolean } | undefined;
  for (const edge of candidateEdges) {
    const resolved = resolveCandidateExportEdge(modules, exportEdges, edge, exportedName, visited);
    if (!resolved || resolved.ambiguous) {
      return {
        targetFile: null,
        targetSymbol: null,
        ambiguous: true,
      };
    }

    if (
      resolvedTarget &&
      (resolvedTarget.targetFile !== resolved.targetFile || resolvedTarget.targetSymbol !== resolved.targetSymbol)
    ) {
      return {
        targetFile: null,
        targetSymbol: null,
        ambiguous: true,
      };
    }

    resolvedTarget = resolved;
  }

  return resolvedTarget;
}

function resolveLocalExport(
  module: GraphModuleSummary,
  moduleFile: string,
  exportedName: string,
): { targetFile: string | null; targetSymbol: string | null; ambiguous: boolean } | undefined {
  if (!module.localExportedSymbols.includes(exportedName)) {
    return undefined;
  }

  return {
    targetFile: moduleFile,
    targetSymbol: exportedName,
    ambiguous: false,
  };
}

function collectCandidateExportEdges(
  exportEdges: GraphExportEdge[],
  moduleFile: string,
  exportedName: string,
): GraphExportEdge[] {
  const matchingEdges = exportEdges.filter((edge) => edge.from === moduleFile && edge.exportedName === exportedName);
  const wildcardEdges = exportEdges.filter((edge) => edge.from === moduleFile && edge.exportedName === '*');
  return [...matchingEdges, ...wildcardEdges];
}

function resolveCandidateExportEdge(
  modules: Map<string, GraphModuleSummary>,
  exportEdges: GraphExportEdge[],
  edge: GraphExportEdge,
  exportedName: string,
  visited: Set<string>,
): { targetFile: string | null; targetSymbol: string | null; ambiguous: boolean } | undefined {
  if (edge.kind === 'namespace_reexport' && edge.exportedName !== '*') {
    return {
      targetFile: null,
      targetSymbol: null,
      ambiguous: true,
    };
  }

  const nextExportName = edge.exportedName === '*' ? exportedName : edge.localName;
  if (!nextExportName) {
    return {
      targetFile: null,
      targetSymbol: null,
      ambiguous: true,
    };
  }

  return resolveTargetExport(modules, exportEdges, edge.to, nextExportName, visited);
}

function resolveTargetExport(
  modules: Map<string, GraphModuleSummary>,
  exportEdges: GraphExportEdge[],
  targetFile: string,
  exportedName: string,
  visited: Set<string>,
): { targetFile: string | null; targetSymbol: string | null; ambiguous: boolean } | undefined {
  if (!modules.has(targetFile)) {
    return {
      targetFile,
      targetSymbol: exportedName,
      ambiguous: false,
    };
  }

  return resolveExportedSymbolFromGraph(modules, exportEdges, targetFile, exportedName, new Set(visited));
}

function tryBuildDirectImportCandidate(
  importEdge: GraphImportEdge,
  cycleFileSet: Set<string>,
  moduleByFile: Map<string, GraphModuleSummary>,
  resolutionMap: Map<string, GraphExportResolution>,
): NonNullable<DirectImportSearchResult['plan']>[number] | undefined {
  if (!isReexportCycleEdge(importEdge, cycleFileSet, moduleByFile, resolutionMap)) {
    return undefined;
  }

  if (importEdge.symbols.length === 0) {
    return undefined;
  }

  const resolvedTargets = importEdge.symbols.map((symbol) =>
    symbol === 'default' || symbol === '*' ? undefined : resolutionMap.get(toResolutionKey(importEdge.to, symbol)),
  );
  if (
    resolvedTargets.some(
      (resolution) =>
        !resolution ||
        resolution.ambiguous ||
        !resolution.targetFile ||
        !resolution.targetSymbol ||
        resolution.targetFile === importEdge.to ||
        cycleFileSet.has(resolution.targetFile),
    )
  ) {
    return undefined;
  }

  const targetFile = resolvedTargets[0]?.targetFile;
  if (!targetFile || resolvedTargets.some((resolution) => resolution?.targetFile !== targetFile)) {
    return undefined;
  }

  return {
    sourceFile: importEdge.from,
    barrelFile: importEdge.to,
    targetFile,
    symbols: resolvedTargets
      .map((resolution) => resolution?.targetSymbol)
      .filter((symbol): symbol is string => typeof symbol === 'string'),
  };
}

function isAmbiguousBarrelEdge(
  importEdge: GraphImportEdge,
  cycleFileSet: Set<string>,
  moduleByFile: Map<string, GraphModuleSummary>,
  resolutionMap: Map<string, GraphExportResolution>,
): boolean {
  if (!isReexportCycleEdge(importEdge, cycleFileSet, moduleByFile, resolutionMap)) {
    return false;
  }

  return importEdge.symbols.some((symbol) => {
    if (symbol === 'default' || symbol === '*') {
      return true;
    }

    const resolution = resolutionMap.get(toResolutionKey(importEdge.to, symbol));
    return !resolution || resolution.ambiguous || !resolution.targetFile || !resolution.targetSymbol;
  });
}

function isReexportCycleEdge(
  importEdge: GraphImportEdge,
  cycleFileSet: Set<string>,
  moduleByFile: Map<string, GraphModuleSummary>,
  resolutionMap: Map<string, GraphExportResolution>,
): boolean {
  if (!cycleFileSet.has(importEdge.from) || !cycleFileSet.has(importEdge.to)) {
    return false;
  }

  const targetModule = moduleByFile.get(importEdge.to);
  if (!targetModule || !targetModule.hasReExports || targetModule.hasTopLevelSideEffects) {
    return false;
  }

  if (targetModule.moduleKind === 'pure_barrel') {
    return true;
  }

  return importEdge.symbols.some((symbol) => {
    if (symbol === 'default' || symbol === '*') {
      return false;
    }

    const resolution = resolutionMap.get(toResolutionKey(importEdge.to, symbol));
    return Boolean(
      resolution &&
        !resolution.ambiguous &&
        resolution.targetFile &&
        resolution.targetFile !== importEdge.to &&
        !cycleFileSet.has(resolution.targetFile),
    );
  });
}

function tarjanScc(nodes: GraphSymbolNode[], edges: GraphSymbolEdge[]): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) {
    adjacency.set(node.id, []);
  }
  for (const edge of edges) {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
  }

  let index = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  function strongConnect(nodeId: string) {
    indices.set(nodeId, index);
    lowLinks.set(nodeId, index);
    index += 1;
    stack.push(nodeId);
    onStack.add(nodeId);

    for (const nextId of adjacency.get(nodeId) ?? []) {
      if (!indices.has(nextId)) {
        strongConnect(nextId);
        lowLinks.set(nodeId, Math.min(lowLinks.get(nodeId) ?? 0, lowLinks.get(nextId) ?? 0));
        continue;
      }

      if (onStack.has(nextId)) {
        lowLinks.set(nodeId, Math.min(lowLinks.get(nodeId) ?? 0, indices.get(nextId) ?? 0));
      }
    }

    if ((lowLinks.get(nodeId) ?? 0) !== (indices.get(nodeId) ?? 0)) {
      return;
    }

    const component: string[] = [];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        break;
      }
      onStack.delete(current);
      component.push(current);
      if (current === nodeId) {
        break;
      }
    }

    if (component.length > 1) {
      components.push(component);
    }
  }

  for (const node of nodes) {
    if (!indices.has(node.id)) {
      strongConnect(node.id);
    }
  }

  return components;
}

function collectTopLevelDeclarations(sourceFile: SourceFile): Array<Omit<GraphSymbolNode, 'file' | 'id'>> {
  const declarations: Array<Omit<GraphSymbolNode, 'file' | 'id'>> = [];

  for (const declaration of sourceFile.getFunctions()) {
    const name = declaration.getName();
    if (!name) {
      continue;
    }
    declarations.push({ symbol: name, kind: 'function', exported: declaration.isExported(), movable: true });
  }

  for (const declaration of sourceFile.getInterfaces()) {
    declarations.push({
      symbol: declaration.getName(),
      kind: 'interface',
      exported: declaration.isExported(),
      movable: true,
    });
  }

  for (const declaration of sourceFile.getTypeAliases()) {
    declarations.push({
      symbol: declaration.getName(),
      kind: 'type_alias',
      exported: declaration.isExported(),
      movable: true,
    });
  }

  for (const statement of sourceFile.getVariableStatements()) {
    for (const declaration of statement.getDeclarations()) {
      if (declaration.getNameNode().getKind() !== SyntaxKind.Identifier) {
        continue;
      }
      declarations.push({
        symbol: declaration.getName(),
        kind: 'variable',
        exported: statement.isExported(),
        movable: true,
      });
    }
  }

  for (const declaration of sourceFile.getClasses()) {
    const name = declaration.getName();
    if (!name) {
      continue;
    }
    declarations.push({ symbol: name, kind: 'class', exported: declaration.isExported(), movable: false });
  }

  for (const declaration of sourceFile.getEnums()) {
    declarations.push({
      symbol: declaration.getName(),
      kind: 'enum',
      exported: declaration.isExported(),
      movable: false,
    });
  }

  return declarations;
}

function getDeclarationNode(
  sourceFile: SourceFile,
  symbol: string,
  kind: GraphSymbolNode['kind'],
): SourceFile | Node | VariableStatement | undefined {
  switch (kind) {
    case 'function': {
      return sourceFile.getFunction(symbol);
    }
    case 'interface': {
      return sourceFile.getInterface(symbol);
    }
    case 'type_alias': {
      return sourceFile.getTypeAlias(symbol);
    }
    case 'variable': {
      return sourceFile.getVariableDeclaration(symbol)?.getVariableStatement();
    }
    case 'class': {
      return sourceFile.getClass(symbol);
    }
    case 'enum': {
      return sourceFile.getEnum(symbol);
    }
    default: {
      return undefined;
    }
  }
}

function createSymbolNodeId(file: string, symbol: string): string {
  return `${file}::${symbol}`;
}

function classifyModuleCategories(file: string): string[] {
  const normalizedFile = file.replaceAll('\\', '/').toLowerCase();
  const basename = normalizedFile.split('/').pop() ?? normalizedFile;
  const categories = new Set<string>();

  if (/^api\.[cm]?[jt]sx?$/.test(basename) || normalizedFile.includes('/api.')) {
    categories.add('api_shim');
  }
  if (normalizedFile.includes('/plugin-sdk/')) {
    categories.add('plugin_sdk_surface');
  }
  if (/^setup-surface\.[cm]?[jt]sx?$/.test(basename) || normalizedFile.includes('/setup-surface.')) {
    categories.add('setup_surface');
  }
  if (/^setup-core\.[cm]?[jt]sx?$/.test(basename) || normalizedFile.includes('/setup-core.')) {
    categories.add('setup_core');
  }
  if (
    /^internal\.[cm]?[jt]sx?$/.test(basename) ||
    normalizedFile.includes('/internal/') ||
    normalizedFile.includes('/plugin-sdk-internal/')
  ) {
    categories.add('internal_surface');
  }
  if (normalizedFile.includes('.shared.')) {
    categories.add('shared_module');
  }
  if (/^index\.[cm]?[jt]sx?$/.test(basename)) {
    categories.add('barrel_entrypoint');
  }

  return [...categories];
}

function countModuleCategories(modules: GraphModuleSummary[]) {
  const counts = {
    publicSeamModuleCount: 0,
    internalSurfaceModuleCount: 0,
    sharedModuleCount: 0,
    apiShimModuleCount: 0,
    pluginSdkModuleCount: 0,
    setupSurfaceModuleCount: 0,
    setupCoreModuleCount: 0,
  };

  for (const module of modules) {
    const categorySet = new Set(module.categories);
    if ([...categorySet].some((category) => PUBLIC_SEAM_CATEGORIES.has(category))) {
      counts.publicSeamModuleCount += 1;
    }
    if (categorySet.has('internal_surface')) {
      counts.internalSurfaceModuleCount += 1;
    }
    if (categorySet.has('shared_module')) {
      counts.sharedModuleCount += 1;
    }
    if (categorySet.has('api_shim')) {
      counts.apiShimModuleCount += 1;
    }
    if (categorySet.has('plugin_sdk_surface')) {
      counts.pluginSdkModuleCount += 1;
    }
    if (categorySet.has('setup_surface')) {
      counts.setupSurfaceModuleCount += 1;
    }
    if (categorySet.has('setup_core')) {
      counts.setupCoreModuleCount += 1;
    }
  }

  return counts;
}

function summarizeCycleEdges(
  importEdges: GraphImportEdge[],
  modules: Map<string, GraphModuleSummary>,
): {
  cycleValueEdgeCount: number;
  cycleTypeEdgeCount: number;
  cycleSideEffectEdgeCount: number;
  cyclePublicSeamEdgeCount: number;
} {
  let cycleValueEdgeCount = 0;
  let cycleTypeEdgeCount = 0;
  let cycleSideEffectEdgeCount = 0;
  let cyclePublicSeamEdgeCount = 0;

  for (const edge of importEdges) {
    if (!edge.withinCycle) {
      continue;
    }

    if (edge.kind === 'value') {
      cycleValueEdgeCount += 1;
    } else if (edge.kind === 'type') {
      cycleTypeEdgeCount += 1;
    } else {
      cycleSideEffectEdgeCount += 1;
    }

    const sourceCategories = new Set(modules.get(edge.from)?.categories);
    const targetCategories = new Set(modules.get(edge.to)?.categories);
    if (
      [...sourceCategories].some((category) => PUBLIC_SEAM_CATEGORIES.has(category)) ||
      [...targetCategories].some((category) => PUBLIC_SEAM_CATEGORIES.has(category))
    ) {
      cyclePublicSeamEdgeCount += 1;
    }
  }

  return {
    cycleValueEdgeCount,
    cycleTypeEdgeCount,
    cycleSideEffectEdgeCount,
    cyclePublicSeamEdgeCount,
  };
}

function countOwnershipLocalizationEdges(importEdges: GraphImportEdge[]): number {
  const cycleValueEdges = importEdges.filter((edge) => edge.withinCycle && edge.kind === 'value');
  const hasOpposingNonSetterEdge = (candidate: GraphImportEdge) =>
    cycleValueEdges.some(
      (edge) =>
        edge.from === candidate.to &&
        edge.to === candidate.from &&
        edge.symbols.some((symbol) => !isSetterLikeSymbol(symbol)),
    );

  return cycleValueEdges.filter(
    (edge) => edge.symbols.some((symbol) => isSetterLikeSymbol(symbol)) && hasOpposingNonSetterEdge(edge),
  ).length;
}

function inferGraphPatternCategories(args: {
  modules: GraphModuleSummary[];
  importEdges: GraphImportEdge[];
  exportEdges: GraphExportEdge[];
  exportResolutions: GraphExportResolution[];
  ownershipLocalizationEdgeCount: number;
  cycleEdgeMetrics: {
    cycleValueEdgeCount: number;
    cycleTypeEdgeCount: number;
    cycleSideEffectEdgeCount: number;
    cyclePublicSeamEdgeCount: number;
  };
}): string[] {
  const labels = new Set<string>();
  const moduleCategories = new Set<string>();
  for (const module of args.modules) {
    for (const category of module.categories ?? []) {
      moduleCategories.add(category);
    }
  }
  const reexportImportEdges = args.importEdges.filter((edge) => {
    const targetModule = args.modules.find((module) => module.file === edge.to);
    return edge.withinCycle && targetModule?.hasReExports;
  });

  if (args.exportEdges.length > 0 || reexportImportEdges.length > 0) {
    labels.add('barrel_reexport_cleanup');
  }
  if (args.cycleEdgeMetrics.cyclePublicSeamEdgeCount > 0) {
    labels.add('public_seam_bypass');
  }
  if (
    args.exportEdges.length > 0 &&
    (args.cycleEdgeMetrics.cyclePublicSeamEdgeCount > 0 ||
      moduleCategories.has('api_shim') ||
      moduleCategories.has('plugin_sdk_surface') ||
      moduleCategories.has('setup_surface') ||
      moduleCategories.has('setup_core'))
  ) {
    labels.add('export_graph_rewrite');
  }
  if (args.ownershipLocalizationEdgeCount > 0) {
    labels.add('ownership_localization');
    labels.add('host_owned_state_update');
  }
  if (moduleCategories.has('internal_surface')) {
    labels.add('internal_surface_split');
  }

  return [...labels];
}

function isSetterLikeSymbol(symbol: string): boolean {
  return /^(set|update|apply|assign)[A-Z_]/.test(symbol);
}

function determineModuleKind(
  hasReExports: boolean,
  hasOnlyImportExportStatements: boolean,
  hasTopLevelSideEffects: boolean,
): GraphModuleSummary['moduleKind'] {
  if (hasReExports && hasOnlyImportExportStatements && !hasTopLevelSideEffects) {
    return 'pure_barrel';
  }

  if (!hasTopLevelSideEffects) {
    return 'declaration_only';
  }

  return 'mixed';
}

function getImportEdgeKind(importDecl: ImportDeclaration): GraphImportEdge['kind'] {
  if (importDecl.isTypeOnly()) {
    return 'type';
  }

  if (importDecl.getNamedImports().length === 0 && !importDecl.getDefaultImport() && !importDecl.getNamespaceImport()) {
    return 'side_effect';
  }

  return 'value';
}

function getImportSymbols(importDecl: ImportDeclaration): string[] {
  const symbols = importDecl.getNamedImports().map((namedImport) => namedImport.getName());
  if (importDecl.getDefaultImport()) {
    symbols.push('default');
  }
  if (importDecl.getNamespaceImport()) {
    symbols.push('*');
  }
  return symbols;
}

function isRepoImport(moduleSpecifier: string): boolean {
  return moduleSpecifier.startsWith('.') || moduleSpecifier.startsWith('/');
}

function resolveImportEdgeTarget(
  sourceFilePath: string,
  moduleSpecifier: string | undefined,
  args: BuildCycleGraphArgs,
): string | undefined {
  if (!moduleSpecifier || !isRepoImport(moduleSpecifier)) {
    return undefined;
  }

  const absolutePath = args.resolveModulePath(sourceFilePath, moduleSpecifier);
  if (!absolutePath || !args.isWithinRepo(absolutePath)) {
    return undefined;
  }

  return args.toRepoRelativePath(absolutePath);
}

function toResolutionKey(barrelFile: string, exportedName: string): string {
  return `${barrelFile}::${exportedName}`;
}

function importEdgeKey(edge: GraphImportEdge): string {
  return `${edge.from}::${edge.to}::${edge.kind}::${edge.symbols.join(',')}`;
}

function exportEdgeKey(edge: GraphExportEdge): string {
  return `${edge.from}::${edge.to}::${edge.kind}::${edge.exportedName}::${edge.localName ?? 'null'}`;
}

function isSideEffectfulTopLevelStatement(statement: Node): boolean {
  if (Node.isImportDeclaration(statement) || Node.isExportDeclaration(statement)) {
    return false;
  }

  if (
    Node.isFunctionDeclaration(statement) ||
    Node.isInterfaceDeclaration(statement) ||
    Node.isTypeAliasDeclaration(statement) ||
    Node.isClassDeclaration(statement) ||
    Node.isEnumDeclaration(statement)
  ) {
    return false;
  }

  if (Node.isVariableStatement(statement)) {
    return statement
      .getDeclarations()
      .some((declaration) => declaration.getInitializer()?.getDescendantsOfKind(SyntaxKind.CallExpression).length);
  }

  return true;
}
