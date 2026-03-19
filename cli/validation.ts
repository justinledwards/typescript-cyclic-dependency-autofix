import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { analyzeRepository } from '../analyzer/analyzer.js';
import type { CircularDependency } from '../analyzer/analyzer.js';
import type { GeneratedPatch } from '../codemod/generatePatch.js';

const execFileAsync = promisify(execFile);

export interface ValidationResult {
  status: 'passed' | 'failed';
  summary: string;
}

export async function validateGeneratedPatch(
  repoPath: string,
  cycle: CircularDependency,
  generatedPatch: GeneratedPatch,
): Promise<ValidationResult> {
  const validationPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cycle-validation-'));

  try {
    await fs.cp(repoPath, validationPath, {
      recursive: true,
      filter: (source) => !source.includes(`${path.sep}.git${path.sep}`) && !source.endsWith(`${path.sep}.git`),
    });

    await applySnapshots(validationPath, generatedPatch);

    const beforeCycleKey = normalizeCyclePath(cycle.path);
    const validatedCycles = await analyzeRepository(validationPath);
    const cycleKeys = new Set(validatedCycles.map((validatedCycle) => normalizeCyclePath(validatedCycle.path)));

    if (cycleKeys.has(beforeCycleKey)) {
      return {
        status: 'failed',
        summary: 'Validation failed: the original cycle is still present after applying the rewrite.',
      };
    }

    const typecheckResult = await runTypecheckIfPresent(validationPath);
    if (!typecheckResult.ok) {
      return {
        status: 'failed',
        summary: `Validation failed: TypeScript check did not pass.\n${typecheckResult.output}`,
      };
    }

    return {
      status: 'passed',
      summary: `Validation passed: original cycle removed. Remaining cycles detected: ${validatedCycles.length}.`,
    };
  } finally {
    await fs.rm(validationPath, { recursive: true, force: true });
  }
}

async function applySnapshots(repoPath: string, generatedPatch: GeneratedPatch): Promise<void> {
  for (const snapshot of generatedPatch.fileSnapshots) {
    const absolutePath = path.join(repoPath, snapshot.path);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, snapshot.after, 'utf8');
  }
}

function normalizeCyclePath(cyclePath: string[]): string {
  return cyclePath.join(' -> ');
}

async function runTypecheckIfPresent(repoPath: string): Promise<{ ok: true } | { ok: false; output: string }> {
  const tsconfigPath = path.join(repoPath, 'tsconfig.json');

  try {
    await fs.access(tsconfigPath);
  } catch {
    return { ok: true };
  }

  const tscEntrypoint = path.join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');

  try {
    await execFileAsync(process.execPath, [tscEntrypoint, '--noEmit', '--project', tsconfigPath], {
      cwd: repoPath,
    });
    return { ok: true };
  } catch (error) {
    const output =
      error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string'
        ? error.stderr
        : error instanceof Error
          ? error.message
          : 'Unknown typecheck failure';

    return { ok: false, output };
  }
}
