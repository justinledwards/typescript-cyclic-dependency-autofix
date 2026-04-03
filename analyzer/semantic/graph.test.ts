import path from 'node:path';
import { Project, type SourceFile } from 'ts-morph';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildCycleGraph, findDirectImportPlanFromGraph } from './graph.js';

const REPO_ROOT = '/dummy/repo';
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

describe('semantic graph core', () => {
  let project: Project;

  beforeEach(() => {
    project = new Project({
      compilerOptions: {
        allowJs: true,
        resolveJsonModule: true,
      },
      skipAddingFilesFromTsConfig: true,
    });
  });

  it('builds barrel/export summaries and finds direct-import rewrites from the graph', () => {
    project.createSourceFile(
      path.join(REPO_ROOT, 'app.ts'),
      `
      import { Foo } from './index';
      export const appValue = Foo + 1;
    `,
    );
    project.createSourceFile(
      path.join(REPO_ROOT, 'index.ts'),
      `
      export { Foo } from './foo';
      export { Bar } from './bar';
    `,
    );
    project.createSourceFile(path.join(REPO_ROOT, 'foo.ts'), 'export const Foo = 1;');
    project.createSourceFile(
      path.join(REPO_ROOT, 'bar.ts'),
      `
      import { appValue } from './app';
      export const Bar = appValue + 1;
    `,
    );

    const cycleFiles = ['app.ts', 'index.ts', 'bar.ts', 'app.ts'];
    const graph = buildCycleGraph(createGraphArgs(project, cycleFiles));
    const directImport = findDirectImportPlanFromGraph(graph, cycleFiles);

    expect(graph.metrics).toMatchObject({
      moduleCount: 3,
      barrelModuleCount: 1,
      exportEdgeCount: 2,
      symbolNodeCount: 2,
      publicSeamModuleCount: 0,
      cyclePublicSeamEdgeCount: 0,
      exportResolutionAmbiguityCount: 0,
    });
    expect(graph.patternCategories).toEqual(expect.arrayContaining(['barrel_reexport_cleanup']));
    expect(graph.modules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: 'index.ts',
          categories: expect.arrayContaining(['barrel_entrypoint']),
          moduleKind: 'pure_barrel',
          hasReExports: true,
          hasTopLevelSideEffects: false,
        }),
      ]),
    );
    expect(graph.exportResolutions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          barrelFile: 'index.ts',
          exportedName: 'Foo',
          targetFile: 'foo.ts',
          targetSymbol: 'Foo',
          ambiguous: false,
        }),
      ]),
    );
    expect(directImport).toEqual({
      sawBarrelScenario: true,
      ambiguousResolution: false,
      plan: [
        {
          sourceFile: 'app.ts',
          barrelFile: 'index.ts',
          targetFile: 'foo.ts',
          symbols: ['Foo'],
        },
      ],
    });
  });

  it('computes symbol-level SCCs for mutually dependent declarations', () => {
    project.createSourceFile(
      path.join(REPO_ROOT, 'a.ts'),
      `
      import { bValue } from './b';
      export const aValue = bValue + 1;
    `,
    );
    project.createSourceFile(
      path.join(REPO_ROOT, 'b.ts'),
      `
      import { aValue } from './a';
      export const bValue = aValue + 1;
    `,
    );

    const graph = buildCycleGraph(createGraphArgs(project, ['a.ts', 'b.ts', 'a.ts']));

    expect(graph.metrics).toMatchObject({
      symbolNodeCount: 2,
      symbolEdgeCount: 2,
      symbolSccCount: 1,
      movableSymbolCount: 2,
    });
    expect(graph.symbolSccs).toHaveLength(1);
    expect(graph.symbolSccs[0]).toEqual(expect.arrayContaining(['a.ts::aValue', 'b.ts::bValue']));
    expect(graph.importEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'a.ts', to: 'b.ts', withinCycle: true }),
        expect.objectContaining({ from: 'b.ts', to: 'a.ts', withinCycle: true }),
      ]),
    );
  });

  it('tags public seam and export-graph rewrite patterns from the graph', () => {
    project.createSourceFile(
      path.join(REPO_ROOT, 'consumer.ts'),
      `
      import { setSessionKey } from './api.ts';
      export function boot(host: unknown) {
        setSessionKey(host, 'next');
      }
    `,
    );
    project.createSourceFile(
      path.join(REPO_ROOT, 'api.ts'),
      `
      export { setSessionKey } from './settings.ts';
      export { readSessionKey } from './settings.ts';
    `,
    );
    project.createSourceFile(
      path.join(REPO_ROOT, 'settings.ts'),
      `
      import { boot } from './consumer.ts';
      export function setSessionKey(_host: unknown, _next: string) {
        boot({});
      }
      export function readSessionKey() {
        return 'main';
      }
    `,
    );

    const graph = buildCycleGraph(createGraphArgs(project, ['consumer.ts', 'api.ts', 'settings.ts', 'consumer.ts']));

    expect(graph.metrics).toMatchObject({
      publicSeamModuleCount: 1,
      apiShimModuleCount: 1,
      cyclePublicSeamEdgeCount: 1,
      ownershipLocalizationEdgeCount: 0,
    });
    expect(graph.patternCategories).toEqual(expect.arrayContaining(['public_seam_bypass', 'export_graph_rewrite']));
    expect(graph.modules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: 'api.ts',
          categories: expect.arrayContaining(['api_shim']),
        }),
      ]),
    );
  });

  it('tags mixed type/runtime split patterns when a barrel exposes both type and value imports', () => {
    project.createSourceFile(
      path.join(REPO_ROOT, 'app.ts'),
      `
      import type { FooConfig } from './index';
      import { makeFoo } from './index';
      export const appValue = makeFoo();
      export type AppConfig = FooConfig & { enabled: boolean };
    `,
    );
    project.createSourceFile(
      path.join(REPO_ROOT, 'index.ts'),
      `
      import { appValue } from './app';
      export { makeFoo } from './foo';
      export type { FooConfig } from './foo';
      export const indexValue = appValue;
    `,
    );
    project.createSourceFile(
      path.join(REPO_ROOT, 'foo.ts'),
      `
      export interface FooConfig {
        value: number;
      }
      export const makeFoo = () => 1;
    `,
    );

    const graph = buildCycleGraph(createGraphArgs(project, ['app.ts', 'index.ts', 'app.ts']));

    expect(graph.metrics).toMatchObject({
      cycleTypeEdgeCount: 1,
      cycleValueEdgeCount: 2,
    });
    expect(graph.patternCategories).toEqual(expect.arrayContaining(['type_runtime_split', 'type_value_split']));
  });

  it('tags ownership-localization edges in two-file setter cycles', () => {
    project.createSourceFile(
      path.join(REPO_ROOT, 'chat.ts'),
      `
      import { setSessionKey } from './settings';
      export function refreshChat() {}
      export function run(host: unknown) {
        setSessionKey(host, 'next');
      }
    `,
    );
    project.createSourceFile(
      path.join(REPO_ROOT, 'settings.ts'),
      `
      import { refreshChat } from './chat';
      export function setSessionKey(_host: unknown, _next: string) {
        refreshChat();
      }
    `,
    );

    const graph = buildCycleGraph(createGraphArgs(project, ['chat.ts', 'settings.ts', 'chat.ts']));

    expect(graph.metrics).toMatchObject({
      cycleValueEdgeCount: 2,
      ownershipLocalizationEdgeCount: 1,
    });
    expect(graph.patternCategories).toEqual(
      expect.arrayContaining(['ownership_localization', 'host_owned_state_update']),
    );
  });
});

