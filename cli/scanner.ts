import fs from 'node:fs/promises';
import path from 'node:path';
import simpleGit from 'simple-git';
import { analyzeRepository } from '../analyzer/analyzer.js';
import type { RepositoryDTO } from '../db/index.js';
import {
  addCycle,
  addFixCandidate,
  addRepository,
  addScan,
  getRepositoryByOwnerName,
  updateRepositoryStatus,
  updateScanStatus,
} from '../db/index.js';

function parseTargetUrl(targetUrlOrOwnerName: string) {
  let owner = 'unknown';
  let name = targetUrlOrOwnerName;

  if (targetUrlOrOwnerName.includes('github.com')) {
    const withoutHttps = targetUrlOrOwnerName.replace('https://', '').replace('http://', '');
    const parts = withoutHttps.replace('.git', '').split('github.com/');
    if (parts.length > 1) {
      const pathParts = parts[1].split('/');
      owner = pathParts[0];
      name = pathParts[1] || 'unknown-repo';
    }
  } else if (targetUrlOrOwnerName.includes('/')) {
    const parts = targetUrlOrOwnerName.split('/');
    owner = parts[0];
    name = parts[1] || 'unknown-repo';
  }
  return { owner, name };
}

export async function scanRepository(targetUrlOrOwnerName: string, worktreesDir = './worktrees') {
  const { owner, name } = parseTargetUrl(targetUrlOrOwnerName);

  // Find or create repository
  let repo = getRepositoryByOwnerName.get(owner, name) as RepositoryDTO | undefined;
  if (!repo) {
    const info = addRepository.run({
      owner,
      name,
      default_branch: 'main',
      local_path: null,
    });
    repo = { id: info.lastInsertRowid as number, owner, name } as RepositoryDTO;
  }

  updateRepositoryStatus.run({ id: repo.id, status: 'scanning' });

  // Manage git worktree
  await fs.mkdir(worktreesDir, { recursive: true });
  const repoPath = path.join(worktreesDir, `${owner}-${name}`);

  updateRepositoryStatus.run({ id: repo.id, status: 'downloading' });
  const git = simpleGit();

  let isCloned = false;
  try {
    const stat = await fs.stat(repoPath);
    isCloned = stat.isDirectory();
  } catch {
    // doesn't exist
  }

  const gitRepo = simpleGit(repoPath);

  try {
    if (isCloned) {
      await gitRepo.fetch();
    } else {
      let cloneUrl = targetUrlOrOwnerName;
      if (!targetUrlOrOwnerName.includes('github.com') && targetUrlOrOwnerName.includes('/')) {
        cloneUrl = `https://github.com/${owner}/${name}.git`;
      }
      await git.clone(cloneUrl, repoPath);
    }
  } catch (error) {
    updateRepositoryStatus.run({ id: repo.id, status: 'clone_failed' });
    throw error;
  }

  updateRepositoryStatus.run({ id: repo.id, status: 'scanning' });

  let commitSha = 'unknown';
  try {
    const log = await gitRepo.log(['-1']);
    commitSha = log.latest ? log.latest.hash : /* v8 ignore next */ 'unknown';
  } catch {
    /* v8 ignore next 2 */
    // empty repo
  }

  const scanInfo = addScan.run({
    repository_id: repo.id,
    commit_sha: commitSha,
    status: 'running',
  });
  const scanId = scanInfo.lastInsertRowid as number;

  try {
    const cycles = await analyzeRepository(repoPath);

    for (const cycle of cycles) {
      const cycleInfo = addCycle.run({
        scan_id: scanId,
        normalized_path: cycle.path.join(' -> '),
        participating_files: JSON.stringify(cycle.path),
        raw_payload: JSON.stringify(cycle),
      });

      if (cycle.analysis) {
        addFixCandidate.run({
          cycle_id: cycleInfo.lastInsertRowid as number,
          classification: cycle.analysis.classification,
          confidence: cycle.analysis.confidence,
          reasons: JSON.stringify(cycle.analysis.reasons),
        });
      }
    }

    updateScanStatus.run({ id: scanId, status: 'completed' });
    updateRepositoryStatus.run({ id: repo.id, status: 'analyzed' });

    return { scanId, repoPath, cyclesFound: cycles.length };
  } catch (error) {
    updateScanStatus.run({ id: scanId, status: 'failed' });
    updateRepositoryStatus.run({ id: repo.id, status: 'validation_failed' });
    throw error;
  }
}
