import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, createStatements, initSchema } from '../db/index.js';
import { createNoopLogger } from './observability.js';
import { scanAllTrackedRepositories } from './scanAll.js';
import { scanRepository } from './scanner.js';

vi.mock('./scanner.js', () => ({
  scanRepository: vi.fn(),
}));

describe('scanAllTrackedRepositories', () => {
  const fixtureRoot = `${process.cwd()}/.test-fixtures`;
  let db: ReturnType<typeof createDatabase>;
  let statements: ReturnType<typeof createStatements>;

  beforeEach(() => {
    vi.resetAllMocks();
    db = createDatabase(':memory:');
    initSchema(db);
    statements = createStatements(db);
  });

  it('applies scan and validation concurrency settings across tracked repositories', async () => {
    statements.addRepository.run({
      owner: 'acme',
      name: 'widget',
      default_branch: 'main',
      local_path: null,
    });
    statements.addRepository.run({
      owner: 'acme',
      name: 'gadget',
      default_branch: 'main',
      local_path: `${fixtureRoot}/gadget`,
    });
    statements.addRepository.run({
      owner: 'acme',
      name: 'service',
      default_branch: 'main',
      local_path: null,
    });

    let activeCount = 0;
    let maxActiveCount = 0;

    vi.mocked(scanRepository).mockImplementation(
      async (
        target: string,
        worktreesDir?: string,
        options?: {
          validationLimiter?: { limit: number };
        },
      ) => {
        activeCount += 1;
        maxActiveCount = Math.max(maxActiveCount, activeCount);
        await new Promise((resolve) => {
          setTimeout(resolve, target.includes('gadget') ? 15 : 5);
        });
        activeCount -= 1;

        return {
          scanId: target.length,
          repoPath: worktreesDir ?? `${fixtureRoot}/worktrees`,
          cyclesFound: options?.validationLimiter?.limit ?? 0,
        };
      },
    );

    const result = await scanAllTrackedRepositories({
      database: db,
      logger: createNoopLogger(),
      scanConcurrency: 2,
      validationConcurrency: 3,
      worktreesDir: `${fixtureRoot}/worktrees`,
    });

    expect(maxActiveCount).toBeLessThanOrEqual(2);
    expect(result.scanConcurrency).toBe(2);
    expect(result.validationConcurrency).toBe(3);
    expect(result.completed).toBe(3);
    expect(result.failed).toBe(0);
    expect(vi.mocked(scanRepository)).toHaveBeenCalledWith(
      `${fixtureRoot}/gadget`,
      `${fixtureRoot}/worktrees`,
      expect.objectContaining({
        validationLimiter: expect.objectContaining({ limit: 3 }),
      }),
    );
    expect(vi.mocked(scanRepository)).toHaveBeenCalledWith(
      'acme/widget',
      `${fixtureRoot}/worktrees`,
      expect.objectContaining({
        validationLimiter: expect.objectContaining({ limit: 3 }),
      }),
    );
    expect(new Set(result.results.map((entry) => entry.target))).toEqual(
      new Set([`${fixtureRoot}/gadget`, 'acme/service', 'acme/widget']),
    );
  });
});
