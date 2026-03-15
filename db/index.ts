// @strict: true
import Database, { Database as DatabaseType } from 'better-sqlite3';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

export type RepositoryStatus = 'queued' | 'scanning' | 'analyzed' | 'patched' | 'validation_failed' | 'ready_for_review' | 'ignored';
export type Classification = 'autofix_extract_shared' | 'autofix_direct_import' | 'autofix_import_type' | 'suggest_manual' | 'unsupported';
export type ReviewDecision = 'approved' | 'rejected' | 'ignored' | 'pr_candidate';

// Initialize the database
export const db: DatabaseType = new Database(join(__dirname, 'data.db'));

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Define schema
export const initDb = () => {
  db.exec(`
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
  `);
};

// Basic CRUD Operations

// Repositories
export const addRepository = db.prepare(`
  INSERT INTO repositories (owner, name, default_branch, local_path)
  VALUES (@owner, @name, @default_branch, @local_path)
`);

export const getRepository = db.prepare(`
  SELECT * FROM repositories WHERE id = ?
`);

export const getRepositoryByOwnerName = db.prepare(`
  SELECT * FROM repositories WHERE owner = ? AND name = ?
`);

export const getAllRepositories = db.prepare(`
  SELECT * FROM repositories ORDER BY updated_at DESC
`);

export const updateRepositoryStatus = db.prepare(`
  UPDATE repositories
  SET status = @status, updated_at = CURRENT_TIMESTAMP
  WHERE id = @id
`);

// Scans
export const addScan = db.prepare(`
  INSERT INTO scans (repository_id, commit_sha, status)
  VALUES (@repository_id, @commit_sha, @status)
`);

export const getScan = db.prepare(`
  SELECT * FROM scans WHERE id = ?
`);

export const updateScanStatus = db.prepare(`
  UPDATE scans
  SET status = @status, completed_at = CASE WHEN @status IN ('completed', 'failed') THEN CURRENT_TIMESTAMP ELSE completed_at END
  WHERE id = @id
`);

// Cycles
export const addCycle = db.prepare(`
  INSERT INTO cycles (scan_id, normalized_path, participating_files, raw_payload)
  VALUES (@scan_id, @normalized_path, @participating_files, @raw_payload)
`);

export const getCyclesByScanId = db.prepare(`
  SELECT * FROM cycles WHERE scan_id = ?
`);

// Fix Candidates
export const addFixCandidate = db.prepare(`
  INSERT INTO fix_candidates (cycle_id, classification, confidence, reasons)
  VALUES (@cycle_id, @classification, @confidence, @reasons)
`);

export const getFixCandidatesByCycleId = db.prepare(`
  SELECT * FROM fix_candidates WHERE cycle_id = ?
`);

// Patches
export const addPatch = db.prepare(`
  INSERT INTO patches (fix_candidate_id, patch_text, touched_files, validation_status, validation_summary)
  VALUES (@fix_candidate_id, @patch_text, @touched_files, @validation_status, @validation_summary)
`);

export const getPatch = db.prepare(`
  SELECT * FROM patches WHERE id = ?
`);

export const getPatchesByFixCandidateId = db.prepare(`
  SELECT * FROM patches WHERE fix_candidate_id = ?
`);

// Review Decisions
export const addReviewDecision = db.prepare(`
  INSERT INTO review_decisions (patch_id, decision, notes)
  VALUES (@patch_id, @decision, @notes)
`);

export const getReviewDecisionByPatchId = db.prepare(`
  SELECT * FROM review_decisions WHERE patch_id = ?
`);
