import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { analyzeRepository } from '../analyzer/analyzer.js';
import { mineBenchmarkCasesFromCorpus } from './benchmarkCorpus.js';
import { mineBenchmarkCasesFromRepo } from './benchmarkMiner.js';
import { createPullRequestForPatch } from './createPullRequest.js';
import { exportApprovedPatches } from './exportPatches.js';
import { createProgram } from './index.js';
import { scanRepository } from './scanner.js';

const fixtureRoot = vi.hoisted(() => `${process.cwd()}/.test-fixtures`);
const exportedDir = vi.hoisted(() => `${process.cwd()}/.test-fixtures/patches`);
mkdirSync(fixtureRoot, { recursive: true });

vi.mock('./scanner.js', () => ({
  scanRepository: vi.fn().mockResolvedValue({ scanId: 999, cyclesFound: 2 }),
}));

vi.mock('./benchmarkMiner.js', () => ({
  mineBenchmarkCasesFromRepo: vi.fn().mockResolvedValue({
    repository: 'acme/widget',
    repoPath: '/some/repo',
    scannedCommits: 12,
    matchedCommits: 3,
    insertedCases: 2,
    matchedTerms: ['circular dependency', 'import type'],
  }),
}));

vi.mock('./benchmarkCorpus.js', () => ({
  mineBenchmarkCasesFromCorpus: vi.fn().mockResolvedValue({
    corpusSize: 2,
    repositoriesMined: 1,
    repositoriesCloned: 0,
    repositoriesSkipped: 1,
    scannedCommits: 4,
    matchedCommits: 2,
    insertedCases: 1,
    workspaceDir: path.join(fixtureRoot, 'worktrees', 'benchmark-corpus'),
    searchRoots: [path.join(fixtureRoot, 'corpus')],
    repositoryResults: [
      {
        slug: 'openclaw/openclaw',
        groups: ['calibration'],
        patterns: ['extract_shared'],
        repoPath: path.join(fixtureRoot, 'corpus', 'openclaw'),
        status: 'mined',
        mining: {
          repository: 'openclaw/openclaw',
          repoPath: path.join(fixtureRoot, 'corpus', 'openclaw'),
          scannedCommits: 4,
          matchedCommits: 2,
          insertedCases: 1,
          matchedTerms: ['circular dependency'],
        },
      },
      {
        slug: 'microsoft/vscode',
        groups: ['stable-core'],
        patterns: ['direct_import'],
        repoPath: null,
        status: 'skipped',
        reason: 'No local checkout matched the configured search roots',
      },
    ],
    groupSummary: [
      {
        group: 'calibration',
        repositories: 1,
        minedRepositories: 1,
        skippedRepositories: 0,
        insertedCases: 1,
      },
      {
        group: 'stable-core',
        repositories: 1,
        minedRepositories: 0,
        skippedRepositories: 1,
        insertedCases: 0,
      },
      {
        group: 'watchlist',
        repositories: 0,
        minedRepositories: 0,
        skippedRepositories: 0,
        insertedCases: 0,
      },
    ],
    patternSummary: [
      {
        pattern: 'direct_import',
        repositories: 1,
        minedRepositories: 0,
        skippedRepositories: 1,
        insertedCases: 0,
      },
      {
        pattern: 'extract_shared',
        repositories: 1,
        minedRepositories: 1,
        skippedRepositories: 0,
        insertedCases: 1,
      },
    ],
  }),
}));

vi.mock('../analyzer/analyzer.js', () => ({
  analyzeRepository: vi.fn().mockResolvedValue([
    {
      type: 'circular',
      path: ['a.ts', 'b.ts', 'a.ts'],
      analysis: {
        classification: 'autofix_import_type',
        confidence: 0.9,
        reasons: ['Cycle can be resolved by converting concrete imports to type-only imports.'],
        upstreamabilityScore: 0.94,
        planner: {
          cycleFiles: ['a.ts', 'b.ts'],
          cycleSize: 2,
          cycleShape: 'two_file',
          cycleSignals: {
            explicitImportEdges: 2,
            loadedFiles: 2,
            missingFiles: 0,
          },
          fallbackClassification: 'autofix_import_type',
          fallbackConfidence: 0.9,
          fallbackReasons: ['Cycle can be resolved by converting concrete imports to type-only imports.'],
          selectedStrategy: 'import_type',
          selectedClassification: 'autofix_import_type',
          selectedScore: 0.94,
          selectionSummary: 'Selected import_type with score 0.94 after evaluating 3 strategies.',
          attempts: [],
        },
      },
    },
  ]),
}));

