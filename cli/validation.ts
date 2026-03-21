import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { analyzeRepository } from '../analyzer/analyzer.js';
import type { CircularDependency } from '../analyzer/analyzer.js';
import type { GeneratedPatch } from '../codemod/generatePatch.js';
import { profileRepository } from './repoProfile.js';

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

    const repositoryProfile = await safeProfileRepository(validationPath);
    const repoValidationResult = await runRepoValidationCommands(
      validationPath,
      repositoryProfile?.validationCommands ?? [],
    );
    if (!repoValidationResult.ok) {
      return {
        status: 'failed',
        summary: `Validation failed: repo-native validation command failed (${repoValidationResult.command}).\n${repoValidationResult.output}`,
      };
    }

    const typecheckResult = await runTypecheckIfPresent(validationPath);
    if (!typecheckResult.ok) {
      return {
        status: 'failed',
        summary: `Validation failed: TypeScript check did not pass.\n${typecheckResult.output}`,
      };
    }

    const repoValidationSummary = repositoryProfile?.validationCommands.length
      ? `Repo-native validation passed (${repositoryProfile.validationCommands.join(', ')}). `
      : '';

    return {
      status: 'passed',
      summary: `Validation passed: original cycle removed. ${repoValidationSummary}TypeScript check passed. Remaining cycles detected: ${validatedCycles.length}.`,
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

async function safeProfileRepository(repoPath: string) {
  try {
    return await profileRepository(repoPath);
  } catch {
    return void 0;
  }
}

async function runRepoValidationCommands(
  repoPath: string,
  validationCommands: string[],
): Promise<
  | { ok: true; command: string | null }
  | {
      ok: false;
      command: string;
      output: string;
    }
> {
  for (const command of validationCommands) {
    const result = await runValidationCommand(repoPath, command);
    if (!result.ok) {
      return result;
    }
  }

  return { ok: true, command: validationCommands.length > 0 ? validationCommands.join(' && ') : null };
}

async function runValidationCommand(
  repoPath: string,
  command: string,
): Promise<
  | { ok: true; command: string }
  | {
      ok: false;
      command: string;
      output: string;
    }
> {
  const trimmed = command.trim();
  if (!trimmed) {
    return { ok: true, command };
  }

  const [binary, ...args] = trimmed.split(/\s+/);
  if (!binary) {
    return { ok: true, command };
  }

  try {
    await execFileAsync(binary, args, { cwd: repoPath });
    return { ok: true, command };
  } catch (error) {
    let output = 'Unknown validation failure';
    if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string') {
      output = error.stderr;
    } else if (error instanceof Error) {
      output = error.message;
    }

    return { ok: false, command, output };
  }
}

async function runTypecheckIfPresent(repoPath: string): Promise<{ ok: true } | { ok: false; output: string }> {
  const tsconfigPath = path.join(repoPath, 'tsconfig.json');

  try {
    await fs.access(tsconfigPath);
  } catch {
    return { ok: true };
  }

  const tscEntrypoint = resolveTypeScriptTscEntrypoint();
  if (!tscEntrypoint) {
    return {
      ok: false,
      output: 'Unable to resolve the TypeScript compiler entrypoint from the current environment.',
    };
  }

  try {
    await execFileAsync(process.execPath, [tscEntrypoint, '--noEmit', '--project', tsconfigPath], {
      cwd: repoPath,
    });
    return { ok: true };
  } catch (error) {
    let output = 'Unknown typecheck failure';
    if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string') {
      output = error.stderr;
    } else if (error instanceof Error) {
      output = error.message;
    }

    return { ok: false, output };
  }
}

function resolveTypeScriptTscEntrypoint(): string | null {
  const require = createRequire(import.meta.url);

  try {
    const packageJsonPath = require.resolve('typescript/package.json');
    return path.join(path.dirname(packageJsonPath), 'bin', 'tsc');
  } catch {
    return null;
  }
}
