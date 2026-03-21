import type { CircularDependency } from '../../analyzer/analyzer.js';
import type { GeneratedPatch } from '../../codemod/generatePatch.js';
import type { ConcurrencyLimiter, StructuredLogger } from '../observability.js';
import type { ValidationResult } from '../validation.js';

export type ScannedCycle = CircularDependency;

export interface ScanRepositoryOptions {
  logger?: StructuredLogger;
  validationLimiter?: ConcurrencyLimiter;
}

export interface ResolvedScanTarget {
  owner: string;
  name: string;
  repoPath: string;
  localPath: string | null;
  cloneUrl: string | null;
  remoteUrl: string | null;
}

export interface PatchReplayBundle {
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
    upstreamabilityScore?: number;
    reasons: string[] | null;
  };
  validation: ValidationResult;
  file_snapshots: GeneratedPatch['fileSnapshots'];
  patch_text: string;
}
