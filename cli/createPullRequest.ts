import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Database as DatabaseType } from 'better-sqlite3';
import simpleGit from 'simple-git';
import { getDb } from '../db/index.js';

const execFileAsync = promisify(execFile);
const DEFAULT_CHECKOUT_ROOT = path.join(process.cwd(), 'worktrees', 'pull-requests');

interface PullRequestCandidateRow {
  patch_id: number;
  patch_text: string;
  touched_files: string;
  validation_status: string | null;
  validation_summary: string | null;
  fix_candidate_id: number;
  classification: string;
  confidence: number;
  reasons: string | null;
  cycle_id: number;
  normalized_path: string;
  participating_files: string;
  scan_id: number;
  commit_sha: string;
  owner: string;
  name: string;
  default_branch: string | null;
  local_path: string | null;
  review_status: string;
  replay_bundle: string | null;
}

interface ReplayBundle {
  source_target?: string;
  commit_sha?: string;
  repository?: {
    owner?: string;
    name?: string;
    default_branch?: string | null;
    local_path?: string | null;
    remote_url?: string | null;
  };
  cycle?: {
    path?: string[];
    normalized_path?: string;
    raw_payload?: unknown;
  };
  candidate?: {
    classification?: string;
    confidence?: number;
    reasons?: string[] | null;
  };
  validation?: {
    status?: string;
    summary?: string;
  };
  file_snapshots?: FileSnapshot[];
  patch_text?: string;
}

interface FileSnapshot {
  path: string;
  before: string;
  after: string;
}

interface PullRequestCandidate {
  patchId: number;
  fixCandidateId: number;
  cycleId: number;
  scanId: number;
  owner: string;
  name: string;
  defaultBranch: string;
  localPath: string | null;
  reviewStatus: string;
  validationStatus: string;
  validationSummary: string;
  classification: string;
  confidence: number;
  reasons: string[];
  normalizedPath: string;
  cyclePath: string[];
  touchedFiles: string[];
  commitSha: string;
  replay: RequiredReplayBundle;
}

interface RequiredReplayBundle {
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
  };
  candidate: {
    classification: string;
    confidence: number;
    reasons: string[] | null;
  };
  validation: {
    status: string;
    summary: string;
  };
  file_snapshots: FileSnapshot[];
  patch_text: string;
}

export interface CreatePullRequestOptions {
  linkedIssueNumber: number;
  title?: string;
  branchName?: string;
  baseBranch?: string;
  repoPath?: string;
  checkoutRoot?: string;
  remoteName?: string;
  database?: DatabaseType;
}

export interface CreatePullRequestResult {
  patchId: number;
  repository: string;
  repoPath: string;
  branchName: string;
  baseBranch: string;
  title: string;
  body: string;
  prUrl: string;
}

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

  const database = options.database ?? getDb();
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

function loadPullRequestCandidate(patchId: number, database: DatabaseType): PullRequestCandidate {
  const row = database
    .prepare(
      `
      SELECT
        p.id AS patch_id,
        p.patch_text,
        p.touched_files,
        p.validation_status,
        p.validation_summary,
        fc.id AS fix_candidate_id,
        fc.classification,
        fc.confidence,
        fc.reasons,
        c.id AS cycle_id,
        c.normalized_path,
        c.participating_files,
        s.id AS scan_id,
        s.commit_sha,
        r.owner,
        r.name,
        r.default_branch,
        r.local_path,
        COALESCE(rd.decision, 'pending') AS review_status,
        pr.replay_bundle
      FROM patches p
      INNER JOIN fix_candidates fc ON fc.id = p.fix_candidate_id
      INNER JOIN cycles c ON c.id = fc.cycle_id
      INNER JOIN scans s ON s.id = c.scan_id
      INNER JOIN repositories r ON r.id = s.repository_id
      LEFT JOIN patch_replays pr ON pr.patch_id = p.id
      LEFT JOIN review_decisions rd ON rd.id = (
        SELECT id
        FROM review_decisions
        WHERE patch_id = p.id
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      )
      WHERE p.id = ?
    `,
    )
    .get(patchId) as PullRequestCandidateRow | undefined;

  if (!row) {
    throw new Error(`Patch ${patchId} was not found.`);
  }

  if (row.validation_status !== 'passed') {
    throw new Error(`Patch ${patchId} is not validated. Expected validation_status='passed'.`);
  }

  if (!['approved', 'pr_candidate'].includes(row.review_status)) {
    throw new Error(`Patch ${patchId} must be marked approved or pr_candidate before creating a PR.`);
  }

  const replay = parseReplayBundle(row.replay_bundle, row);

  return {
    patchId: row.patch_id,
    fixCandidateId: row.fix_candidate_id,
    cycleId: row.cycle_id,
    scanId: row.scan_id,
    owner: row.owner,
    name: row.name,
    defaultBranch: row.default_branch ?? 'main',
    localPath: row.local_path,
    reviewStatus: row.review_status,
    validationStatus: row.validation_status,
    validationSummary: row.validation_summary ?? replay.validation.summary,
    classification: row.classification,
    confidence: row.confidence,
    reasons: parseJsonArray(row.reasons),
    normalizedPath: row.normalized_path,
    cyclePath: parseJsonArray(row.participating_files),
    touchedFiles: parseJsonArray(row.touched_files),
    commitSha: row.commit_sha,
    replay,
  };
}

