import type { Database as DatabaseType } from 'better-sqlite3';
import type { RepositoryDTO } from '../db/index.js';
import { createStatements, getDb } from '../db/index.js';
import {
  createConcurrencyLimiter,
  createNoopLogger,
  resolveConcurrencySetting,
  type StructuredLogger,
  serializeError,
} from './observability.js';
import { scanRepository } from './scanner.js';

const DEFAULT_SCAN_CONCURRENCY = 2;
const DEFAULT_VALIDATION_CONCURRENCY = 1;

export interface ScanAllRepositoryResult {
  repositoryId: number;
  repository: string;
  status: 'completed' | 'failed';
  target: string;
  scanId?: number;
  cyclesFound?: number;
  error?: ReturnType<typeof serializeError>;
}

export interface ScanAllResult {
  repositoryCount: number;
  completed: number;
  failed: number;
  scanConcurrency: number;
  validationConcurrency: number;
  results: ScanAllRepositoryResult[];
}

export interface ScanAllOptions {
  worktreesDir?: string;
  scanConcurrency?: number;
  validationConcurrency?: number;
  logger?: StructuredLogger;
  database?: DatabaseType;
}

export async function scanAllTrackedRepositories(options: ScanAllOptions = {}): Promise<ScanAllResult> {
  const database = options.database ?? getDb();
  const repositories = createStatements(database).getAllRepositories.all() as RepositoryDTO[];
  const logger = options.logger ?? createNoopLogger();
  const scanConcurrency = resolveConcurrencySetting(
    options.scanConcurrency,
    'AUTOFIX_SCAN_CONCURRENCY',
    DEFAULT_SCAN_CONCURRENCY,
  );
  const validationConcurrency = resolveConcurrencySetting(
    options.validationConcurrency,
    'AUTOFIX_VALIDATION_CONCURRENCY',
    DEFAULT_VALIDATION_CONCURRENCY,
  );
  const scanLimiter = createConcurrencyLimiter(scanConcurrency);
  const validationLimiter = createConcurrencyLimiter(validationConcurrency);

  logger.info('scan.all.started', {
    repositoryCount: repositories.length,
    scanConcurrency,
    validationConcurrency,
  });

  const results = await Promise.all(
    repositories.map((repository) =>
      scanLimiter.run(async () => {
        const target = repository.local_path ?? `${repository.owner}/${repository.name}`;
        const repositoryLogger = logger.child({
          repositoryId: repository.id,
          repository: `${repository.owner}/${repository.name}`,
        });

        repositoryLogger.info('scan.all.repository.started', { target });

        try {
          const result = await scanRepository(target, options.worktreesDir, {
            logger: repositoryLogger,
            validationLimiter,
          });
          repositoryLogger.info('scan.all.repository.completed', {
            target,
            scanId: result.scanId,
            cyclesFound: result.cyclesFound,
          });

          return {
            repositoryId: repository.id,
            repository: `${repository.owner}/${repository.name}`,
            status: 'completed' as const,
            target,
            scanId: result.scanId,
            cyclesFound: result.cyclesFound,
          };
        } catch (error) {
          const serializedError = serializeError(error);
          repositoryLogger.error('scan.all.repository.failed', {
            target,
            ...serializedError,
          });

          return {
            repositoryId: repository.id,
            repository: `${repository.owner}/${repository.name}`,
            status: 'failed' as const,
            target,
            error: serializedError,
          };
        }
      }),
    ),
  );

  const completed = results.filter((result) => result.status === 'completed').length;
  const failed = results.length - completed;

  logger.info('scan.all.completed', {
    repositoryCount: repositories.length,
    completed,
    failed,
    scanConcurrency,
    validationConcurrency,
  });

  return {
    repositoryCount: repositories.length,
    completed,
    failed,
    scanConcurrency,
    validationConcurrency,
    results,
  };
}
