// @strict: true

import path from 'node:path';
import Database, { type Database as DatabaseType } from 'better-sqlite3';

// DTOs
export interface RepositoryDTO {
  id: number;
  owner: string;
  name: string;
  default_branch: string | null;
  last_scanned_commit: string | null;
  local_path: string | null;
  last_scan_time: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface ScanDTO {
  id: number;
  repository_id: number;
  commit_sha: string;
  status: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface CycleDTO {
  id: number;
  scan_id: number;
  normalized_path: string;
  participating_files: string;
  raw_payload: string | null;
  created_at: string;
}

export interface FixCandidateDTO {
  id: number;
  cycle_id: number;
  classification: string;
  confidence: number;
  reasons: string | null;
  created_at: string;
}

export interface PatchDTO {
  id: number;
  fix_candidate_id: number;
  patch_text: string;
  touched_files: string;
  validation_status: string | null;
  validation_summary: string | null;
  created_at: string;
}

export interface PatchReplayDTO {
  id: number;
  patch_id: number;
  scan_id: number;
  source_target: string;
  commit_sha: string;
  replay_bundle: string;
  created_at: string;
}

export interface ReviewDecisionDTO {
  id: number;
  patch_id: number;
  decision: string;
  notes: string | null;
  created_at: string;
}

export type RepositoryStatus =
  | 'queued'
  | 'scanning'
  | 'analyzed'
  | 'patched'
  | 'validation_failed'
  | 'ready_for_review'
  | 'ignored';
export type Classification =
  | 'autofix_extract_shared'
  | 'autofix_direct_import'
  | 'autofix_import_type'
  | 'autofix_host_state_update'
  | 'suggest_manual'
  | 'unsupported';
export type ReviewDecision = 'approved' | 'rejected' | 'ignored' | 'pr_candidate';

// Schema definition (shared between production and test databases)
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS repositories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    default_branch TEXT,
    last_scanned_commit TEXT,
    local_path TEXT,
    last_scan_time DATETIME,
    status TEXT DEFAULT 'queued',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(owner, name)
  );

  CREATE TABLE IF NOT EXISTS scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repository_id INTEGER NOT NULL,
    commit_sha TEXT NOT NULL,
    status TEXT,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY (repository_id) REFERENCES repositories(id)
  );

  CREATE TABLE IF NOT EXISTS cycles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id INTEGER NOT NULL,
    normalized_path TEXT NOT NULL,
    participating_files TEXT NOT NULL, -- JSON string
    raw_payload TEXT, -- JSON string
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (scan_id) REFERENCES scans(id),
    UNIQUE(scan_id, normalized_path)
  );

  CREATE TABLE IF NOT EXISTS fix_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_id INTEGER NOT NULL,
    classification TEXT NOT NULL,
    confidence REAL NOT NULL,
    reasons TEXT, -- JSON string
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (cycle_id) REFERENCES cycles(id)
  );

  CREATE TABLE IF NOT EXISTS patches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fix_candidate_id INTEGER NOT NULL,
    patch_text TEXT NOT NULL,
    touched_files TEXT NOT NULL, -- JSON string
    validation_status TEXT,
    validation_summary TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (fix_candidate_id) REFERENCES fix_candidates(id)
  );

  CREATE TABLE IF NOT EXISTS patch_replays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patch_id INTEGER NOT NULL UNIQUE,
    scan_id INTEGER NOT NULL,
    source_target TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    replay_bundle TEXT NOT NULL, -- JSON string
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (patch_id) REFERENCES patches(id),
    FOREIGN KEY (scan_id) REFERENCES scans(id)
  );

  CREATE TABLE IF NOT EXISTS review_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patch_id INTEGER NOT NULL,
    decision TEXT NOT NULL, -- approved, rejected, ignored, pr_candidate
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (patch_id) REFERENCES patches(id),
    UNIQUE(patch_id)
  );

  -- Indexes
  CREATE INDEX IF NOT EXISTS idx_repositories_owner_name ON repositories(owner, name);
  CREATE INDEX IF NOT EXISTS idx_repositories_status ON repositories(status);
  CREATE INDEX IF NOT EXISTS idx_scans_repository_id_commit_sha ON scans(repository_id, commit_sha);
  CREATE INDEX IF NOT EXISTS idx_cycles_scan_id ON cycles(scan_id);
  CREATE INDEX IF NOT EXISTS idx_fix_candidates_cycle_id ON fix_candidates(cycle_id);
  CREATE INDEX IF NOT EXISTS idx_fix_candidates_classification ON fix_candidates(classification);
  CREATE INDEX IF NOT EXISTS idx_fix_candidates_confidence ON fix_candidates(confidence);
  CREATE INDEX IF NOT EXISTS idx_patches_fix_candidate_id ON patches(fix_candidate_id);
  CREATE INDEX IF NOT EXISTS idx_patch_replays_patch_id ON patch_replays(patch_id);
  CREATE INDEX IF NOT EXISTS idx_patch_replays_scan_id ON patch_replays(scan_id);
  CREATE INDEX IF NOT EXISTS idx_review_decisions_patch_id ON review_decisions(patch_id);
  CREATE INDEX IF NOT EXISTS idx_review_decisions_decision ON review_decisions(decision);
