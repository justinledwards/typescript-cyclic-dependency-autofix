import fs from 'node:fs/promises';
import path from 'node:path';
import simpleGit from 'simple-git';
import type { ResolvedScanTarget } from './types.js';

const GITHUB_HOST = 'github.com';
const UNKNOWN_REPO = 'unknown-repo';

export function parseTargetUrl(targetUrlOrOwnerName: string) {
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

export async function resolveScanTarget(
  targetUrlOrOwnerName: string,
  worktreesDir: string,
): Promise<ResolvedScanTarget> {
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

export async function syncRepositoryClone(
  git: ReturnType<typeof simpleGit>,
  target: Pick<ResolvedScanTarget, 'owner' | 'name' | 'repoPath' | 'localPath' | 'cloneUrl'>,
): Promise<'cloned' | 'fetched'> {
  if (await hasClonedRepo(target.repoPath)) {
    const gitRepo = simpleGit(target.repoPath);
    await gitRepo.fetch();
    return 'fetched';
  }

  await git.clone(target.cloneUrl ?? resolveCloneUrl(target.owner, target.name), target.repoPath);
  return 'cloned';
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