vi.mock('./exportPatches.js', () => ({
  exportApprovedPatches: vi.fn().mockResolvedValue({
    outputDir: exportedDir,
    exportedCount: 2,
    files: [path.join(exportedDir, 'a.patch'), path.join(exportedDir, 'b.patch')],
  }),
}));

vi.mock('./createPullRequest.js', () => ({
  createPullRequestForPatch: vi.fn().mockResolvedValue({
    patchId: 12,
    repository: 'acme/widget',
    repoPath: path.join(process.cwd(), '.test-fixtures', 'acme-widget'),
    branchName: 'codex/issue-42-patch-12',
    baseBranch: 'main',
    title: 'Break circular dependency',
    body: 'Closes #42',
    prUrl: 'https://github.com/acme/widget/pull/123',
  }),
}));

describe('CLI', () => {
  it('creates a program with the correct name and version', () => {
    const program = createProgram();
    expect(program.name()).toBe('autofix-bot');
    expect(program.version()).toBe('1.0.0');
  });

  it('scan command logs repository path and calls scanner', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = createProgram();
    program.exitOverride();

    await program.parseAsync(['node', 'test', 'scan', '/some/repo']);

    expect(consoleSpy).toHaveBeenCalledWith('Scanning repository: /some/repo');
    expect(consoleSpy).toHaveBeenCalledWith('Scan completed successfully (Scan ID: 999). Found 2 cycles.');
    consoleSpy.mockRestore();
  });

  it('mine:repo-history command logs repository path and calls miner', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = createProgram();
    program.exitOverride();

    await program.parseAsync(['node', 'test', 'mine:repo-history', '/some/repo', '--label', 'acme/widget']);

    expect(consoleSpy).toHaveBeenCalledWith('Mining benchmark cases from repository: /some/repo');
    expect(consoleSpy).toHaveBeenCalledWith('Mined 2 benchmark case(s) from 3 matching commit(s) in acme/widget.');
    expect(vi.mocked(mineBenchmarkCasesFromRepo)).toHaveBeenCalledWith('/some/repo', {
      repositoryLabel: 'acme/widget',
      maxCommits: undefined,
      maxMatches: undefined,
    });
    consoleSpy.mockRestore();
  });

  it('scan command catches errors and exits', async () => {
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as typeof process.exit);

    // override mock to throw
    vi.mocked(scanRepository).mockRejectedValueOnce(new Error('Scanner error'));

    const program = createProgram();
    program.exitOverride();

    await program.parseAsync(['node', 'test', 'scan', '/some/repo']);

    expect(consoleErrSpy).toHaveBeenCalledWith('Failed to scan repository /some/repo:', expect.any(Error));
    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleErrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('explain command prints planner output as JSON', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = createProgram();
    program.exitOverride();

    await program.parseAsync(['node', 'test', 'explain', '/some/repo']);

    expect(vi.mocked(analyzeRepository)).toHaveBeenCalledWith('/some/repo');
    expect(consoleSpy).toHaveBeenCalledWith(
      JSON.stringify(
        {
          repo: '/some/repo',
          cycleCount: 1,
          cycles: [
            {
              id: 1,
              path: ['a.ts', 'b.ts', 'a.ts'],
              analysis: {
                classification: 'autofix_import_type',
                confidence: 0.9,
                reasons: ['Cycle can be resolved by converting concrete imports to type-only imports.'],
                plan: undefined,
                upstreamabilityScore: 0.94,
                planner: {
                  cycleFiles: ['a.ts', 'b.ts'],
                  cycleSize: 2,
                  cycleShape: 'two_file',
                  cycleSignals: {
                    explicitImportEdges: 2,
                    loadedFiles: 2,
                    missingFiles: 0,
                  },
                  fallbackClassification: 'autofix_import_type',
                  fallbackConfidence: 0.9,
                  fallbackReasons: ['Cycle can be resolved by converting concrete imports to type-only imports.'],
                  selectedStrategy: 'import_type',
                  selectedClassification: 'autofix_import_type',
                  selectedScore: 0.94,
                  selectionSummary: 'Selected import_type with score 0.94 after evaluating 3 strategies.',
                  attempts: [],
                },
              },
            },
          ],
        },
        null,
        2,
      ),
    );

    consoleSpy.mockRestore();
  });

  it('scan:all command logs scanning message', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = createProgram();
    program.exitOverride();

    program.parse(['scan:all'], { from: 'user' });

    expect(consoleSpy).toHaveBeenCalledWith('Scanning all tracked repositories...');
    consoleSpy.mockRestore();
  });

  it('retry:failed command logs retry message', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = createProgram();
    program.exitOverride();

    program.parse(['retry:failed'], { from: 'user' });

    expect(consoleSpy).toHaveBeenCalledWith('Retrying failed patch candidates...');
    consoleSpy.mockRestore();
  });

  it('export:patches command logs export message', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = createProgram();
    program.exitOverride();

    await program.parseAsync(['node', 'test', 'export:patches']);

    expect(consoleSpy).toHaveBeenCalledWith(`Exported 2 patch file(s) to ${exportedDir}`);
    expect(vi.mocked(exportApprovedPatches)).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('create:pr command creates a pull request from a stored patch', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = createProgram();
    program.exitOverride();

    await program.parseAsync(['node', 'test', 'create:pr', '12', '--issue', '42']);

    expect(vi.mocked(createPullRequestForPatch)).toHaveBeenCalledWith(12, {
      linkedIssueNumber: 42,
      title: undefined,
      branchName: undefined,
      baseBranch: undefined,
      repoPath: undefined,
    });
    expect(consoleSpy).toHaveBeenCalledWith(
      'Created PR https://github.com/acme/widget/pull/123 from branch codex/issue-42-patch-12',
    );
    consoleSpy.mockRestore();
  });

  it('mine:corpus command logs JSON summary and calls corpus miner', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = createProgram();
    program.exitOverride();

    await program.parseAsync([
      'node',
      'test',
      'mine:corpus',
      '--only',
      'openclaw/openclaw',
      '--search-root',
      path.join(fixtureRoot, 'corpus'),
      '--clone-missing',
    ]);

    expect(vi.mocked(mineBenchmarkCasesFromCorpus)).toHaveBeenCalledWith({
      onlyRepositories: ['openclaw/openclaw'],
      searchRoots: [path.join(fixtureRoot, 'corpus')],
      workspaceDir: undefined,
      cloneMissing: true,
      limit: undefined,
      maxCommits: undefined,
      maxMatches: undefined,
    });
    expect(JSON.parse(consoleSpy.mock.calls[0][0] as string)).toMatchObject({
      corpusSize: 2,
      repositoriesMined: 1,
      repositoriesSkipped: 1,
      insertedCases: 1,
    });
    consoleSpy.mockRestore();
  });

  it('create:pr command exits on invalid issue number', async () => {
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as typeof process.exit);
    const program = createProgram();
    program.exitOverride();

    await program.parseAsync(['node', 'test', 'create:pr', '12', '--issue', 'not-a-number']);

    expect(consoleErrSpy).toHaveBeenCalledWith('Invalid issue number: not-a-number');
    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleErrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('create:pr command exits on invalid patch id', async () => {
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as typeof process.exit);
    const program = createProgram();
    program.exitOverride();

    await program.parseAsync(['node', 'test', 'create:pr', 'nope', '--issue', '42']);

    expect(consoleErrSpy).toHaveBeenCalledWith('Invalid patch ID: nope');
    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleErrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('has all eight subcommands registered', () => {
    const program = createProgram();
    const commandNames = program.commands.map((cmd) => cmd.name());
    expect(commandNames).toContain('scan');
    expect(commandNames).toContain('explain');
    expect(commandNames).toContain('mine:corpus');
    expect(commandNames).toContain('mine:repo-history');
    expect(commandNames).toContain('scan:all');
    expect(commandNames).toContain('retry:failed');
    expect(commandNames).toContain('create:pr');
    expect(commandNames).toContain('export:patches');
  });
});
