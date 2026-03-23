import fs from 'node:fs/promises';
import path from 'node:path';
import simpleGit from 'simple-git';
import { type PlannerRepositoryProfile, SemanticAnalyzer } from '../analyzer/semantic/index.js';
import type { CycleDTO, RepositoryDTO } from '../db/index.js';
import { getDb, getRepository, updateRepositoryLocalPath } from '../db/index.js';
import { type ConcurrencyLimiter, createNoopLogger, type StructuredLogger, serializeError } from './observability.js';
import { profileRepository } from './repoProfile.js';
import {
  getLatestCommitSha,
  getNextCycleObservationVersion,
  persistCycleObservationVersion,
} from './scanner/persistence.js';
import { resolveScanTarget, syncRepositoryClone } from './scanner/target.js';
import type { ScannedCycle } from './scanner/types.js';

interface StoredCycleRow {
  cycle_id: number;
  scan_id: number;
  repository_id: number;
  normalized_path: string;
  observation_version: number;
  raw_payload: string | null;
  owner: string;
  name: string;
  local_path: string | null;
}

export interface RescoreStoredCyclesOptions {
  cycleIds?: number[];
  limit?: number;
  logger?: StructuredLogger;
  onlyFailed?: boolean;
  validationLimiter?: ConcurrencyLimiter;
  worktreesDir?: string;
}

export interface RescoreStoredCyclesResult {
  processedCycles: number;
  skippedCycles: number;
  createdObservations: number;
  retriedOnlyFailed: boolean;
  cycleIds: number[];
}

export async function rescoreStoredCycles(
  options: RescoreStoredCyclesOptions = {},
): Promise<RescoreStoredCyclesResult> {
  const logger = options.logger ?? createNoopLogger();
  const worktreesDir = path.resolve(options.worktreesDir ?? './worktrees');
  const retryableCycles = loadStoredCycles({
    cycleIds: options.cycleIds,
    limit: options.limit,
    onlyFailed: options.onlyFailed ?? false,
  });

  const result: RescoreStoredCyclesResult = {
    processedCycles: 0,
    skippedCycles: 0,
    createdObservations: 0,
    retriedOnlyFailed: options.onlyFailed ?? false,
    cycleIds: [],
  };

  for (const row of retryableCycles) {
    const cycleLogger = logger.child({
      cycleId: row.cycle_id,
      normalizedPath: row.normalized_path,
      observationVersion: row.observation_version,
    });

    const parsedCycle = parseStoredCycle(row.raw_payload, cycleLogger);
    if (!parsedCycle) {
      result.skippedCycles += 1;
      continue;
    }

    const repository = getRepository.get(row.repository_id) as RepositoryDTO | undefined;
    if (!repository) {
      cycleLogger.warn('rescore.skipped', {
        reason: 'Repository row for stored cycle could not be found.',
        repositoryId: row.repository_id,
      });
      result.skippedCycles += 1;
      continue;
    }

    try {
      const resolvedTarget = await resolveStoredRepository(repository, worktreesDir, cycleLogger);
      const repositoryProfile = await safePlannerRepositoryProfile(resolvedTarget.repoPath, cycleLogger);
      const semanticAnalyzer = new SemanticAnalyzer(resolvedTarget.repoPath, {
        repositoryProfile,
      });
      const commitSha = await getLatestCommitSha(simpleGit(resolvedTarget.repoPath));
      const rescoredCycle: ScannedCycle = {
        ...parsedCycle,
        analysis: semanticAnalyzer.analyzeCycle(parsedCycle.path),
      };

      const observationVersion = getNextCycleObservationVersion(row.cycle_id);
      await persistCycleObservationVersion({
        cycleId: row.cycle_id,
        observationVersion,
        scanId: row.scan_id,
        repoPath: resolvedTarget.repoPath,
        sourceTarget: resolvedTarget.localPath ?? `${repository.owner}/${repository.name}`,
        commitSha,
        remoteUrl: resolvedTarget.remoteUrl,
        repository,
        cycle: rescoredCycle,
        logger: cycleLogger,
        validationLimiter: options.validationLimiter,
      });

      result.processedCycles += 1;
      result.createdObservations += 1;
      result.cycleIds.push(row.cycle_id);
      cycleLogger.info('rescore.completed', {
        newObservationVersion: observationVersion,
        classification: rescoredCycle.analysis?.classification ?? null,
      });
    } catch (error) {
      result.skippedCycles += 1;
      cycleLogger.error('rescore.failed', {
        ...serializeError(error),
      });
    }
  }

  return result;
}

