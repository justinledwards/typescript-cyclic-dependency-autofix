import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as analyzerModule from '../analyzer/analyzer.js';
import type { CircularDependency } from '../analyzer/analyzer.js';
import type { GeneratedPatch } from '../codemod/generatePatch.js';
import { validateGeneratedPatch } from './validation.js';

const tempDirs: string[] = [];

async function createRepo(files: Record<string, string>) {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cycle-validation-'));
  tempDirs.push(repoPath);

  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(repoPath, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, 'utf8');
  }

  return repoPath;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('validateGeneratedPatch', () => {
  it('passes when the original cycle is removed and no typecheck is required', async () => {
    const repoPath = await createRepo({
      'a.ts': "import { BType } from './b';\nexport type AType = BType;\n",
      'b.ts': "import { AType } from './a';\nexport interface BType { a: AType }\n",
    });

    vi.spyOn(analyzerModule, 'analyzeRepository')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const generatedPatch: GeneratedPatch = {
      patchText: 'diff',
      touchedFiles: ['a.ts', 'b.ts'],
      validationStatus: 'pending',
      validationSummary: 'pending',
      fileSnapshots: [
        {
          path: 'a.ts',
          before: "import { BType } from './b';\nexport type AType = BType;\n",
          after: "import type { BType } from './b';\nexport type AType = BType;\n",
        },
      ],
    };

    const result = await validateGeneratedPatch(
      repoPath,
      { type: 'circular', path: ['a.ts', 'b.ts', 'a.ts'] },
      generatedPatch,
    );

    expect(result.status).toBe('passed');
    expect(result.summary).toContain('original cycle removed');
  });

  it('fails when the original cycle is still present after applying the rewrite', async () => {
    const repoPath = await createRepo({
      'a.ts': 'export const a = 1;\n',
      'b.ts': 'export const b = 2;\n',
    });

    vi.spyOn(analyzerModule, 'analyzeRepository').mockResolvedValue([
      { type: 'circular', path: ['a.ts', 'b.ts', 'a.ts'] } as CircularDependency,
    ]);

    const generatedPatch: GeneratedPatch = {
      patchText: 'diff',
      touchedFiles: ['a.ts'],
      validationStatus: 'pending',
      validationSummary: 'pending',
      fileSnapshots: [
        {
          path: 'a.ts',
          before: 'export const a = 1;\n',
          after: 'export const a = 2;\n',
        },
      ],
    };

    const result = await validateGeneratedPatch(
      repoPath,
      { type: 'circular', path: ['a.ts', 'b.ts', 'a.ts'] },
      generatedPatch,
    );

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('original cycle is still present');
  });

  it('passes when the rewrite removes the cycle and TypeScript validates cleanly', async () => {
    const repoPath = await createRepo({
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'es2022',
          module: 'esnext',
          noEmit: true,
        },
        include: ['*.ts'],
      }),
      'a.ts': "export const value = 1;\n",
    });

    vi.spyOn(analyzerModule, 'analyzeRepository').mockResolvedValue([]);

    const generatedPatch: GeneratedPatch = {
      patchText: 'diff',
      touchedFiles: ['a.ts'],
      validationStatus: 'pending',
      validationSummary: 'pending',
      fileSnapshots: [],
    };

    const result = await validateGeneratedPatch(
      repoPath,
      { type: 'circular', path: ['a.ts', 'b.ts', 'a.ts'] },
      generatedPatch,
    );

    expect(result.status).toBe('passed');
    expect(result.summary).toContain('Remaining cycles detected: 0');
  });

  it('fails when TypeScript validation rejects the rewritten snapshot', async () => {
    const repoPath = await createRepo({
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'es2022',
          module: 'esnext',
          noEmit: true,
        },
        include: ['*.ts'],
      }),
      'a.ts': "export const value: string = 'ok';\n",
    });

    vi.spyOn(analyzerModule, 'analyzeRepository').mockResolvedValue([]);

    const generatedPatch: GeneratedPatch = {
      patchText: 'diff',
      touchedFiles: ['a.ts'],
      validationStatus: 'pending',
      validationSummary: 'pending',
      fileSnapshots: [
        {
          path: 'a.ts',
          before: "export const value: string = 'ok';\n",
          after: 'export const value: string = 123;\n',
        },
      ],
    };

    const result = await validateGeneratedPatch(
      repoPath,
      { type: 'circular', path: ['a.ts', 'b.ts', 'a.ts'] },
      generatedPatch,
    );

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('TypeScript check did not pass');
  });

  it('falls back to the spawned process error when the compiler entrypoint cannot be resolved', async () => {
    vi.resetModules();
    vi.doMock('../analyzer/analyzer.js', () => ({
      analyzeRepository: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock('node:module', () => ({
      createRequire: () => ({
        resolve: () => path.join(os.tmpdir(), 'missing-typescript-tsc.js'),
      }),
    }));

    const { validateGeneratedPatch: isolatedValidateGeneratedPatch } = await import('./validation.js');
    const repoPath = await createRepo({
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'es2022',
          module: 'esnext',
          noEmit: true,
        },
        include: ['*.ts'],
      }),
      'a.ts': "export const value = 1;\n",
    });

    const generatedPatch: GeneratedPatch = {
      patchText: 'diff',
      touchedFiles: ['a.ts'],
      validationStatus: 'pending',
      validationSummary: 'pending',
      fileSnapshots: [],
    };

    const result = await isolatedValidateGeneratedPatch(
      repoPath,
      { type: 'circular', path: ['a.ts', 'b.ts', 'a.ts'] },
      generatedPatch,
    );

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('TypeScript check did not pass');
  });
});
