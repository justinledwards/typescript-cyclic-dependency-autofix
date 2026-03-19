import fs from 'node:fs/promises';
import path from 'node:path';
import simpleGit from 'simple-git';
import { analyzeRepository } from '../analyzer/analyzer.js';
import type { GeneratedPatch } from '../codemod/generatePatch.js';
import { generatePatchForCycle } from '../codemod/generatePatch.js';
import type { RepositoryDTO } from '../db/index.js';
import {
  addCycle,
  addFixCandidate,
  addPatch,
  addPatchReplay,
  addRepository,
  addScan,
  getDb,
  getRepositoryByOwnerName,
  updateRepositoryLocalPath,
  updateRepositoryStatus,
  updateScanStatus,
} from '../db/index.js';
import { type ValidationResult, validateGeneratedPatch } from './validation.js';

type ScannedCycle = Awaited<ReturnType<typeof analyzeRepository>>[number];
const GITHUB_HOST = 'github.com';
const UNKNOWN_REPO = 'unknown-repo';

function parseTargetUrl(targetUrlOrOwnerName: string) {
  let owner = 'unknown';
  let name = targetUrlOrOwnerName;

  const githubPath = parseGithubPath(targetUrlOrOwnerName);
  if (githubPath) {
    return githubPath;
  }

  if (targetUrlOrOwnerName.includes(GITHUB_HOST)) {
    const withoutHttps = targetUrlOrOwnerName.replace('https://', '').replace('http://', '');
    const parts = withoutHttps.replace('.git', '').split(`${GITHUB_HOST}/`);
    if (parts.length > 1) {
      const pathParts = parts[1].split('/');
      owner = pathParts[0];
      name = pathParts[1] || UNKNOWN_REPO;
    }
  } else if (targetUrlOrOwnerName.includes('/')) {
    const parts = targetUrlOrOwnerName.split('/');
    owner = parts[0];
    name = parts[1] || UNKNOWN_REPO;
  }
  return { owner, name };
}

