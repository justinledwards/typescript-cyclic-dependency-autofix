import { describe, expect, it, vi } from 'vitest';
import { analyzeRepository } from './analyzer.js';

// Mock dependency-cruiser since we don't want to actually cruise files in tests
vi.mock('dependency-cruiser', () => ({
  cruise: vi.fn(),
}));

import { cruise, type IReporterOutput } from 'dependency-cruiser';

const mockCruise = vi.mocked(cruise);

describe('analyzeRepository', () => {
  it('returns empty array when no violations found', async () => {
    mockCruise.mockResolvedValue({
      output: {
        summary: {
          violations: [],
          error: 0,
          warn: 0,
          info: 0,
          ignore: 0,
          totalCruised: 10,
          totalDependenciesCruised: 20,
          optionsUsed: {},
        },
        modules: [],
      },
      exitCode: 0,
    } as unknown as IReporterOutput);

    const result = await analyzeRepository('/some/path');
    expect(result).toEqual([]);
  });

  it('returns empty array when cruise output is a string', async () => {
    mockCruise.mockResolvedValue({
      output: 'some string output',
      exitCode: 0,
    } as unknown as IReporterOutput);

    const result = await analyzeRepository('/some/path');
    expect(result).toEqual([]);
  });

  it('returns empty array when violations is undefined', async () => {
    mockCruise.mockResolvedValue({
      output: {
        summary: {
          error: 0,
          warn: 0,
          info: 0,
          ignore: 0,
          totalCruised: 0,
          totalDependenciesCruised: 0,
          optionsUsed: {},
        },
        modules: [],
      },
      exitCode: 0,
    } as unknown as IReporterOutput);

    const result = await analyzeRepository('/some/path');
    expect(result).toEqual([]);
  });

  it('extracts circular dependencies from violations', async () => {
    mockCruise.mockResolvedValue({
      output: {
        summary: {
          violations: [
            {
              type: 'cycle',
              from: 'src/a.ts',
              to: 'src/b.ts',
              rule: { name: 'no-circular', severity: 'warn' },
              cycle: [{ name: 'src/b.ts' }, { name: 'src/a.ts' }],
            },
          ],
          error: 0,
          warn: 1,
          info: 0,
          ignore: 0,
          totalCruised: 2,
          totalDependenciesCruised: 2,
          optionsUsed: {},
        },
        modules: [],
      },
      exitCode: 0,
    } as unknown as IReporterOutput);

    const result = await analyzeRepository('/some/path');
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('circular');
    expect(result[0].path).toContain('src/a.ts');
    expect(result[0].path).toContain('src/b.ts');
  });

  it('handles violations without cycle property (fallback to from/to)', async () => {
    mockCruise.mockResolvedValue({
      output: {
        summary: {
          violations: [
            {
              type: 'dependency',
              from: 'src/x.ts',
              to: 'src/y.ts',
              rule: { name: 'no-circular', severity: 'warn' },
            },
          ],
          error: 0,
          warn: 1,
          info: 0,
          ignore: 0,
          totalCruised: 2,
          totalDependenciesCruised: 1,
          optionsUsed: {},
        },
        modules: [],
      },
      exitCode: 0,
    } as unknown as IReporterOutput);

    const result = await analyzeRepository('/some/path');
    expect(result).toHaveLength(1);
    expect(result[0].path).toEqual(['src/x.ts', 'src/y.ts', 'src/x.ts']);
  });

  it('ignores non-circular violation rules', async () => {
    mockCruise.mockResolvedValue({
      output: {
        summary: {
          violations: [
            {
              type: 'dependency',
              from: 'src/a.ts',
              to: 'src/b.ts',
              rule: { name: 'no-orphans', severity: 'warn' },
            },
          ],
          error: 0,
          warn: 1,
          info: 0,
          ignore: 0,
          totalCruised: 2,
          totalDependenciesCruised: 1,
          optionsUsed: {},
        },
        modules: [],
      },
      exitCode: 0,
    } as unknown as IReporterOutput);

    const result = await analyzeRepository('/some/path');
    expect(result).toEqual([]);
  });

  it('throws and logs on cruise error', async () => {
    mockCruise.mockRejectedValue(new Error('cruise failed'));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(analyzeRepository('/bad/path')).rejects.toThrow('cruise failed');
    expect(consoleSpy).toHaveBeenCalledWith('Error analyzing repository:', expect.any(Error));
    consoleSpy.mockRestore();
  });

  it('handles multiple circular violations', async () => {
    mockCruise.mockResolvedValue({
      output: {
        summary: {
          violations: [
            {
              type: 'cycle',
              from: 'src/a.ts',
              to: 'src/b.ts',
              rule: { name: 'no-circular', severity: 'warn' },
              cycle: [{ name: 'src/b.ts' }],
            },
            {
              type: 'cycle',
              from: 'src/c.ts',
              to: 'src/d.ts',
              rule: { name: 'no-circular', severity: 'warn' },
              cycle: [{ name: 'src/d.ts' }],
            },
          ],
          error: 0,
          warn: 2,
          info: 0,
          ignore: 0,
          totalCruised: 4,
          totalDependenciesCruised: 4,
          optionsUsed: {},
        },
        modules: [],
      },
      exitCode: 0,
    } as unknown as IReporterOutput);

    const result = await analyzeRepository('/some/path');
    expect(result).toHaveLength(2);
  });

  it('normalizes dependency-cruiser paths back to repo-relative paths', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/repos/autofix/worktrees/issue-123');

    mockCruise.mockResolvedValue({
      output: {
        summary: {
          violations: [
            {
              type: 'cycle',
              from: '../../../openclaw/src/a.ts',
              to: '../../../openclaw/src/b.ts',
              rule: { name: 'no-circular', severity: 'warn' },
              cycle: [{ name: '../../../openclaw/src/b.ts' }, { name: '../../../openclaw/src/a.ts' }],
            },
          ],
          error: 0,
          warn: 1,
          info: 0,
          ignore: 0,
          totalCruised: 2,
          totalDependenciesCruised: 2,
          optionsUsed: {},
        },
        modules: [],
      },
      exitCode: 0,
    } as unknown as IReporterOutput);

    const result = await analyzeRepository('/repos/openclaw');

    expect(result).toHaveLength(1);
    expect(result[0].path).toEqual(['src/a.ts', 'src/b.ts', 'src/a.ts']);

    cwdSpy.mockRestore();
  });
});
