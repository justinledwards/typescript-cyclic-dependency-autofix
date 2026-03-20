import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SemanticAnalyzer } from './semantic.js';

vi.mock('node:fs', () => {
  return {
    default: {
      existsSync: vi.fn(),
    },
  };
});

describe('SemanticAnalyzer', () => {
  let analyzer: SemanticAnalyzer;

  beforeEach(() => {
    vi.resetAllMocks();
    analyzer = new SemanticAnalyzer('/dummy/repo');
  });

  it('rejects cycles with more than 2 unique files', () => {
    const result = analyzer.analyzeCycle(['a.ts', 'b.ts', 'c.ts', 'a.ts']);
    expect(result.classification).toBe('unsupported');
    expect(result.reasons[0]).toMatch(/Only two-file cycles/);
    expect(result.planner).toMatchObject({
      cycleShape: 'multi_file',
      selectedStrategy: undefined,
    });
    expect(result.planner?.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ strategy: 'import_type', status: 'not_applicable' }),
        expect.objectContaining({ strategy: 'direct_import', status: 'rejected' }),
        expect.objectContaining({ strategy: 'extract_shared', status: 'not_applicable' }),
      ]),
    );
  });

  it('rejects cycles where files cannot be read', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = analyzer.analyzeCycle(['a.ts', 'b.ts', 'a.ts']);
    expect(result.classification).toBe('unsupported');
    expect(result.reasons[0]).toMatch(/could not be read/);
    expect(result.planner).toMatchObject({
      cycleShape: 'two_file',
      selectedStrategy: undefined,
    });
    expect(result.planner?.cycleSignals.missingFiles).toBe(2);
  });

  it('detects type-only cycles', () => {
    analyzer.project.createSourceFile(
      '/dummy/repo/a.ts',
      `
      import { BType } from './b';
      export interface AType { a: string; }
      export const useB = (arg: BType) => console.log(arg);
    `,
    );
    analyzer.project.createSourceFile(
      '/dummy/repo/b.ts',
      `
      import { AType } from './a';
      export interface BType { b: string; a: AType; }
    `,
    );

    const result = analyzer.analyzeCycle(['a.ts', 'b.ts', 'a.ts']);
    expect(result.classification).toBe('autofix_import_type');
    expect(result.reasons[0]).toMatch(/converting concrete imports to type-only/);
    expect(result.upstreamabilityScore).toBe(0.94);
    expect(result.planner).toMatchObject({
      cycleShape: 'two_file',
      selectedStrategy: 'import_type',
      selectedClassification: 'autofix_import_type',
      selectedScore: 0.94,
    });
    expect(result.planner?.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          strategy: 'import_type',
          status: 'candidate',
          signals: expect.objectContaining({
            importEdges: 2,
            introducesNewFile: false,
          }),
        }),
        expect.objectContaining({ strategy: 'direct_import', status: 'not_applicable' }),
      ]),
    );
    expect(result.plan).toEqual({
      kind: 'import_type',
      imports: [
        { sourceFile: 'a.ts', targetFile: 'b.ts' },
        { sourceFile: 'b.ts', targetFile: 'a.ts' },
      ],
    });
  });

  it('detects extract_shared for top-level functions', () => {
    analyzer.project.createSourceFile(
      '/dummy/repo/a.ts',
      `
      import { helperB } from './b';
      export const mainA = () => helperB();
    `,
    );
    analyzer.project.createSourceFile(
      '/dummy/repo/b.ts',
      `
      import { mainA } from './a';
      export const helperB = () => console.log("B");
      export const sideEffectB = () => mainA();
    `,
    );

    const result = analyzer.analyzeCycle(['a.ts', 'b.ts', 'a.ts']);
    expect(result.classification).toBe('autofix_extract_shared');
    expect(result.reasons[0]).toMatch(/helperB/);
    expect(result.reasons[0]).toMatch(/helperB\.shared\.ts/);
    expect(result.planner).toMatchObject({
      cycleShape: 'two_file',
      selectedStrategy: 'extract_shared',
      selectedClassification: 'autofix_extract_shared',
    });
    expect(result.planner?.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          strategy: 'extract_shared',
          status: 'candidate',
          signals: expect.objectContaining({
            introducesNewFile: true,
            preservesSourceExports: true,
            sharedFile: 'helperB.shared.ts',
          }),
        }),
      ]),
    );
    expect(result.plan).toEqual({
      kind: 'extract_shared',
      sourceFile: 'b.ts',
      targetFile: 'a.ts',
      symbols: ['helperB'],
      sharedFile: 'helperB.shared.ts',
      preserveSourceExports: true,
    });
  });

  it('avoids colliding with an existing shared module path', () => {
    analyzer.project.createSourceFile(
      '/dummy/repo/a.ts',
      `
      import { helperB } from './b';
      export const mainA = () => helperB();
    `,
    );
    analyzer.project.createSourceFile(
      '/dummy/repo/b.ts',
      `
      import { mainA } from './a';
      export const helperB = () => console.log("B");
      export const sideEffectB = () => mainA();
    `,
    );
    analyzer.project.createSourceFile('/dummy/repo/helperB.shared.ts', 'export const alreadyThere = true;');

    const result = analyzer.analyzeCycle(['a.ts', 'b.ts', 'a.ts']);

    expect(result.classification).toBe('autofix_extract_shared');
    expect(result.plan).toEqual({
      kind: 'extract_shared',
      sourceFile: 'b.ts',
      targetFile: 'a.ts',
      symbols: ['helperB'],
      sharedFile: 'b-a.shared.ts',
      preserveSourceExports: true,
    });
  });

  it('detects direct_import for safe barrel re-exports', () => {
    analyzer.project.createSourceFile(
      '/dummy/repo/app.ts',
      `
      import { Foo } from './index';
      export const appValue = Foo + 1;
    `,
    );
    analyzer.project.createSourceFile(
      '/dummy/repo/index.ts',
      `
      export { Foo } from './foo';
      export { Bar } from './bar';
    `,
    );
    analyzer.project.createSourceFile('/dummy/repo/foo.ts', 'export const Foo = 1;');
    analyzer.project.createSourceFile(
      '/dummy/repo/bar.ts',
      `
      import { appValue } from './app';
      export const Bar = appValue + 1;
    `,
    );

    const result = analyzer.analyzeCycle(['app.ts', 'index.ts', 'bar.ts', 'app.ts']);
    expect(result.classification).toBe('autofix_direct_import');
    expect(result.planner).toMatchObject({
      cycleShape: 'multi_file',
      selectedStrategy: 'direct_import',
      selectedClassification: 'autofix_direct_import',
      selectedScore: 0.89,
    });
    expect(result.plan).toEqual({
      kind: 'direct_import',
      imports: [
        {
          sourceFile: 'app.ts',
          barrelFile: 'index.ts',
          targetFile: 'foo.ts',
          symbols: ['Foo'],
        },
      ],
    });
  });

  it('detects host_state_update for thin imported setters on caller-owned state', () => {
    analyzer.project.createSourceFile(
      '/dummy/repo/a.ts',
      `
      import { setLastActiveSessionKey } from './b';
      export const runA = (host: unknown) => setLastActiveSessionKey(host, ' next ');
    `,
    );
    analyzer.project.createSourceFile(
      '/dummy/repo/b.ts',
      `
      import { runA } from './a';
      import { saveSettings } from './storage';

      export function applySettings(host: { settings: { lastActiveSessionKey: string }; applySessionKey: string }, next: { lastActiveSessionKey: string }) {
        host.settings = next;
        saveSettings(next);
        host.applySessionKey = host.settings.lastActiveSessionKey;
      }

      export function setLastActiveSessionKey(host: { settings: { lastActiveSessionKey: string }; applySessionKey: string }, next: string) {
        const trimmed = next.trim();
        if (!trimmed) {
          return;
        }
        if (host.settings.lastActiveSessionKey === trimmed) {
          return;
        }
        applySettings(host, { ...host.settings, lastActiveSessionKey: trimmed });
      }

      export const runB = () => runA({ settings: { lastActiveSessionKey: 'main' }, applySessionKey: 'main' });
    `,
    );
    analyzer.project.createSourceFile('/dummy/repo/storage.ts', 'export function saveSettings(_next: unknown) {}\n');

    const result = analyzer.analyzeCycle(['a.ts', 'b.ts', 'a.ts']);

    expect(result.classification).toBe('autofix_host_state_update');
    expect(result.upstreamabilityScore).toBe(0.87);
    expect(result.planner).toMatchObject({
      cycleShape: 'two_file',
      selectedStrategy: 'host_state_update',
      selectedClassification: 'autofix_host_state_update',
      selectedScore: 0.87,
    });
    expect(result.plan).toEqual({
      kind: 'host_state_update',
      sourceFile: 'a.ts',
      targetFile: 'b.ts',
      importedFunction: 'setLastActiveSessionKey',
      persistenceModule: 'storage.ts',
      persistenceModuleKind: 'repo_file',
      persistenceFunction: 'saveSettings',
      stateObjectProperty: 'settings',
      updatedProperty: 'lastActiveSessionKey',
      mirrorHostProperty: 'applySessionKey',
      trimValue: true,
    });
  });

  it('identifies suggest_manual for non-type cycles with unsupported declarations', () => {
    analyzer.project.createSourceFile(
      '/dummy/repo/a.ts',
      `
      import { ClassB } from './b';
      export const aVal = new ClassB();
    `,
    );
    analyzer.project.createSourceFile(
      '/dummy/repo/b.ts',
      `
      import { aVal } from './a';
      export class ClassB { prop = aVal; }
    `,
    );

    const result = analyzer.analyzeCycle(['a.ts', 'b.ts', 'a.ts']);
    expect(result.classification).toBe('suggest_manual');
  });

  it('falls back to suggest_manual for ambiguous barrel re-exports', () => {
    analyzer.project.createSourceFile(
      '/dummy/repo/app.ts',
      `
      import { Foo } from './index';
      export const appValue = Foo + 1;
    `,
    );
    analyzer.project.createSourceFile(
      '/dummy/repo/index.ts',
      `
      export * from './foo';
      export * from './bar';
    `,
    );
    analyzer.project.createSourceFile('/dummy/repo/foo.ts', 'export const Foo = 1;');
    analyzer.project.createSourceFile(
      '/dummy/repo/bar.ts',
      `
      import { appValue } from './app';
      export const Bar = appValue + 1;
    `,
    );

    const result = analyzer.analyzeCycle(['app.ts', 'index.ts', 'bar.ts', 'app.ts']);
    expect(result.classification).toBe('suggest_manual');
    expect(result.planner?.selectionSummary).toMatch(/falling back to suggest_manual/);
    expect(result.planner?.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          strategy: 'direct_import',
          status: 'rejected',
          reasons: expect.arrayContaining([expect.stringMatching(/ambiguous or side-effectful/)]),
        }),
      ]),
    );
  });

  it('suggests manual when imports are not found', () => {
    analyzer.project.createSourceFile('/dummy/repo/a.ts', 'console.log("a")');
    analyzer.project.createSourceFile('/dummy/repo/b.ts', 'console.log("b")');
    const result = analyzer.analyzeCycle(['a.ts', 'b.ts', 'a.ts']);
    expect(result.classification).toBe('suggest_manual');
    expect(result.reasons[0]).toMatch(/explicit imports/);
    expect(result.planner?.selectionSummary).toMatch(/falling back to suggest_manual/);
    expect(result.planner?.cycleSignals.explicitImportEdges).toBe(0);
  });

  it('rejects extraction if symbol is not exported', () => {
    analyzer.project.createSourceFile(
      '/dummy/repo/a.ts',
      `
      import { bVal } from './b';
      export const aVal = bVal;
    `,
    );
    analyzer.project.createSourceFile(
      '/dummy/repo/b.ts',
      `
      import { aVal } from './a';
      const bVal = 1; 
      export const mainB = () => aVal + bVal;
    `,
    );

    const result = analyzer.analyzeCycle(['a.ts', 'b.ts', 'a.ts']);
    expect(result.classification).toBe('suggest_manual');
  });

  it('rejects type-only if there are concrete usages on both sides', () => {
    analyzer.project.createSourceFile(
      '/dummy/repo/a.ts',
      `
      import BDefault from './b';
      export const aVal = BDefault.toString();
    `,
    );
    analyzer.project.createSourceFile(
      '/dummy/repo/b.ts',
      `
      import { aVal } from './a';
      export const bVal = aVal + 1;
    `,
    );

    const result = analyzer.analyzeCycle(['a.ts', 'b.ts', 'a.ts']);
    expect(result.classification).not.toBe('autofix_import_type');
  });

  it('rejects type-only if there is a namespace import used as value', () => {
    analyzer.project.createSourceFile(
      '/dummy/repo/a.ts',
      `
      import * as B from './b';
      export const useB = B.bVal;
    `,
    );
    analyzer.project.createSourceFile(
      '/dummy/repo/b.ts',
      `
      import { aVal } from './a';
      export const bVal = aVal;
    `,
    );

    const result = analyzer.analyzeCycle(['a.ts', 'b.ts', 'a.ts']);
    expect(result.classification).not.toBe('autofix_import_type');
  });

  it('handles external imports and absolute paths safely', () => {
    analyzer.project.createSourceFile(
      '/dummy/repo/a.ts',
      `
      import { bVal } from './b';
      import { external } from 'package';
      export const aVal = bVal + external;
    `,
    );
    analyzer.project.createSourceFile(
      '/dummy/repo/b.ts',
      `
      import { aVal } from '/dummy/repo/a.ts';
      export const bVal = 100; 
    `,
    );

    const result = analyzer.analyzeCycle(['a.ts', 'b.ts', 'a.ts']);
    expect(result.classification).toBe('autofix_extract_shared');
  });

  it('handles non-identifier named imports safely (unsupported case)', () => {
    analyzer.project.createSourceFile(
      '/dummy/repo/a.ts',
      `
      import { "b-val" as bVal } from './b';
      export const aVal = bVal;
    `,
    );
    analyzer.project.createSourceFile(
      '/dummy/repo/b.ts',
      `
      import { aVal } from './a';
      export const "b-val" = 1;
    `,
    );

    const result = analyzer.analyzeCycle(['a.ts', 'b.ts', 'a.ts']);
    expect(result.classification).not.toBe('autofix_import_type');
  });

  it('skips already type-only imports', () => {
    analyzer.project.createSourceFile(
      '/dummy/repo/a.ts',
      `
      import type { BType } from './b';
      export const aVal = 1;
    `,
    );
    analyzer.project.createSourceFile(
      '/dummy/repo/b.ts',
      `
      import { aVal } from './a';
      export interface BType { b: number }
    `,
    );
    const result = analyzer.analyzeCycle(['a.ts', 'b.ts', 'a.ts']);
    expect(result.classification).toBe('autofix_import_type');
  });
});