export async function scanRepository(targetUrlOrOwnerName: string, worktreesDir = './worktrees') {
  const resolvedTarget = await resolveScanTarget(targetUrlOrOwnerName, worktreesDir);
  const { owner, name } = resolvedTarget;

  const repo = ensureRepository(owner, name, resolvedTarget.localPath);

  updateRepositoryStatus.run({ id: repo.id, status: 'scanning' });

  if (!resolvedTarget.localPath) {
    await fs.mkdir(worktreesDir, { recursive: true });

    updateRepositoryStatus.run({ id: repo.id, status: 'downloading' });
    const git = simpleGit();
    const gitRepo = simpleGit(resolvedTarget.repoPath);

    try {
      await syncRepositoryClone(git, gitRepo, resolvedTarget);
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
    const cycles = await analyzeRepository(resolvedTarget.repoPath);

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

function ensureRepository(owner: string, name: string, localPath: string | null): RepositoryDTO {
  const existingRepo = getRepositoryByOwnerName.get(owner, name) as RepositoryDTO | undefined;
  if (existingRepo) {
    if (localPath && existingRepo.local_path !== localPath) {
      updateRepositoryLocalPath.run({ id: existingRepo.id, local_path: localPath });
      return { ...existingRepo, local_path: localPath };
    }

    return existingRepo;
  }

  const info = addRepository.run({
    owner,
    name,
    default_branch: 'main',
    local_path: localPath,
  });

  const createdRepo = getRepositoryByOwnerName.get(owner, name) as RepositoryDTO | undefined;
  if (createdRepo) {
    return createdRepo;
  }

  return { id: info.lastInsertRowid as number, owner, name } as RepositoryDTO;
}

async function resolveScanTarget(
  targetUrlOrOwnerName: string,
  worktreesDir: string,
): Promise<{
  owner: string;
  name: string;
  repoPath: string;
  localPath: string | null;
  cloneUrl: string | null;
  remoteUrl: string | null;
}> {
  const looksLikeRemoteTarget = targetUrlOrOwnerName.includes(GITHUB_HOST) || targetUrlOrOwnerName.includes('://');
  if (!looksLikeRemoteTarget) {
    const localPath = path.resolve(targetUrlOrOwnerName);
    if (await hasExistingDirectory(localPath)) {
      const { owner, name, remoteUrl } = await resolveLocalRepositoryIdentity(localPath);
      return {
        owner,
        name,
        repoPath: localPath,
        localPath,
        cloneUrl: null,
        remoteUrl,
      };
    }
  }

  const { owner, name } = parseTargetUrl(targetUrlOrOwnerName);
  const cloneUrl =
    targetUrlOrOwnerName.includes(GITHUB_HOST) || !targetUrlOrOwnerName.includes('/')
      ? targetUrlOrOwnerName
      : resolveCloneUrl(owner, name);
  return {
    owner,
    name,
    repoPath: path.join(worktreesDir, `${owner}-${name}`),
    localPath: null,
    cloneUrl,
    remoteUrl: normalizeRemoteUrl(cloneUrl, owner, name),
  };
}

async function syncRepositoryClone(
  git: ReturnType<typeof simpleGit>,
  gitRepo: ReturnType<typeof simpleGit>,
  target: {
    owner: string;
    name: string;
    repoPath: string;
    localPath: string | null;
    cloneUrl: string | null;
  },
): Promise<void> {
  if (await hasClonedRepo(target.repoPath)) {
    await gitRepo.fetch();
    return;
  }

  await git.clone(target.cloneUrl ?? resolveCloneUrl(target.owner, target.name), target.repoPath);
}

async function hasClonedRepo(repoPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(repoPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function hasExistingDirectory(repoPath: string): Promise<boolean> {
  return hasClonedRepo(repoPath);
}

async function resolveLocalRepositoryIdentity(localPath: string): Promise<{
  owner: string;
  name: string;
  remoteUrl: string | null;
}> {
  const git = simpleGit(localPath);

  try {
    const remotes = await git.getRemotes(true);
    const originRemote = remotes.find((remote) => remote.name === 'origin') ?? remotes[0];
    const remoteUrl = originRemote?.refs.fetch ?? originRemote?.refs.push;

    if (remoteUrl) {
      const parsedRemote = parseGithubPath(remoteUrl);
      if (parsedRemote) {
        return { ...parsedRemote, remoteUrl };
      }
    }
  } catch {
    // Fall back to a local-only identity below.
  }

  const baseName = path.basename(localPath).replace(/\.git$/, '') || UNKNOWN_REPO;
  return { owner: 'local', name: baseName, remoteUrl: null };
}

function resolveCloneUrl(owner: string, name: string): string {
  return `https://github.com/${owner}/${name}.git`;
}

function parseGithubPath(input: string): { owner: string; name: string } | null {
  const stripped = input.trim().replace(/\.git$/, '');
  const normalized = stripped
    .replace(/^https?:\/\//, '')
    .replace(/^ssh:\/\//, '')
    .replace(/^git@/, '');

  if (!normalized.includes(GITHUB_HOST)) {
    return null;
  }

  const githubPath = normalized.replace(/^github\.com[/:]/, '').replace(/^github\.com$/, '');

  if (!githubPath) {
    return null;
  }

  const [owner, name] = githubPath.split('/');
  if (!owner) {
    return null;
  }

  return { owner, name: name || UNKNOWN_REPO };
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
  sourceTarget: string,
  commitSha: string,
  remoteUrl: string | null,
  repository: RepositoryDTO,
  cycle: ScannedCycle,
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

  const validation = await validateGeneratedPatch(repoPath, cycle, generatedPatch);
  const patchPayload = {
    fix_candidate_id: fixCandidateInfo.lastInsertRowid as number,
    patch_text: generatedPatch.patchText,
    touched_files: JSON.stringify(generatedPatch.touchedFiles),
    validation_status: validation.status,
    validation_summary: validation.summary,
  };
  const replayBundle = buildPatchReplayBundle({
    scanId,
    sourceTarget,
    commitSha,
    remoteUrl,
    repository,
    cycle,
    generatedPatch,
    validation,
  });

  getDb().transaction((patchRow: typeof patchPayload, replayBundleJson: string) => {
    const patchInfo = addPatch.run(patchRow);
    addPatchReplay.run({
      patch_id: patchInfo.lastInsertRowid as number,
      scan_id: scanId,
      source_target: sourceTarget,
      commit_sha: commitSha,
      replay_bundle: replayBundleJson,
    });
  })(patchPayload, JSON.stringify(replayBundle));
}

interface PatchReplayBundle {
  scan_id: number;
  source_target: string;
  commit_sha: string;
  repository: {
    owner: string;
    name: string;
    default_branch: string | null;
    local_path: string | null;
    remote_url: string | null;
  };
  cycle: {
    path: string[];
    normalized_path: string;
    raw_payload: ScannedCycle;
  };
  candidate: {
    classification: string;
    confidence: number;
    reasons: string[] | null;
  };
  validation: ValidationResult;
  file_snapshots: GeneratedPatch['fileSnapshots'];
  patch_text: string;
}

function buildPatchReplayBundle(args: {
  scanId: number;
  sourceTarget: string;
  commitSha: string;
  remoteUrl: string | null;
  repository: RepositoryDTO;
  cycle: ScannedCycle;
  generatedPatch: GeneratedPatch;
  validation: ValidationResult;
}): PatchReplayBundle {
  return {
    scan_id: args.scanId,
    source_target: args.sourceTarget,
    commit_sha: args.commitSha,
    repository: {
      owner: args.repository.owner,
      name: args.repository.name,
      default_branch: args.repository.default_branch ?? null,
      local_path: args.repository.local_path ?? null,
      remote_url: normalizeRemoteUrl(args.remoteUrl, args.repository.owner, args.repository.name),
    },
    cycle: {
      path: args.cycle.path,
      normalized_path: args.cycle.path.join(' -> '),
      raw_payload: args.cycle,
    },
    candidate: {
      classification: args.cycle.analysis?.classification ?? 'unsupported',
      confidence: args.cycle.analysis?.confidence ?? 0,
      reasons: args.cycle.analysis?.reasons ?? null,
    },
    validation: args.validation,
    file_snapshots: args.generatedPatch.fileSnapshots,
    patch_text: args.generatedPatch.patchText,
  };
}

function normalizeRemoteUrl(remoteUrl: string | null, owner: string, name: string): string | null {
  if (remoteUrl) {
    if (parseGithubPath(remoteUrl)) {
      return remoteUrl;
    }

    return remoteUrl;
  }

  if (owner === 'local') {
    return null;
  }

  return resolveCloneUrl(owner, name);
}
