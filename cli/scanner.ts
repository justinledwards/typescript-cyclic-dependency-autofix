import fs from 'node:fs/promises';
import path from 'node:path';
import simpleGit from 'simple-git';
import { analyzeRepository } from '../analyzer/analyzer.js';
import { generatePatchForCycle } from '../codemod/generatePatch.js';
import type { RepositoryDTO } from '../db/index.js';
import {
  addCycle,
  addFixCandidate,
  addPatch,
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

  const repo = ensureRepository(owner, name);

  updateRepositoryStatus.run({ id: repo.id, status: 'scanning' });

  await fs.mkdir(worktreesDir, { recursive: true });
  const repoPath = path.join(worktreesDir, `${owner}-${name}`);

  updateRepositoryStatus.run({ id: repo.id, status: 'downloading' });
  const git = simpleGit();
  const gitRepo = simpleGit(repoPath);

  try {
    await syncRepositoryClone(git, gitRepo, repoPath, owner, name, targetUrlOrOwnerName);
  } catch (error) {
    updateRepositoryStatus.run({ id: repo.id, status: 'clone_failed' });
    throw error;
  }

  updateRepositoryStatus.run({ id: repo.id, status: 'scanning' });

  const commitSha = await getLatestCommitSha(gitRepo);

  const scanInfo = addScan.run({
    repository_id: repo.id,
    commit_sha: commitSha,
    status: 'running',
  });
  const scanId = scanInfo.lastInsertRowid as number;

  try {
    const cycles = await analyzeRepository(repoPath);

    for (const cycle of cycles) {
      await persistCycle(scanId, repoPath, cycle);
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

function ensureRepository(owner: string, name: string): RepositoryDTO {
  const existingRepo = getRepositoryByOwnerName.get(owner, name) as RepositoryDTO | undefined;
  if (existingRepo) {
    return existingRepo;
  }

  const info = addRepository.run({
    owner,
    name,
    default_branch: 'main',
    local_path: null,
  });

  return { id: info.lastInsertRowid as number, owner, name } as RepositoryDTO;
}

async function syncRepositoryClone(
  git: ReturnType<typeof simpleGit>,
  gitRepo: ReturnType<typeof simpleGit>,
  repoPath: string,
  owner: string,
  name: string,
  targetUrlOrOwnerName: string,
): Promise<void> {
  if (await hasClonedRepo(repoPath)) {
    await gitRepo.fetch();
    return;
  }

  await git.clone(resolveCloneUrl(targetUrlOrOwnerName, owner, name), repoPath);
}

async function hasClonedRepo(repoPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(repoPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function resolveCloneUrl(targetUrlOrOwnerName: string, owner: string, name: string): string {
  if (targetUrlOrOwnerName.includes('github.com') || !targetUrlOrOwnerName.includes('/')) {
    return targetUrlOrOwnerName;
  }

  return `https://github.com/${owner}/${name}.git`;
}

async function getLatestCommitSha(gitRepo: ReturnType<typeof simpleGit>): Promise<string> {
  try {
    const log = await gitRepo.log(['-1']);
    return log.latest ? log.latest.hash : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function persistCycle(
  scanId: number,
  repoPath: string,
  cycle: Awaited<ReturnType<typeof analyzeRepository>>[number],
): Promise<void> {
  const cycleInfo = addCycle.run({
    scan_id: scanId,
    normalized_path: cycle.path.join(' -> '),
    participating_files: JSON.stringify(cycle.path),
    raw_payload: JSON.stringify(cycle),
  });

  if (!cycle.analysis) {
    return;
  }

  const fixCandidateInfo = addFixCandidate.run({
    cycle_id: cycleInfo.lastInsertRowid as number,
    classification: cycle.analysis.classification,
    confidence: cycle.analysis.confidence,
    reasons: JSON.stringify(cycle.analysis.reasons),
  });

  const generatedPatch = await generatePatchForCycle(repoPath, cycle, cycle.analysis);
  if (!generatedPatch) {
    return;
  }

  addPatch.run({
    fix_candidate_id: fixCandidateInfo.lastInsertRowid as number,
    patch_text: generatedPatch.patchText,
    touched_files: JSON.stringify(generatedPatch.touchedFiles),
    validation_status: generatedPatch.validationStatus,
    validation_summary: generatedPatch.validationSummary,
  });
}
