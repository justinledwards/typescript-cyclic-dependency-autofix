import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { profileRepository } from './repoProfile.js';

const fixtureRoot = path.join(process.cwd(), '.test-fixtures');
mkdirSync(fixtureRoot, { recursive: true });

describe('profileRepository', () => {
  it('infers package manager, workspace mode, and validation commands from package.json', async () => {
    const repoPath = mkdtempSync(path.join(fixtureRoot, 'profile-pnpm-'));
    writeFileSync(
      path.join(repoPath, 'package.json'),
      JSON.stringify(
        {
          packageManager: 'pnpm@10.12.1',
          scripts: {
            build: 'vite build',
            lint: 'eslint .',
            test: 'vitest run',
            typecheck: 'tsc --noEmit',
            'test:coverage': 'vitest run --coverage',
          },
          workspaces: ['packages/*'],
        },
        null,
        2,
      ),
    );
    writeFileSync(path.join(repoPath, 'pnpm-lock.yaml'), '');
    writeFileSync(path.join(repoPath, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    writeFileSync(path.join(repoPath, 'tsconfig.json'), '{}');

    const profile = await profileRepository(repoPath);

    expect(profile).toMatchObject({
      repoPath: path.resolve(repoPath),
      packageJsonPath: path.join(repoPath, 'package.json'),
      packageManager: 'pnpm',
      workspaceMode: 'workspace',
      lockfiles: ['pnpm-lock.yaml'],
      scriptNames: ['build', 'lint', 'test', 'test:coverage', 'typecheck'],
      validationCommands: ['pnpm typecheck', 'pnpm lint', 'pnpm test', 'pnpm test:coverage', 'pnpm build'],
    });
  });

  it('falls back to a typecheck command when scripts are absent', async () => {
    const repoPath = mkdtempSync(path.join(fixtureRoot, 'profile-bun-'));
    writeFileSync(path.join(repoPath, 'package.json'), JSON.stringify({ name: 'widget' }, null, 2));
    writeFileSync(path.join(repoPath, 'bun.lock'), '');
    writeFileSync(path.join(repoPath, 'tsconfig.json'), '{}');

    const profile = await profileRepository(repoPath);

    expect(profile).toMatchObject({
      repoPath: path.resolve(repoPath),
      packageJsonPath: path.join(repoPath, 'package.json'),
      packageManager: 'bun',
      workspaceMode: 'single-package',
      lockfiles: ['bun.lock'],
      scriptNames: [],
      validationCommands: ['bunx tsc --noEmit --project tsconfig.json'],
    });
  });
});