function parseReplayBundle(replayBundle: string | null, row: PullRequestCandidateRow): RequiredReplayBundle {
  if (!replayBundle) {
    throw new Error(`Patch ${row.patch_id} does not have a replay bundle. Re-scan it after issue #21 is merged.`);
  }

  let parsed: ReplayBundle;
  try {
    parsed = JSON.parse(replayBundle) as ReplayBundle;
  } catch {
    throw new Error(`Patch ${row.patch_id} has an invalid replay bundle payload.`);
  }

  if (!parsed.file_snapshots?.length) {
    throw new Error(`Patch ${row.patch_id} replay bundle does not contain file snapshots.`);
  }

  return {
    source_target: parsed.source_target ?? `${row.owner}/${row.name}`,
    commit_sha: parsed.commit_sha ?? row.commit_sha,
    repository: {
      owner: parsed.repository?.owner ?? row.owner,
      name: parsed.repository?.name ?? row.name,
      default_branch: parsed.repository?.default_branch ?? row.default_branch ?? 'main',
      local_path: parsed.repository?.local_path ?? row.local_path,
      remote_url: parsed.repository?.remote_url ?? buildGitHubCloneUrl(row.owner, row.name),
    },
    cycle: {
      path: parsed.cycle?.path ?? parseJsonArray(row.participating_files),
      normalized_path: parsed.cycle?.normalized_path ?? row.normalized_path,
    },
    candidate: {
      classification: parsed.candidate?.classification ?? row.classification,
      confidence: parsed.candidate?.confidence ?? row.confidence,
      reasons: parsed.candidate?.reasons ?? parseJsonArray(row.reasons),
    },
    validation: {
      status: parsed.validation?.status ?? row.validation_status ?? 'passed',
      summary: parsed.validation?.summary ?? row.validation_summary ?? 'Validation passed.',
    },
    file_snapshots: parsed.file_snapshots,
    patch_text: parsed.patch_text ?? row.patch_text,
  };
}

async function prepareCheckout(
  candidate: PullRequestCandidate,
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

async function ensureCheckoutIsClean(git: ReturnType<typeof simpleGit>, checkoutPath: string): Promise<void> {
  const status = await git.status();
  if (status.files.length > 0) {
    throw new Error(`Checkout ${checkoutPath} has uncommitted changes. Use a clean checkout or omit --repo-path.`);
  }
}

async function applyFileSnapshots(repoPath: string, snapshots: FileSnapshot[]): Promise<void> {
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

function buildPullRequestTitle(candidate: PullRequestCandidate): string {
  const basenames = [...new Set(candidate.cyclePath.map((filePath) => path.basename(filePath)))];
  if (basenames.length >= 2) {
    return `Break circular dependency between ${basenames[0]} and ${basenames[1]}`;
  }

  return `Break circular dependency for patch ${candidate.patchId}`;
}

function buildPullRequestBody(candidate: PullRequestCandidate, linkedIssueNumber: number): string {
  const touchedFiles =
    candidate.touchedFiles.length > 0
      ? candidate.touchedFiles
      : candidate.replay.file_snapshots.map((snapshot) => snapshot.path);
  const reasons = candidate.reasons.length > 0 ? candidate.reasons : (candidate.replay.candidate.reasons ?? []);
  const confidence = `${Math.round(candidate.confidence * 100)}%`;

  return [
    `Closes #${linkedIssueNumber}`,
    '',
    '## Summary',
    `- Classification: \`${candidate.classification}\``,
    `- Confidence: ${confidence}`,
    `- Cycle: \`${candidate.normalizedPath}\``,
    `- Source target: \`${candidate.replay.source_target}\``,
    `- Source commit: \`${candidate.commitSha}\``,
    `- Patch ID: ${candidate.patchId}`,
    `- Scan ID: ${candidate.scanId}`,
    '',
    '## Touched Files',
    ...touchedFiles.map((filePath) => `- \`${filePath}\``),
    '',
    '## Reasons',
    ...(reasons.length > 0 ? reasons.map((reason) => `- ${reason}`) : ['- No explicit reasons were stored.']),
    '',
    '## Validation',
    candidate.validationSummary,
  ].join('\n');
}

async function createGithubPullRequest(args: {
  owner: string;
  name: string;
  baseBranch: string;
  branchName: string;
  title: string;
  body: string;
  cwd: string;
}): Promise<string> {
  try {
    const result = await execFileAsync(
      'gh',
      [
        'pr',
        'create',
        '--repo',
        `${args.owner}/${args.name}`,
        '--base',
        args.baseBranch,
        '--head',
        args.branchName,
        '--title',
        args.title,
        '--body',
        args.body,
      ],
      { cwd: args.cwd },
    );

    const stdout = typeof result === 'string' ? result : result.stdout;
    return stdout.trim();
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      throw new Error('GitHub CLI `gh` is required to create pull requests automatically.', { cause: error });
    }

    throw error;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    !!error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && error.code === code
  );
}

function buildGitHubCloneUrl(owner: string, name: string): string {
  return `https://github.com/${owner}/${name}.git`;
}

function parseJsonArray(value: string | null): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function sanitizeSegment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]+/g, '-');
}
