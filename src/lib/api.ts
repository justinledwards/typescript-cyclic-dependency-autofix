const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

const NETWORK_ERROR = 'Network response was not ok';

export type ReviewDecision = 'approved' | 'rejected' | 'ignored' | 'pr_candidate';

export interface FindingsFilters {
  repository_id?: string | number;
  search?: string;
  classification?: string;
  validation_status?: string;
  review_status?: string;
  cycle_size?: string | number;
}

export interface FindingRecord {
  cycle_id: number;
  scan_id: number;
  normalized_path: string;
  participating_files: string;
  raw_payload: unknown;
  fix_candidate_id: number | null;
  classification: string | null;
  confidence: number | null;
  reasons: unknown;
  patch_id: number | null;
  patch_text: string | null;
  validation_status: string;
  validation_summary: string | null;
  review_status: string;
  review_notes: string | null;
  repository_id: number;
  owner: string;
  name: string;
  commit_sha: string;
  cycle_size: number;
  cycle_path: string[];
  status?: string;
}

export interface ReplayBundleRecord {
  patch_id?: number | null;
  scan_id?: number | null;
  source_target?: string | null;
  commit_sha?: string | null;
  repository?: {
    owner?: string;
    name?: string;
    local_path?: string | null;
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
  file_snapshots?: Array<{
    path: string;
    before: string;
    after: string;
  }>;
}

export interface CycleDetailCandidateRecord {
  id: number;
  cycle_id: number;
  strategy: string | null;
  planner_rank: number;
  classification: string;
  confidence: number;
  upstreamability_score: number | null;
  reasons: string[] | null;
  summary: string | null;
  score_breakdown: string[];
  signals: Record<string, unknown>;
  patch_id: number | null;
  patch: string | null;
  touched_files: string[];
  validation_status: string;
  validation_summary: string | null;
  replay: ReplayBundleRecord | null;
  review_status: string;
  review_notes: string | null;
}

export interface CycleDetailRecord {
  id: number;
  scan_id: number;
  normalized_path: string;
  participating_files: string;
  raw_payload: unknown;
  created_at: string;
  patch_id: number | null;
  cycle_path: string[];
  classification: string | null;
  confidence: number | null;
  reasons: string[] | null;
  patch: string | null;
  validation_status: string;
  validation_summary: string | null;
  replay: ReplayBundleRecord | null;
  review_status: string;
  review_notes: string | null;
  candidates: CycleDetailCandidateRecord[];
}

function toSearchParams(filters?: FindingsFilters) {
  const searchParams = new URLSearchParams();

  if (filters) {
    for (const [key, value] of Object.entries(filters)) {
      if (value === undefined || value === null || value === '' || value === 'all') {
        continue;
      }
      searchParams.append(key, String(value));
    }
  }

  return searchParams;
}

export async function fetchRepositories() {
  const response = await fetch(`${API_BASE_URL}/repositories`);
  if (!response.ok) {
    throw new Error(NETWORK_ERROR);
  }
  return response.json();
}

export async function fetchRepository(id: string) {
  const response = await fetch(`${API_BASE_URL}/repositories/${id}`);
  if (!response.ok) {
    throw new Error(NETWORK_ERROR);
  }
  return response.json();
}

export async function fetchFindings(filters?: FindingsFilters): Promise<FindingRecord[]> {
  const searchParams = toSearchParams(filters);
  const queryString = searchParams.toString();
  const url = queryString ? `${API_BASE_URL}/findings?${queryString}` : `${API_BASE_URL}/findings`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(NETWORK_ERROR);
  }
  return response.json();
}

export async function fetchRepositoryFindings(
  id: string,
  filters?: Omit<FindingsFilters, 'repository_id'>,
): Promise<FindingRecord[]> {
  return fetchFindings({
    repository_id: id,
    ...filters,
  });
}

export async function fetchCycleDetail(repoId: string, cycleId: string): Promise<CycleDetailRecord> {
  const response = await fetch(`${API_BASE_URL}/repositories/${repoId}/cycles/${cycleId}`);
  if (!response.ok) {
    throw new Error(NETWORK_ERROR);
  }
  return response.json();
}

export async function submitReviewDecision(patchId: string, decision: ReviewDecision, notes?: string) {
  const response = await fetch(`${API_BASE_URL}/patches/${patchId}/review`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ decision, notes }),
  });
  if (!response.ok) {
    throw new Error(NETWORK_ERROR);
  }
  return response.json();
}
