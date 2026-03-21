import type { Database as DatabaseType } from 'better-sqlite3';
import type { PullRequestCandidate, PullRequestCandidateRow, ReplayBundle, RequiredReplayBundle } from './types.js';
import { buildGitHubCloneUrl, parseJsonArray } from './utils.js';

export function loadPullRequestCandidate(patchId: number, database: DatabaseType): PullRequestCandidate {
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
