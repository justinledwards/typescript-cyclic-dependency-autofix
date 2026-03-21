import { describe, expect, it } from 'vitest';
import {
  createConcurrencyLimiter,
  createStructuredLogger,
  resolveConcurrencySetting,
  serializeError,
} from './observability.js';

describe('createStructuredLogger', () => {
  it('emits JSON log lines with level, event, and fields', () => {
    const lines: string[] = [];
    const logger = createStructuredLogger((line) => {
      lines.push(line);
    }).child({ repository: 'acme/widget' });

    logger.info('scan.started', {
      scanId: 42,
      cyclesFound: 3,
    });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(
      expect.objectContaining({
        level: 'info',
        event: 'scan.started',
        repository: 'acme/widget',
        scanId: 42,
        cyclesFound: 3,
      }),
    );
  });
});

describe('createConcurrencyLimiter', () => {
  it('caps the number of active tasks', async () => {
    const limiter = createConcurrencyLimiter(2);
    let activeCount = 0;
    let maxActiveCount = 0;

    const tasks = Array.from({ length: 5 }, async (_, index) =>
      limiter.run(async () => {
        activeCount += 1;
        maxActiveCount = Math.max(maxActiveCount, activeCount);
        await new Promise((resolve) => {
          setTimeout(resolve, 5 + index);
        });
        activeCount -= 1;
        return index;
      }),
    );

    const results = await Promise.all(tasks);

    expect(results).toEqual([0, 1, 2, 3, 4]);
    expect(maxActiveCount).toBeLessThanOrEqual(2);
  });
});

describe('resolveConcurrencySetting', () => {
  it('prefers the explicit value when provided', () => {
    process.env.AUTOFIX_TEST_CONCURRENCY = '9';

    expect(resolveConcurrencySetting(3, 'AUTOFIX_TEST_CONCURRENCY', 1)).toBe(3);
  });

  it('falls back to an environment variable when explicit value is missing', () => {
    process.env.AUTOFIX_TEST_CONCURRENCY = '4';

    expect(resolveConcurrencySetting(undefined, 'AUTOFIX_TEST_CONCURRENCY', 1)).toBe(4);
  });

  it('falls back to the default when the environment variable is unset', () => {
    delete process.env.AUTOFIX_TEST_CONCURRENCY;

    expect(resolveConcurrencySetting(undefined, 'AUTOFIX_TEST_CONCURRENCY', 2)).toBe(2);
  });
});

describe('serializeError', () => {
  it('captures the name and message from Error instances', () => {
    const serialized = serializeError(new TypeError('boom'));

    expect(serialized).toEqual(
      expect.objectContaining({
        errorName: 'TypeError',
        errorMessage: 'boom',
      }),
    );
  });
});
