import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export type PackageManager = 'bun' | 'npm' | 'pnpm' | 'unknown' | 'yarn';
export type WorkspaceMode = 'single-package' | 'unknown' | 'workspace';

export interface RepositoryProfile {
  repoPath: string;
  packageJsonPath: string | null;
  packageManager: PackageManager;
  workspaceMode: WorkspaceMode;
  lockfiles: string[];
  scriptNames: string[];
  validationCommands: string[];
}

interface PackageJsonShape {
  packageManager?: string;
  scripts?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

const LOCKFILE_CANDIDATES = [
  { file: 'pnpm-lock.yaml', packageManager: 'pnpm' as const },
  { file: 'yarn.lock', packageManager: 'yarn' as const },
  { file: 'package-lock.json', packageManager: 'npm' as const },
  { file: 'bun.lockb', packageManager: 'bun' as const },
  { file: 'bun.lock', packageManager: 'bun' as const },
];

const VALIDATION_SCRIPT_ORDER = ['typecheck', 'check', 'lint', 'test', 'test:coverage', 'build'];

export async function profileRepository(repoPath: string): Promise<RepositoryProfile> {
  const rootPath = path.resolve(repoPath);
  const packageJsonPath = await readPackageJsonPath(rootPath);
  const packageJson = packageJsonPath ? await readPackageJson(packageJsonPath) : null;
  const lockfiles = await detectLockfiles(rootPath);
  const packageManager = inferPackageManager(packageJson, lockfiles);
  const workspaceMode = inferWorkspaceMode(rootPath, packageJson);
  const scriptNames = sortStrings(Object.keys(packageJson?.scripts ?? {}));
  const validationCommands = inferValidationCommands(rootPath, packageManager, scriptNames);

  return {
    repoPath: rootPath,
    packageJsonPath,
    packageManager,
    workspaceMode,
    lockfiles,
    scriptNames,
    validationCommands,
  };
}

async function readPackageJsonPath(repoPath: string): Promise<string | null> {
  const packageJsonPath = path.join(repoPath, 'package.json');
  try {
    await fs.access(packageJsonPath);
    return packageJsonPath;
  } catch {
    return null;
  }
}

async function readPackageJson(packageJsonPath: string): Promise<PackageJsonShape> {
  const contents = await fs.readFile(packageJsonPath, 'utf8');
  return JSON.parse(contents) as PackageJsonShape;
}

async function detectLockfiles(repoPath: string): Promise<string[]> {
  const foundLockfiles: string[] = [];
  for (const candidate of LOCKFILE_CANDIDATES) {
    if (existsSync(path.join(repoPath, candidate.file))) {
      foundLockfiles.push(candidate.file);
    }
  }

  return foundLockfiles;
}

function inferPackageManager(packageJson: PackageJsonShape | null, lockfiles: string[]): PackageManager {
  const declaredPackageManager = packageJson?.packageManager?.split('@')[0]?.trim().toLowerCase();
  if (declaredPackageManager === 'pnpm' || declaredPackageManager === 'yarn' || declaredPackageManager === 'npm') {
    return declaredPackageManager;
  }
  if (declaredPackageManager === 'bun') {
    return 'bun';
  }

  for (const candidate of LOCKFILE_CANDIDATES) {
    if (lockfiles.includes(candidate.file)) {
      return candidate.packageManager;
    }
  }

  return 'unknown';
}

function inferWorkspaceMode(repoPath: string, packageJson: PackageJsonShape | null): WorkspaceMode {
  if (!packageJson) {
    return 'unknown';
  }

  if (packageJson.workspaces) {
    return 'workspace';
  }

  const pnpmWorkspacePath = path.join(repoPath, 'pnpm-workspace.yaml');
  const lernaPath = path.join(repoPath, 'lerna.json');
  if (existsSync(pnpmWorkspacePath) || existsSync(lernaPath)) {
    return 'workspace';
  }

  return 'single-package';
}

function inferValidationCommands(repoPath: string, packageManager: PackageManager, scriptNames: string[]): string[] {
  const commands: string[] = [];
  const availableScripts = new Set(scriptNames);

  for (const scriptName of VALIDATION_SCRIPT_ORDER) {
    if (availableScripts.has(scriptName)) {
      commands.push(buildScriptCommand(packageManager, scriptName));
    }
  }

  if (commands.length === 0 && existsSync(path.join(repoPath, 'tsconfig.json'))) {
    commands.push(buildTypecheckCommand(packageManager));
  }

  return [...new Set(commands)];
}

function buildScriptCommand(packageManager: PackageManager, scriptName: string): string {
  switch (packageManager) {
    case 'bun': {
      return `bun run ${scriptName}`;
    }
    case 'npm': {
      return `npm run ${scriptName}`;
    }
    case 'pnpm': {
      return `pnpm ${scriptName}`;
    }
    case 'yarn': {
      return `yarn ${scriptName}`;
    }
    default: {
      return `npm run ${scriptName}`;
    }
  }
}

function sortStrings(values: string[]): string[] {
  const sorted: string[] = [];

  for (const value of values) {
    let insertAt = 0;
    while (insertAt < sorted.length && sorted[insertAt].localeCompare(value) < 0) {
      insertAt += 1;
    }
    sorted.splice(insertAt, 0, value);
  }

  return sorted;
}

function buildTypecheckCommand(packageManager: PackageManager): string {
  switch (packageManager) {
    case 'bun': {
      return 'bunx tsc --noEmit --project tsconfig.json';
    }
    case 'npm': {
      return 'npx tsc --noEmit --project tsconfig.json';
    }
    case 'pnpm': {
      return 'pnpm exec tsc --noEmit --project tsconfig.json';
    }
    case 'yarn': {
      return 'yarn tsc --noEmit --project tsconfig.json';
    }
    default: {
      return 'npx tsc --noEmit --project tsconfig.json';
    }
  }
}
