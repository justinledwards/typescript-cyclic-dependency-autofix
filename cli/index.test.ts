import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { exportApprovedPatches } from './exportPatches.js';
import { createProgram } from './index.js';
import { scanRepository } from './scanner.js';
import { formatSmokeSuiteResult, loadSmokeFixtures, runSmokeSuite } from './smoke.js';

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

vi.mock('./smoke.js', () => ({
  loadSmokeFixtures: vi.fn().mockResolvedValue([{ name: 'fixture', target: '/tmp/repo' }]),
  runSmokeSuite: vi.fn().mockResolvedValue({
    passed: 1,
    failed: 0,
    results: [
      {
        name: 'fixture',
        target: '/tmp/repo',
        status: 'passed',
        cyclesFound: 1,
        candidateCount: 1,
        patchCount: 1,
        classifications: {
          unsupported: 1,
        },
      },
    ],
  }),
  formatSmokeSuiteResult: vi.fn().mockReturnValue('Smoke suite complete: 1 passed, 0 failed.'),
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

  it('smoke command loads fixtures and runs the suite', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = createProgram();
    program.exitOverride();

    await program.parseAsync(['node', 'test', 'smoke', './smoke.fixtures.json']);

    expect(consoleSpy).toHaveBeenCalledWith('Running smoke suite from ./smoke.fixtures.json');
    expect(vi.mocked(loadSmokeFixtures)).toHaveBeenCalledWith('./smoke.fixtures.json');
    expect(vi.mocked(runSmokeSuite)).toHaveBeenCalledWith([{ name: 'fixture', target: '/tmp/repo' }]);
    expect(vi.mocked(formatSmokeSuiteResult)).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('smoke command exits when the suite reports failures', async () => {
    vi.mocked(runSmokeSuite).mockResolvedValueOnce({
      passed: 0,
      failed: 1,
      results: [
        {
          name: 'fixture',
          target: '/tmp/repo',
          status: 'failed',
          stage: 'scan',
          message: 'Scan failed',
        },
      ],
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as typeof process.exit);
    const program = createProgram();
    program.exitOverride();

    await program.parseAsync(['node', 'test', 'smoke']);

    expect(consoleSpy).toHaveBeenCalledWith('Running smoke suite from ./smoke.fixtures.json');
    expect(vi.mocked(formatSmokeSuiteResult)).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('smoke command reports fixture loading errors and exits', async () => {
    vi.mocked(loadSmokeFixtures).mockRejectedValueOnce(new Error('Fixture file is invalid'));

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined as never) as typeof process.exit);
    const program = createProgram();
    program.exitOverride();

    await program.parseAsync(['node', 'test', 'smoke']);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Failed to run smoke suite from ./smoke.fixtures.json:',
      expect.any(Error),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('has all five subcommands registered', () => {
    const program = createProgram();
    const commandNames = program.commands.map((cmd) => cmd.name());
    expect(commandNames).toContain('scan');
    expect(commandNames).toContain('scan:all');
    expect(commandNames).toContain('retry:failed');
    expect(commandNames).toContain('export:patches');
    expect(commandNames).toContain('smoke');
  });
});
