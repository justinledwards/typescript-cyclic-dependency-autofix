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

  CREATE TABLE IF NOT EXISTS review_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patch_id INTEGER NOT NULL,
    decision TEXT NOT NULL, -- approved, rejected, ignored, pr_candidate
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (patch_id) REFERENCES patches(id)
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

    // Review Decisions
    addReviewDecision: database.prepare(`
      INSERT INTO review_decisions (patch_id, decision, notes)
      VALUES (@patch_id, @decision, @notes)
    `),
    getReviewDecisionByPatchId: database.prepare(`
      SELECT * FROM review_decisions WHERE patch_id = ?
    `),
  };
}

// ─── Default production instance ──────────────────────────
// These are used by the backend and CLI directly.

export const db = createDatabase();
initSchema(db); // Must init schema before preparing statements
const stmts = createStatements(db);

export const initDb = () => initSchema(db);

// Re-export prepared statements for backward compatibility
export const addRepository = stmts.addRepository;
export const getRepository = stmts.getRepository;
export const getRepositoryByOwnerName = stmts.getRepositoryByOwnerName;
export const getAllRepositories = stmts.getAllRepositories;
export const updateRepositoryStatus = stmts.updateRepositoryStatus;
export const addScan = stmts.addScan;
export const getScan = stmts.getScan;
export const updateScanStatus = stmts.updateScanStatus;
export const addCycle = stmts.addCycle;
export const getCyclesByScanId = stmts.getCyclesByScanId;
export const addFixCandidate = stmts.addFixCandidate;
export const getFixCandidatesByCycleId = stmts.getFixCandidatesByCycleId;
export const addPatch = stmts.addPatch;
export const getPatch = stmts.getPatch;
export const getPatchesByFixCandidateId = stmts.getPatchesByFixCandidateId;
export const addReviewDecision = stmts.addReviewDecision;
export const getReviewDecisionByPatchId = stmts.getReviewDecisionByPatchId;