function createGraphArgs(project: Project, cycleFiles: string[]) {
  return {
    cycleFiles,
    isWithinRepo: (absolutePath: string) => normalizePath(absolutePath).startsWith(`${REPO_ROOT}/`),
    loadSourceFile: (repoRelativePath: string) => getSourceFile(project, repoRelativePath),
    resolveModulePath: (filePath: string, moduleSpecifier: string) =>
      resolveRepoImport(project, filePath, moduleSpecifier),
    toRepoRelativePath: (absolutePath: string) => normalizePath(path.relative(REPO_ROOT, absolutePath)),
  };
}

function getSourceFile(project: Project, repoRelativePath: string): SourceFile | undefined {
  return project.getSourceFile(path.join(REPO_ROOT, repoRelativePath));
}

function resolveRepoImport(project: Project, filePath: string, moduleSpecifier: string): string | undefined {
  if (!moduleSpecifier.startsWith('.')) {
    return undefined;
  }

  const basePath = path.resolve(REPO_ROOT, path.dirname(filePath), moduleSpecifier);
  const candidates = [
    basePath,
    ...SOURCE_EXTENSIONS.map((extension) => `${basePath}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => path.join(basePath, `index${extension}`)),
  ];

  for (const candidate of candidates) {
    if (project.getSourceFile(candidate)) {
      return normalizePath(candidate);
    }
  }

  return undefined;
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}
