import fs from 'node:fs/promises';
import path from 'node:path';
import simpleGit from 'simple-git';
import { analyzeRepository } from '../../analyzer/analyzer.js';
import { addScan, updateRepositoryStatus, updateScanStatus } from '../../db/index.js';
import { createNoopLogger, serializeError } from '../observability.js';
import { dedupeCycles, ensureRepository, getLatestCommitSha, persistCycle } from './persistence.js';
import { resolveScanTarget, syncRepositoryClone } from './target.js';
import type { ScanRepositoryOptions } from './types.js';

export async function scanRepository(
  targetUrlOrOwnerName: string,
  worktreesDir = './worktrees',
  options: ScanRepositoryOptions = {},
) {
  const logger = options.logger ?? createNoopLogger();
  const resolvedWorktreesDir = path.resolve(worktreesDir);
  logger.info('scan.started', {
    target: targetUrlOrOwnerName,
    worktreesDir: resolvedWorktreesDir,
  });
  const resolvedTarget = await resolveScanTarget(targetUrlOrOwnerName, resolvedWorktreesDir);
  const { owner, name } = resolvedTarget;
  const repositoryName = `${owner}/${name}`;
  const repositoryLogger = logger.child({
    repository: repositoryName,
  });

  repositoryLogger.info('scan.target.resolved', {
    target: targetUrlOrOwnerName,
    repoPath: resolvedTarget.repoPath,
    localPath: resolvedTarget.localPath,
    remoteUrl: resolvedTarget.remoteUrl,
  });

  const repo = ensureRepository(owner, name, resolvedTarget.localPath);

  updateRepositoryStatus.run({ id: repo.id, status: 'scanning' });

  if (resolvedTarget.localPath) {
    repositoryLogger.info('scan.checkout.reused', {
      repoPath: resolvedTarget.repoPath,
      localPath: resolvedTarget.localPath,
    });
  } else {
    await fs.mkdir(resolvedWorktreesDir, { recursive: true });

    updateRepositoryStatus.run({ id: repo.id, status: 'downloading' });
    const git = simpleGit();
    repositoryLogger.info('scan.clone.started', {
      cloneUrl: resolvedTarget.cloneUrl,
      repoPath: resolvedTarget.repoPath,
    });

    try {
      const syncMode = await syncRepositoryClone(git, resolvedTarget);
      repositoryLogger.info('scan.clone.completed', {
        repoPath: resolvedTarget.repoPath,
        mode: syncMode,
      });
    } catch (error) {
      updateRepositoryStatus.run({ id: repo.id, status: 'clone_failed' });
      repositoryLogger.error('scan.clone.failed', {
        repoPath: resolvedTarget.repoPath,
        ...serializeError(error),
      });
      throw error;
    }
  }

  updateRepositoryStatus.run({ id: repo.id, status: 'scanning' });

  const gitRepo = simpleGit(resolvedTarget.repoPath);
  const commitSha = await getLatestCommitSha(gitRepo);

  const scanInfo = addScan.run({
    repository_id: repo.id,
    commit_sha: commitSha,
    status: 'running',
  });
  const scanId = scanInfo.lastInsertRowid as number;
  const scanLogger = repositoryLogger.child({
    repositoryId: repo.id,
    scanId,
    commitSha,
  });

  try {
    scanLogger.info('scan.analysis.started', {
      repoPath: resolvedTarget.repoPath,
    });
    const cycles = dedupeCycles(await analyzeRepository(resolvedTarget.repoPath));
    scanLogger.info('scan.analysis.completed', {
      cyclesFound: cycles.length,
    });

    for (const cycle of cycles) {
      await persistCycle(
        scanId,
        resolvedTarget.repoPath,
        targetUrlOrOwnerName,
        commitSha,
        resolvedTarget.remoteUrl,
        repo,
        cycle,
        {
          logger: scanLogger,
          validationLimiter: options.validationLimiter,
        },
      );
    }

    updateScanStatus.run({ id: scanId, status: 'completed' });
    updateRepositoryStatus.run({ id: repo.id, status: 'analyzed' });
    scanLogger.info('scan.completed', {
      cyclesFound: cycles.length,
    });

    return { scanId, repoPath: resolvedTarget.repoPath, cyclesFound: cycles.length };
  } catch (error) {
    updateScanStatus.run({ id: scanId, status: 'failed' });
    updateRepositoryStatus.run({ id: repo.id, status: 'analysis_failed' });
    scanLogger.error('scan.failed', {
      ...serializeError(error),
    });
    throw error;
  }
}
