import type { Database as DatabaseType } from 'better-sqlite3';

export interface PullRequestCandidateRow {
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

export interface ReplayBundle {
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
    upstreamabilityScore?: number;
    reasons?: string[] | null;
  };
  validation?: {
    status?: string;
    summary?: string;
  };
  file_snapshots?: FileSnapshot[];
  patch_text?: string;
}

export interface FileSnapshot {
  path: string;
  before: string;
  after: string;
}

export interface RequiredReplayBundle {
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
    upstreamabilityScore?: number;
    reasons: string[] | null;
  };
  validation: {
    status: string;
    summary: string;
  };
  file_snapshots: FileSnapshot[];
  patch_text: string;
}

export interface PullRequestCandidate {
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
  upstreamabilityScore: number | null;
  reasons: string[];
  normalizedPath: string;
  cyclePath: string[];
  touchedFiles: string[];
  commitSha: string;
  replay: RequiredReplayBundle;
}

export interface CreatePullRequestOptions {
  linkedIssueNumber: number;
  title?: string;
  branchName?: string;
  baseBranch?: string;
  repoPath?: string;
  checkoutRoot?: string;
  remoteName?: string;
  minimumUpstreamabilityScore?: number;
  allowBelowThreshold?: boolean;
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
