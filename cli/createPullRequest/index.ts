import type { Database as DatabaseType } from 'better-sqlite3';
import simpleGit from 'simple-git';
import { getDb } from '../../db/index.js';
import { loadPullRequestCandidate } from './candidate.js';
import { applyFileSnapshots, ensureCheckoutIsClean, prepareCheckout } from './checkout.js';
import { buildPullRequestBody, buildPullRequestTitle, createGithubPullRequest } from './render.js';
import type { CreatePullRequestOptions, CreatePullRequestResult } from './types.js';

export type { CreatePullRequestOptions, CreatePullRequestResult } from './types.js';

export async function createPullRequestForPatch(
  patchId: number,
  options: CreatePullRequestOptions,
): Promise<CreatePullRequestResult> {
  if (!Number.isInteger(patchId) || patchId <= 0) {
    throw new Error(`Patch ID must be a positive integer. Received: ${patchId}`);
  }

  if (!Number.isInteger(options.linkedIssueNumber) || options.linkedIssueNumber <= 0) {
    throw new Error(`Linked issue number must be a positive integer. Received: ${options.linkedIssueNumber}`);
  }

  const database: DatabaseType = options.database ?? getDb();
  const candidate = loadPullRequestCandidate(patchId, database);

  const branchName = options.branchName ?? `codex/issue-${options.linkedIssueNumber}-patch-${patchId}`;
  const baseBranch = options.baseBranch ?? candidate.defaultBranch;
  const checkoutPath = await prepareCheckout(candidate, options.repoPath, options.checkoutRoot);
  const git = simpleGit(checkoutPath);
  const remoteName = options.remoteName ?? 'origin';

  if (options.repoPath) {
    await ensureCheckoutIsClean(git, checkoutPath);
    await git.raw(['fetch', '--all', '--prune']);
  }

  await git.raw(['checkout', '-B', branchName, candidate.commitSha]);
  await applyFileSnapshots(checkoutPath, candidate.replay.file_snapshots);
  await git.raw(['add', '--all']);

  const status = await git.status();
  if (status.files.length === 0) {
    throw new Error(`Stored patch ${patchId} produced no file changes when applied.`);
  }

  const title = options.title ?? buildPullRequestTitle(candidate);
  const body = buildPullRequestBody(candidate, options.linkedIssueNumber);

  await git.commit(title);
  await git.push(['-u', remoteName, branchName]);

  const prUrl = await createGithubPullRequest({
    owner: candidate.owner,
    name: candidate.name,
    baseBranch,
    branchName,
    title,
    body,
    cwd: checkoutPath,
  });

  return {
    patchId: candidate.patchId,
    repository: `${candidate.owner}/${candidate.name}`,
    repoPath: checkoutPath,
    branchName,
    baseBranch,
    title,
    body,
    prUrl,
  };
}