`;

/**
 * Create a database instance. Call with no arguments for production (file-based),
 * or pass ':memory:' for testing.
 */
export function createDatabase(dbPath?: string): DatabaseType {
  const resolvedPath = dbPath ?? path.join(process.cwd(), 'data.db');
  const database = new Database(resolvedPath);
  database.pragma('journal_mode = WAL');
  return database;
}

/**
 * Initialize the database schema. Safe to call multiple times (uses IF NOT EXISTS).
 */
export function initSchema(database: DatabaseType): void {
  database.exec(SCHEMA_SQL);
}

/**
 * Create all prepared statements for a given database instance.
 */
export function createStatements(database: DatabaseType) {
  return {
    // Repositories
    addRepository: database.prepare(`
      INSERT INTO repositories (owner, name, default_branch, local_path)
      VALUES (@owner, @name, @default_branch, @local_path)
    `),
    getRepository: database.prepare(`
      SELECT * FROM repositories WHERE id = ?
    `),
    getRepositoryByOwnerName: database.prepare(`
      SELECT * FROM repositories WHERE owner = ? AND name = ?
    `),
    getAllRepositories: database.prepare(`
      SELECT * FROM repositories ORDER BY updated_at DESC
    `),
    updateRepositoryStatus: database.prepare(`
      UPDATE repositories
      SET status = @status, updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `),
    updateRepositoryLocalPath: database.prepare(`
      UPDATE repositories
      SET local_path = @local_path, updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `),

    // Scans
    addScan: database.prepare(`
      INSERT INTO scans (repository_id, commit_sha, status)
      VALUES (@repository_id, @commit_sha, @status)
    `),
    getScan: database.prepare(`
      SELECT * FROM scans WHERE id = ?
    `),
    updateScanStatus: database.prepare(`
      UPDATE scans
      SET status = @status, completed_at = CASE WHEN @status IN ('completed', 'failed') THEN CURRENT_TIMESTAMP ELSE completed_at END
      WHERE id = @id
    `),

    // Cycles
    addCycle: database.prepare(`
      INSERT INTO cycles (scan_id, normalized_path, participating_files, raw_payload)
      VALUES (@scan_id, @normalized_path, @participating_files, @raw_payload)
    `),
    getCyclesByScanId: database.prepare(`
      SELECT * FROM cycles WHERE scan_id = ?
    `),

    // Fix Candidates
    addFixCandidate: database.prepare(`
      INSERT INTO fix_candidates (cycle_id, classification, confidence, reasons)
      VALUES (@cycle_id, @classification, @confidence, @reasons)
    `),
    getFixCandidatesByCycleId: database.prepare(`
      SELECT * FROM fix_candidates WHERE cycle_id = ?
    `),

    // Patches
    addPatch: database.prepare(`
      INSERT INTO patches (fix_candidate_id, patch_text, touched_files, validation_status, validation_summary)
      VALUES (@fix_candidate_id, @patch_text, @touched_files, @validation_status, @validation_summary)
    `),
    getPatch: database.prepare(`
      SELECT * FROM patches WHERE id = ?
    `),
    getPatchesByFixCandidateId: database.prepare(`
      SELECT * FROM patches WHERE fix_candidate_id = ?
    `),

    // Patch Replays
    addPatchReplay: database.prepare(`
      INSERT INTO patch_replays (patch_id, scan_id, source_target, commit_sha, replay_bundle)
      VALUES (@patch_id, @scan_id, @source_target, @commit_sha, @replay_bundle)
    `),
    getPatchReplayByPatchId: database.prepare(`
      SELECT * FROM patch_replays WHERE patch_id = ?
    `),

    // Review Decisions
    addReviewDecision: database.prepare(`
      INSERT INTO review_decisions (patch_id, decision, notes)
      VALUES (@patch_id, @decision, @notes)
      ON CONFLICT(patch_id) DO UPDATE SET
        decision = excluded.decision,
        notes = excluded.notes,
        created_at = CURRENT_TIMESTAMP
    `),
    getReviewDecisionByPatchId: database.prepare(`
      SELECT * FROM review_decisions WHERE patch_id = ?
    `),
  };
}

/* v8 ignore start */
let defaultDb: DatabaseType | null = null;
let defaultStatements: ReturnType<typeof createStatements> | null = null;

function ensureDefaultState() {
  if (!defaultDb) {
    defaultDb = createDatabase();
    initSchema(defaultDb);
    defaultStatements = createStatements(defaultDb);
  }

  return {
    db: defaultDb,
    statements: defaultStatements as ReturnType<typeof createStatements>,
  };
}

export function getDb(): DatabaseType {
  return ensureDefaultState().db;
}

export function getStatements() {
  return ensureDefaultState().statements;
}

export function initDb(): void {
  initSchema(getDb());
}

export function resetDefaultDbForTests(): void {
  if (defaultDb?.open) {
    defaultDb.close();
  }
  defaultDb = null;
  defaultStatements = null;
}

export const addRepository = {
  run: (...args: Parameters<ReturnType<typeof createStatements>['addRepository']['run']>) =>
    getStatements().addRepository.run(...args),
};
export const getRepository = {
  get: (...args: Parameters<ReturnType<typeof createStatements>['getRepository']['get']>) =>
    getStatements().getRepository.get(...args),
};
export const getRepositoryByOwnerName = {
  get: (...args: Parameters<ReturnType<typeof createStatements>['getRepositoryByOwnerName']['get']>) =>
    getStatements().getRepositoryByOwnerName.get(...args),
};
export const getAllRepositories = {
  all: (...args: Parameters<ReturnType<typeof createStatements>['getAllRepositories']['all']>) =>
    getStatements().getAllRepositories.all(...args),
};
export const updateRepositoryStatus = {
  run: (...args: Parameters<ReturnType<typeof createStatements>['updateRepositoryStatus']['run']>) =>
    getStatements().updateRepositoryStatus.run(...args),
};
export const updateRepositoryLocalPath = {
  run: (...args: Parameters<ReturnType<typeof createStatements>['updateRepositoryLocalPath']['run']>) =>
    getStatements().updateRepositoryLocalPath.run(...args),
};
export const addScan = {
  run: (...args: Parameters<ReturnType<typeof createStatements>['addScan']['run']>) =>
    getStatements().addScan.run(...args),
};
export const getScan = {
  get: (...args: Parameters<ReturnType<typeof createStatements>['getScan']['get']>) =>
    getStatements().getScan.get(...args),
};
export const updateScanStatus = {
  run: (...args: Parameters<ReturnType<typeof createStatements>['updateScanStatus']['run']>) =>
    getStatements().updateScanStatus.run(...args),
};
export const addCycle = {
  run: (...args: Parameters<ReturnType<typeof createStatements>['addCycle']['run']>) =>
    getStatements().addCycle.run(...args),
};
export const getCyclesByScanId = {
  all: (...args: Parameters<ReturnType<typeof createStatements>['getCyclesByScanId']['all']>) =>
    getStatements().getCyclesByScanId.all(...args),
};
export const addFixCandidate = {
  run: (...args: Parameters<ReturnType<typeof createStatements>['addFixCandidate']['run']>) =>
    getStatements().addFixCandidate.run(...args),
};
export const getFixCandidatesByCycleId = {
  all: (...args: Parameters<ReturnType<typeof createStatements>['getFixCandidatesByCycleId']['all']>) =>
    getStatements().getFixCandidatesByCycleId.all(...args),
};
export const addPatch = {
  run: (...args: Parameters<ReturnType<typeof createStatements>['addPatch']['run']>) =>
    getStatements().addPatch.run(...args),
};
export const getPatch = {
  get: (...args: Parameters<ReturnType<typeof createStatements>['getPatch']['get']>) =>
    getStatements().getPatch.get(...args),
};
export const getPatchesByFixCandidateId = {
  all: (...args: Parameters<ReturnType<typeof createStatements>['getPatchesByFixCandidateId']['all']>) =>
    getStatements().getPatchesByFixCandidateId.all(...args),
};
export const addPatchReplay = {
  run: (...args: Parameters<ReturnType<typeof createStatements>['addPatchReplay']['run']>) =>
    getStatements().addPatchReplay.run(...args),
};
export const getPatchReplayByPatchId = {
  get: (...args: Parameters<ReturnType<typeof createStatements>['getPatchReplayByPatchId']['get']>) =>
    getStatements().getPatchReplayByPatchId.get(...args),
};
export const addReviewDecision = {
  run: (...args: Parameters<ReturnType<typeof createStatements>['addReviewDecision']['run']>) =>
    getStatements().addReviewDecision.run(...args),
};
export const getReviewDecisionByPatchId = {
  get: (...args: Parameters<ReturnType<typeof createStatements>['getReviewDecisionByPatchId']['get']>) =>
    getStatements().getReviewDecisionByPatchId.get(...args),
};
/* v8 ignore stop */
