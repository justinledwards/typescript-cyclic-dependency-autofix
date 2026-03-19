import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  const tempDirs: string[] = [];

  beforeEach(() => {
    vi.resetAllMocks();
    analyzer = new SemanticAnalyzer('/dummy/repo');
  });

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fsPromises.rm(dir, { recursive: true, force: true })));
  });

  async function createRepo(files: Record<string, string>): Promise<string> {
    const repoPath = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'semantic-analyzer-'));
    tempDirs.push(repoPath);

    for (const [relativePath, content] of Object.entries(files)) {
      const absolutePath = path.join(repoPath, relativePath);
      await fsPromises.mkdir(path.dirname(absolutePath), { recursive: true });
      await fsPromises.writeFile(absolutePath, content, 'utf8');
    }

    return repoPath;
  }

  function mockRepoExists(repoPath: string, files: string[]): void {
    const existingPaths = new Set(files.map((file) => path.join(repoPath, file)));
    vi.mocked(fs.existsSync).mockImplementation((input) => existingPaths.has(String(input)));
  }

  function mockExistingPaths(paths: string[]): void {
    const existingPaths = new Set(paths);
    vi.mocked(fs.existsSync).mockImplementation((input) => existingPaths.has(String(input)));
  }

  it('rejects cycles with more than 2 unique files', () => {
    const result = analyzer.analyzeCycle(['a.ts', 'b.ts', 'c.ts', 'a.ts']);
    expect(result.classification).toBe('unsupported');
    expect(result.reasons[0]).toMatch(/Only two-file cycles/);
  });

  it('rejects cycles where files cannot be read', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = analyzer.analyzeCycle(['a.ts', 'b.ts', 'a.ts']);
    expect(result.classification).toBe('unsupported');
    expect(result.reasons[0]).toMatch(/could not be read/);
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
    expect(result.reasons[0]).toMatch(/extracting symbols/);
    expect(result.plan).toEqual({
      kind: 'extract_shared',
      sourceFile: 'b.ts',
      targetFile: 'a.ts',
      symbols: ['helperB'],
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

  it('loads cycle files from disk when they are not already in the project', async () => {
    const repoPath = await createRepo({
      'a.ts': `
        import type { BType } from './b';
        export interface AType { b: BType; }
      `,
      'b.ts': `
        import type { AType } from './a';
        export interface BType { a: AType; }
      `,
    });

    mockRepoExists(repoPath, ['a.ts', 'b.ts']);

    const diskAnalyzer = new SemanticAnalyzer(repoPath);
    const result = diskAnalyzer.analyzeCycle(['a.ts', 'b.ts', 'a.ts']);

    expect(result.classification).toBe('autofix_import_type');
    expect(result.plan).toEqual({
      kind: 'import_type',
      imports: [
        { sourceFile: 'a.ts', targetFile: 'b.ts' },
        { sourceFile: 'b.ts', targetFile: 'a.ts' },
      ],
    });
  });

  it('falls back to manual review for side-effectful barrel modules', async () => {
    const repoPath = await createRepo({
      'app.ts': `
        import { Foo } from './index';
        export const appValue = Foo + 1;
      `,
      'index.ts': `
        import './setup';
        export { Foo } from './foo';
      `,
      'foo.ts': 'export const Foo = 1;',
      'bar.ts': `
        import { appValue } from './app';
        export const Bar = appValue + 1;
      `,
      'setup.ts': 'export const setup = true;',
    });

    mockRepoExists(repoPath, ['app.ts', 'index.ts', 'foo.ts', 'bar.ts', 'setup.ts']);

    const diskAnalyzer = new SemanticAnalyzer(repoPath);
    const result = diskAnalyzer.analyzeCycle(['app.ts', 'index.ts', 'bar.ts', 'app.ts']);

    expect(result.classification).toBe('suggest_manual');
    expect(result.reasons[0]).toMatch(/direct-import rewrite is not safe/);
  });

  it('falls back to manual review when barrel re-exports resolve ambiguously', async () => {
    const repoPath = await createRepo({
      'app.ts': `
        import { Foo, Bar } from './index';
        export const appValue = Foo + Bar + 1;
      `,
      'index.ts': `
        export { Foo } from './foo';
        export { Bar } from './qux';
      `,
      'foo.ts': 'export const Foo = 1;',
      'qux.ts': 'export const Bar = 2;',
      'bar.ts': `
        import { appValue } from './app';
        export const Bar = appValue + 1;
      `,
    });

    mockRepoExists(repoPath, ['app.ts', 'index.ts', 'foo.ts', 'qux.ts', 'bar.ts']);

    const diskAnalyzer = new SemanticAnalyzer(repoPath);
    const result = diskAnalyzer.analyzeCycle(['app.ts', 'index.ts', 'bar.ts', 'app.ts']);

    expect(result.classification).toBe('suggest_manual');
  });

  it('rejects extract_shared when a candidate depends on another cycle file', async () => {
    const repoPath = await createRepo({
      'a.ts': `
        import { helperB } from './b';
        export const mainA = () => helperB();
      `,
      'b.ts': `
        import { mainA } from './a';
        export const helperB = () => mainA();
      `,
    });

    mockRepoExists(repoPath, ['a.ts', 'b.ts']);

    const diskAnalyzer = new SemanticAnalyzer(repoPath);
    const result = diskAnalyzer.analyzeCycle(['a.ts', 'b.ts', 'a.ts']);

    expect(result.classification).toBe('suggest_manual');
  });

  it('rejects direct import rewrites that point at external modules', async () => {
    const repoPath = await createRepo({
      'app.ts': `
        import { Foo } from './index';
        export const appValue = Foo + 1;
      `,
      'index.ts': `
        export { Foo } from 'external-package';
      `,
      'bar.ts': `
        import { appValue } from './app';
        export const Bar = appValue + 1;
      `,
    });

    mockRepoExists(repoPath, ['app.ts', 'index.ts', 'bar.ts']);

    const diskAnalyzer = new SemanticAnalyzer(repoPath);
    const result = diskAnalyzer.analyzeCycle(['app.ts', 'index.ts', 'bar.ts', 'app.ts']);

    expect(result.classification).toBe('suggest_manual');
  });

  it('rejects direct import rewrites for default imports from a barrel', async () => {
    const repoPath = await createRepo({
      'app.ts': `
        import Foo from './index';
        export const appValue = Foo + 1;
      `,
      'index.ts': `
        export { Foo } from './foo';
      `,
      'foo.ts': 'export const Foo = 1;',
      'bar.ts': `
        import { appValue } from './app';
        export const Bar = appValue + 1;
      `,
    });

    mockRepoExists(repoPath, ['app.ts', 'index.ts', 'foo.ts', 'bar.ts']);

    const diskAnalyzer = new SemanticAnalyzer(repoPath);
    const result = diskAnalyzer.analyzeCycle(['app.ts', 'index.ts', 'bar.ts', 'app.ts']);

    expect(result.classification).toBe('suggest_manual');
  });

  it('rejects direct import rewrites when the target resolves outside the repo', async () => {
    const externalRepoPath = await createRepo({
      'foo.ts': 'export const Foo = 1;',
    });
    const repoPath = await createRepo({
      'app.ts': `
        import { Foo } from './index';
        export const appValue = Foo + 1;
      `,
      'index.ts': `
        export { Foo } from '${path.join(externalRepoPath, 'foo')}';
      `,
      'bar.ts': `
        import { appValue } from './app';
        export const Bar = appValue + 1;
      `,
    });

    mockExistingPaths([
      path.join(repoPath, 'app.ts'),
      path.join(repoPath, 'index.ts'),
      path.join(repoPath, 'bar.ts'),
      path.join(externalRepoPath, 'foo.ts'),
    ]);

    const diskAnalyzer = new SemanticAnalyzer(repoPath);
    const result = diskAnalyzer.analyzeCycle(['app.ts', 'index.ts', 'bar.ts', 'app.ts']);

    expect(result.classification).toBe('suggest_manual');
  });

  it('rejects direct import rewrites when the target is the source file', async () => {
    const repoPath = await createRepo({
      'app.ts': `
        import { Foo } from './index';
        export const appValue = Foo + 1;
      `,
      'index.ts': `
        export { Foo } from './app';
      `,
      'bar.ts': `
        import { appValue } from './app';
        export const Bar = appValue + 1;
      `,
    });

    mockRepoExists(repoPath, ['app.ts', 'index.ts', 'bar.ts']);

    const diskAnalyzer = new SemanticAnalyzer(repoPath);
    const result = diskAnalyzer.analyzeCycle(['app.ts', 'index.ts', 'bar.ts', 'app.ts']);

    expect(result.classification).toBe('suggest_manual');
  });

  it('rejects direct import rewrites when the target file still depends on the cycle', async () => {
    const repoPath = await createRepo({
      'app.ts': `
        import { Foo } from './index';
        export const appValue = Foo + 1;
      `,
      'index.ts': `
        export { Foo } from './foo';
      `,
      'foo.ts': `
        import { appValue } from './app';
        export const Foo = appValue + 1;
      `,
      'bar.ts': `
        import { appValue } from './app';
        export const Bar = appValue + 1;
      `,
    });

    mockRepoExists(repoPath, ['app.ts', 'index.ts', 'foo.ts', 'bar.ts']);

    const diskAnalyzer = new SemanticAnalyzer(repoPath);
    const result = diskAnalyzer.analyzeCycle(['app.ts', 'index.ts', 'bar.ts', 'app.ts']);

    expect(result.classification).toBe('suggest_manual');
  });

  it('rejects re-export loops while resolving barrel targets', async () => {
    const repoPath = await createRepo({
      'app.ts': `
        import { Foo } from './index';
        export const appValue = Foo + 1;
      `,
      'index.ts': `
        export { Foo } from './mid';
      `,
      'mid.ts': `
        export { Foo } from './index';
      `,
      'bar.ts': `
        import { appValue } from './app';
        export const Bar = appValue + 1;
      `,
    });

    mockRepoExists(repoPath, ['app.ts', 'index.ts', 'mid.ts', 'bar.ts']);

    const diskAnalyzer = new SemanticAnalyzer(repoPath);
    const result = diskAnalyzer.analyzeCycle(['app.ts', 'index.ts', 'bar.ts', 'app.ts']);

    expect(result.classification).toBe('suggest_manual');
  });

  it('rejects barrel exports that resolve the same symbol to multiple targets', async () => {
    const repoPath = await createRepo({
      'app.ts': `
        import { Foo } from './index';
        export const appValue = Foo + 1;
      `,
      'index.ts': `
        export { Foo } from './foo';
        export { Foo } from './bar';
      `,
      'foo.ts': 'export const Foo = 1;',
      'bar.ts': 'export const Foo = 2;',
    });

    mockRepoExists(repoPath, ['app.ts', 'index.ts', 'foo.ts', 'bar.ts']);

    const diskAnalyzer = new SemanticAnalyzer(repoPath);
    const result = diskAnalyzer.analyzeCycle(['app.ts', 'index.ts', 'bar.ts', 'app.ts']);

    expect(result.classification).toBe('suggest_manual');
  });

  it('rejects namespace export barrels', async () => {
    const repoPath = await createRepo({
      'app.ts': `
        import { Foo } from './index';
        export const appValue = Foo + 1;
      `,
      'index.ts': `
        export * as all from './foo';
      `,
      'foo.ts': 'export const Foo = 1;',
      'bar.ts': `
        import { appValue } from './app';
        export const Bar = appValue + 1;
      `,
    });

    mockRepoExists(repoPath, ['app.ts', 'index.ts', 'foo.ts', 'bar.ts']);

    const diskAnalyzer = new SemanticAnalyzer(repoPath);
    const result = diskAnalyzer.analyzeCycle(['app.ts', 'index.ts', 'bar.ts', 'app.ts']);

    expect(result.classification).toBe('suggest_manual');
  });

  it('rejects non-pure barrel modules with local statements', async () => {
    const repoPath = await createRepo({
      'app.ts': `
        import { Foo } from './index';
        export const appValue = Foo + 1;
      `,
      'index.ts': `
        const sideEffect = 1;
        export { Foo } from './foo';
      `,
      'foo.ts': 'export const Foo = 1;',
      'bar.ts': `
        import { appValue } from './app';
        export const Bar = appValue + 1;
      `,
    });

    mockRepoExists(repoPath, ['app.ts', 'index.ts', 'foo.ts', 'bar.ts']);

    const diskAnalyzer = new SemanticAnalyzer(repoPath);
    const result = diskAnalyzer.analyzeCycle(['app.ts', 'index.ts', 'bar.ts', 'app.ts']);

    expect(result.classification).toBe('suggest_manual');
  });

  it('rejects direct import rewrites when the target export is missing', async () => {
    const repoPath = await createRepo({
      'app.ts': `
        import { Foo } from './index';
        export const appValue = Foo + 1;
      `,
      'index.ts': `
        export { Foo } from './missing';
      `,
      'bar.ts': `
        import { appValue } from './app';
        export const Bar = appValue + 1;
      `,
    });

    mockRepoExists(repoPath, ['app.ts', 'index.ts', 'bar.ts']);

    const diskAnalyzer = new SemanticAnalyzer(repoPath);
    const result = diskAnalyzer.analyzeCycle(['app.ts', 'index.ts', 'bar.ts', 'app.ts']);

    expect(result.classification).toBe('suggest_manual');
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
  });

  it('suggests manual when imports are not found', () => {
    analyzer.project.createSourceFile('/dummy/repo/a.ts', 'console.log("a")');
    analyzer.project.createSourceFile('/dummy/repo/b.ts', 'console.log("b")');
    const result = analyzer.analyzeCycle(['a.ts', 'b.ts', 'a.ts']);
    expect(result.classification).toBe('suggest_manual');
    expect(result.reasons[0]).toMatch(/explicit imports/);
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
