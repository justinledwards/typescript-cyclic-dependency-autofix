import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CircularDependency } from '../analyzer/analyzer.js';
import type { SemanticAnalysisResult } from '../analyzer/semantic.js';
import { generatePatchForCycle } from './generatePatch.js';

const tempDirs: string[] = [];

async function createRepo(files: Record<string, string>) {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cycle-autofix-'));
  tempDirs.push(repoPath);

  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(repoPath, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, 'utf8');
  }

  return repoPath;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('generatePatchForCycle', () => {
  it('creates an import-type patch when a type-only plan is provided', async () => {
    const repoPath = await createRepo({
      'a.ts': "import { BType } from './b';\nexport const aValue = 1 as BType;\n",
      'b.ts': 'export interface BType { value: number }\n',
    });

    const cycle: CircularDependency = {
      type: 'circular',
      path: ['a.ts', 'b.ts', 'a.ts'],
    };
    const analysis: SemanticAnalysisResult = {
      classification: 'autofix_import_type',
      confidence: 0.9,
      reasons: ['safe type-only import'],
      plan: {
        kind: 'import_type',
        imports: [{ sourceFile: 'a.ts', targetFile: 'b.ts' }],
      },
    };

    const patch = await generatePatchForCycle(repoPath, cycle, analysis);

    expect(patch).not.toBeNull();
    expect(patch?.patchText).toContain('import type { BType }');
    expect(patch?.touchedFiles).toEqual(['a.ts']);
  });

  it('creates a shared-file extraction patch for a narrow safe symbol', async () => {
    const repoPath = await createRepo({
      'a.ts': "import { helperB } from './b';\nexport const mainA = () => helperB();\n",
      'b.ts': "import { mainA } from './a';\nexport const helperB = () => 'ok';\nexport const runB = () => mainA();\n",
    });

    const cycle: CircularDependency = {
      type: 'circular',
      path: ['a.ts', 'b.ts', 'a.ts'],
    };
    const analysis: SemanticAnalysisResult = {
      classification: 'autofix_extract_shared',
      confidence: 0.8,
      reasons: ['extract helperB'],
      plan: {
        kind: 'extract_shared',
        sourceFile: 'b.ts',
        targetFile: 'a.ts',
        symbols: ['helperB'],
      },
    };

    const patch = await generatePatchForCycle(repoPath, cycle, analysis);

    expect(patch).not.toBeNull();
    expect(patch?.patchText).toContain('b-a.shared');
    expect(patch?.patchText).toContain("export const helperB = () => 'ok';");
    expect(patch?.touchedFiles).toEqual(['b.ts', 'a.ts', 'b-a.shared.ts']);
  });

  it('returns null when no executable plan is present', async () => {
    const repoPath = await createRepo({
      'a.ts': 'export const a = 1;\n',
      'b.ts': 'export const b = 2;\n',
    });

    const patch = await generatePatchForCycle(
      repoPath,
      { type: 'circular', path: ['a.ts', 'b.ts', 'a.ts'] },
      {
        classification: 'suggest_manual',
        confidence: 0.5,
        reasons: ['manual'],
      },
    );

    expect(patch).toBeNull();
  });
});
