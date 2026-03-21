import fs from 'node:fs/promises';
import path from 'node:path';
import simpleGit from 'simple-git';
import type { FileSnapshot, PullRequestCandidate } from './types.js';
import { buildGitHubCloneUrl, sanitizeSegment } from './utils.js';

const DEFAULT_CHECKOUT_ROOT = path.join(process.cwd(), 'worktrees', 'pull-requests');

export async function prepareCheckout(
  candidate: Pick<PullRequestCandidate, 'owner' | 'name' | 'patchId' | 'replay'>,
  explicitRepoPath?: string,
  checkoutRoot = DEFAULT_CHECKOUT_ROOT,
): Promise<string> {
  if (explicitRepoPath) {
    const repoPath = path.resolve(explicitRepoPath);
    await fs.access(repoPath);
    return repoPath;
  }

  await fs.mkdir(checkoutRoot, { recursive: true });
  const checkoutPath = await fs.mkdtemp(
    path.join(
      checkoutRoot,
      `${sanitizeSegment(candidate.owner)}-${sanitizeSegment(candidate.name)}-patch-${candidate.patchId}-`,
    ),
  );

  const remoteUrl = candidate.replay.repository.remote_url ?? buildGitHubCloneUrl(candidate.owner, candidate.name);
  await simpleGit().clone(remoteUrl, checkoutPath);
  return checkoutPath;
}

export async function ensureCheckoutIsClean(git: ReturnType<typeof simpleGit>, checkoutPath: string): Promise<void> {
  const status = await git.status();
  if (status.files.length > 0) {
    throw new Error(`Checkout ${checkoutPath} has uncommitted changes. Use a clean checkout or omit --repo-path.`);
  }
}

export async function applyFileSnapshots(repoPath: string, snapshots: FileSnapshot[]): Promise<void> {
  for (const snapshot of snapshots) {
    const absolutePath = path.join(repoPath, snapshot.path);
    const currentContent = await readFileIfExists(absolutePath);
    if (currentContent !== snapshot.before) {
      throw new Error(`Snapshot precondition failed for ${snapshot.path}. The checkout does not match stored inputs.`);
    }

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, snapshot.after, 'utf8');
  }
}

async function readFileIfExists(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return '';
    }

    throw error;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    !!error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && error.code === code
  );
}