export async function retryFailedPatchCandidates(
  options: Omit<RescoreStoredCyclesOptions, 'onlyFailed'> = {},
): Promise<RescoreStoredCyclesResult> {
  return rescoreStoredCycles({
    ...options,
    onlyFailed: true,
  });
}

function loadStoredCycles(args: { cycleIds?: number[]; limit?: number; onlyFailed: boolean }): StoredCycleRow[] {
  const rows = getDb()
    .prepare(
      `
        WITH latest_cycle_observations AS (
          SELECT co.*
          FROM cycle_observations co
          INNER JOIN (
            SELECT cycle_id, MAX(observation_version) AS max_version
            FROM cycle_observations
            GROUP BY cycle_id
          ) latest
            ON latest.cycle_id = co.cycle_id
           AND latest.max_version = co.observation_version
        )
        SELECT
          co.cycle_id,
          co.scan_id,
          co.repository_id,
          co.normalized_path,
          co.observation_version,
          c.raw_payload,
          r.owner,
          r.name,
          r.local_path
        FROM latest_cycle_observations co
        INNER JOIN cycles c ON c.id = co.cycle_id
        INNER JOIN repositories r ON r.id = co.repository_id
        WHERE (
          @only_failed = 0
          OR EXISTS (
            SELECT 1
            FROM candidate_observations cobs
            WHERE cobs.cycle_observation_id = co.id
              AND cobs.validation_status = 'failed'
          )
        )
        ORDER BY co.id ASC
      `,
    )
    .all({
      only_failed: args.onlyFailed ? 1 : 0,
    }) as StoredCycleRow[];

  const filteredRows =
    args.cycleIds && args.cycleIds.length > 0 ? rows.filter((row) => args.cycleIds?.includes(row.cycle_id)) : rows;

  return args.limit ? filteredRows.slice(0, args.limit) : filteredRows;
}

function parseStoredCycle(rawPayload: string | null, logger: StructuredLogger): ScannedCycle | null {
  if (!rawPayload) {
    logger.warn('rescore.skipped', {
      reason: 'Stored cycle is missing a raw payload.',
    });
    return null;
  }

  try {
    return JSON.parse(rawPayload) as ScannedCycle;
  } catch (error) {
    logger.warn('rescore.skipped', {
      reason: 'Stored cycle payload could not be parsed.',
      ...serializeError(error),
    });
    return null;
  }
}

async function resolveStoredRepository(repository: RepositoryDTO, worktreesDir: string, logger: StructuredLogger) {
  const sourceTarget = repository.local_path ?? `${repository.owner}/${repository.name}`;
  const resolvedTarget = await resolveScanTarget(sourceTarget, worktreesDir);

  if (!resolvedTarget.localPath) {
    await fs.mkdir(worktreesDir, { recursive: true });
    await syncRepositoryClone(simpleGit(), resolvedTarget);
  } else if (repository.local_path !== resolvedTarget.localPath) {
    updateRepositoryLocalPath.run({
      id: repository.id,
      local_path: resolvedTarget.localPath,
    });
  }

  logger.info('rescore.target.ready', {
    repoPath: resolvedTarget.repoPath,
    localPath: resolvedTarget.localPath,
    remoteUrl: resolvedTarget.remoteUrl,
  });

  return resolvedTarget;
}

async function safePlannerRepositoryProfile(
  repoPath: string,
  logger: StructuredLogger,
): Promise<PlannerRepositoryProfile | undefined> {
  try {
    const profile = await profileRepository(repoPath);
    return {
      packageManager: profile.packageManager,
      workspaceMode: profile.workspaceMode,
      validationCommandCount: profile.validationCommands.length,
    };
  } catch (error) {
    logger.warn('rescore.profile.failed', {
      repoPath,
      ...serializeError(error),
    });
    return void 0;
  }
}

export function getStoredCycleById(cycleId: number): CycleDTO | undefined {
  return getDb()
    .prepare(
      `
        SELECT *
        FROM cycles
        WHERE id = ?
      `,
    )
    .get(cycleId) as CycleDTO | undefined;
}
