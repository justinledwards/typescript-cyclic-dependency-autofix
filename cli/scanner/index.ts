import fs from 'node:fs/promises';
import path from 'node:path';
import simpleGit from 'simple-git';
import { analyzeRepository } from '../../analyzer/analyzer.js';
import { addScan, updateRepositoryStatus, updateScanStatus } from '../../db/index.js';
import { dedupeCycles, ensureRepository, getLatestCommitSha, persistCycle } from './persistence.js';
import { resolveScanTarget, syncRepositoryClone } from './target.js';

export async function scanRepository(targetUrlOrOwnerName: string, worktreesDir = './worktrees') {
  const resolvedWorktreesDir = path.resolve(worktreesDir);
  const resolvedTarget = await resolveScanTarget(targetUrlOrOwnerName, resolvedWorktreesDir);
  const { owner, name } = resolvedTarget;

  const repo = ensureRepository(owner, name, resolvedTarget.localPath);

  updateRepositoryStatus.run({ id: repo.id, status: 'scanning' });

  if (!resolvedTarget.localPath) {
    await fs.mkdir(resolvedWorktreesDir, { recursive: true });

    updateRepositoryStatus.run({ id: repo.id, status: 'downloading' });
    const git = simpleGit();

    try {
      await syncRepositoryClone(git, resolvedTarget);
    } catch (error) {
      updateRepositoryStatus.run({ id: repo.id, status: 'clone_failed' });
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

  try {
    const cycles = dedupeCycles(await analyzeRepository(resolvedTarget.repoPath));

    for (const cycle of cycles) {
      await persistCycle(
        scanId,
        resolvedTarget.repoPath,
        targetUrlOrOwnerName,
        commitSha,
        resolvedTarget.remoteUrl,
        repo,
        cycle,
      );
    }

    updateScanStatus.run({ id: scanId, status: 'completed' });
    updateRepositoryStatus.run({ id: repo.id, status: 'analyzed' });

    return { scanId, repoPath: resolvedTarget.repoPath, cyclesFound: cycles.length };
  } catch (error) {
    updateScanStatus.run({ id: scanId, status: 'failed' });
    updateRepositoryStatus.run({ id: repo.id, status: 'validation_failed' });
    throw error;
  }
}
