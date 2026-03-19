import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createPullRequestForPatch } from './createPullRequest.js';
import { exportApprovedPatches } from './exportPatches.js';
import { createProgram } from './index.js';
import { scanRepository } from './scanner.js';

const exportedDir = path.join(os.tmpdir(), 'patches');

vi.mock('./scanner.js', () => ({
  scanRepository: vi.fn().mockResolvedValue({ scanId: 999, cyclesFound: 2 }),
}));

vi.mock('./exportPatches.js', () => ({
  exportApprovedPatches: vi.fn().mockResolvedValue({
    outputDir: path.join(os.tmpdir(), 'patches'),
    exportedCount: 2,
    files: [path.join(os.tmpdir(), 'patches', 'a.patch'), path.join(os.tmpdir(), 'patches', 'b.patch')],
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

  it('has all five subcommands registered', () => {
    const program = createProgram();
    const commandNames = program.commands.map((cmd) => cmd.name());
    expect(commandNames).toContain('scan');
    expect(commandNames).toContain('scan:all');
    expect(commandNames).toContain('retry:failed');
    expect(commandNames).toContain('create:pr');
    expect(commandNames).toContain('export:patches');
  });
});
