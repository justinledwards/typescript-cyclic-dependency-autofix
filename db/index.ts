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
  strategy: string | null;
  planner_rank: number;
  classification: string;
  confidence: number;
  upstreamability_score: number | null;
  reasons: string | null;
  summary: string | null;
  score_breakdown: string | null;
  signals: string | null;
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

export interface BenchmarkCaseDTO {
  id: number;
  repository: string;
  source: string;
  commit_sha: string;
  title: string;
  body: string | null;
  url: string | null;
  pr_number: number | null;
  issue_number: number | null;
  strategy_labels: string;
  validation_signals: string;
  diff_features: string;
  matched_terms: string;
  notes: string | null;
  created_at: string;
}

export interface ReviewDecisionDTO {
  id: number;
  patch_id: number;
  decision: string;
  notes: string | null;
  created_at: string;
}

export interface AcceptanceBenchmarkCaseDTO {
  id: number;
  repository: string;
  local_path: string | null;
  commit_sha: string;
  scan_id: number | null;
  cycle_id: number | null;
  fix_candidate_id: number | null;
  patch_id: number | null;
  normalized_path: string;
  classification: string;
  confidence: number;
  upstreamability_score: number | null;
  validation_status: string | null;
  validation_summary: string | null;
  review_status: string | null;
  touched_files: string | null;
  feature_vector: string;
  planner_summary: string | null;
  planner_attempts: string;
  acceptability: string | null;
  rejection_reason: string | null;
  acceptability_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface CycleObservationDTO {
  id: number;
  cycle_id: number;
  scan_id: number;
  repository_id: number;
  observation_version: number;
  normalized_path: string;
  cycle_shape: string | null;
  cycle_size: number;
  cycle_signals: string | null;
  feature_vector: string | null;
  graph_summary: string | null;
  repo_profile: string | null;
  planner_summary: string | null;
  planner_attempts: string;
  selected_strategy: string | null;
  selected_classification: string | null;
  selected_score: number | null;
  fallback_classification: string | null;
  fallback_confidence: number | null;
  fallback_reasons: string | null;
  created_at: string;
  updated_at: string;
}

export interface CandidateObservationDTO {
  id: number;
  cycle_observation_id: number;
  observation_version: number;
  fix_candidate_id: number | null;
  patch_id: number | null;
  strategy: string | null;
  status: string;
  planner_rank: number;
  promotion_eligible: number;
  summary: string | null;
  classification: string | null;
  confidence: number | null;
  upstreamability_score: number | null;
  reasons: string | null;
  score_breakdown: string | null;
  signals: string | null;
  plan: string | null;
  validation_status: string | null;
  validation_summary: string | null;
  validation_failure_category: string | null;
  created_at: string;
  updated_at: string;
}

export interface CandidateMlScoreDTO {
  id: number;
  candidate_observation_id: number;
  model_version: string;
  acceptability_score: number | null;
  validation_score: number | null;
  combined_score: number | null;
  created_at: string;
  updated_at: string;
}

export interface MlCycleRankingDTO {
  id: number;
  cycle_observation_id: number;
  model_version: string;
  heuristic_candidate_observation_id: number | null;
  model_candidate_observation_id: number | null;
  heuristic_strategy: string | null;
  model_strategy: string | null;
  disagreement: number;
  created_at: string;
  updated_at: string;
}

export type RepositoryStatus =
  | 'queued'
  | 'downloading'
  | 'scanning'
  | 'analyzed'
  | 'analysis_failed'
  | 'patched'
  | 'clone_failed'
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
export type AcceptanceBenchmarkDecision = 'accepted' | 'needs_review' | 'rejected';
export type AcceptanceBenchmarkRejectionReason =
  | 'diff_noisy'
  | 'other'
  | 'repo_conventions_mismatch'
  | 'semantic_wrong'
  | 'validation_weak';

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

  CREATE TABLE IF NOT EXISTS cycle_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_id INTEGER NOT NULL,
    scan_id INTEGER NOT NULL,
    repository_id INTEGER NOT NULL,
    observation_version INTEGER NOT NULL DEFAULT 1,
    normalized_path TEXT NOT NULL,
    cycle_shape TEXT,
    cycle_size INTEGER NOT NULL DEFAULT 0,
    cycle_signals TEXT, -- JSON string
    feature_vector TEXT, -- JSON string
    graph_summary TEXT, -- JSON string
    repo_profile TEXT, -- JSON string
    planner_summary TEXT,
    planner_attempts TEXT NOT NULL, -- JSON string
    selected_strategy TEXT,
    selected_classification TEXT,
    selected_score REAL,
    fallback_classification TEXT,
    fallback_confidence REAL,
    fallback_reasons TEXT, -- JSON string
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (cycle_id) REFERENCES cycles(id),
    FOREIGN KEY (scan_id) REFERENCES scans(id),
    FOREIGN KEY (repository_id) REFERENCES repositories(id),
    UNIQUE(cycle_id, observation_version)
  );

  CREATE TABLE IF NOT EXISTS fix_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_id INTEGER NOT NULL,
    strategy TEXT,
    planner_rank INTEGER NOT NULL DEFAULT 1,
    classification TEXT NOT NULL,
    confidence REAL NOT NULL,
    upstreamability_score REAL,
    reasons TEXT, -- JSON string
    summary TEXT,
    score_breakdown TEXT, -- JSON string
    signals TEXT, -- JSON string
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

  CREATE TABLE IF NOT EXISTS candidate_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_observation_id INTEGER NOT NULL,
    observation_version INTEGER NOT NULL DEFAULT 1,
    fix_candidate_id INTEGER,
    patch_id INTEGER,
    strategy TEXT,
    status TEXT NOT NULL,
    planner_rank INTEGER NOT NULL DEFAULT 0,
    promotion_eligible INTEGER NOT NULL DEFAULT 0,
    summary TEXT,
    classification TEXT,
    confidence REAL,
    upstreamability_score REAL,
    reasons TEXT, -- JSON string
    score_breakdown TEXT, -- JSON string
    signals TEXT, -- JSON string
    plan TEXT, -- JSON string
    validation_status TEXT,
    validation_summary TEXT,
    validation_failure_category TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (cycle_observation_id) REFERENCES cycle_observations(id),
    FOREIGN KEY (fix_candidate_id) REFERENCES fix_candidates(id),
    FOREIGN KEY (patch_id) REFERENCES patches(id)
  );

  CREATE TABLE IF NOT EXISTS benchmark_cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repository TEXT NOT NULL,
    source TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    url TEXT,
    pr_number INTEGER,
    issue_number INTEGER,
    strategy_labels TEXT NOT NULL, -- JSON string
    validation_signals TEXT NOT NULL, -- JSON string
    diff_features TEXT NOT NULL, -- JSON string
    matched_terms TEXT NOT NULL, -- JSON string
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(repository, source, commit_sha)
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

  CREATE TABLE IF NOT EXISTS acceptance_benchmark_cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repository TEXT NOT NULL,
    local_path TEXT,
    commit_sha TEXT NOT NULL,
    scan_id INTEGER,
    cycle_id INTEGER,
    fix_candidate_id INTEGER,
    patch_id INTEGER,
    normalized_path TEXT NOT NULL,
    classification TEXT NOT NULL,
    confidence REAL NOT NULL,
    upstreamability_score REAL,
    validation_status TEXT,
    validation_summary TEXT,
    review_status TEXT,
    touched_files TEXT,
    feature_vector TEXT NOT NULL,
    planner_summary TEXT,
    planner_attempts TEXT NOT NULL,
    acceptability TEXT,
    rejection_reason TEXT,
    acceptability_note TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(repository, commit_sha, normalized_path, classification)
  );

  CREATE TABLE IF NOT EXISTS candidate_ml_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_observation_id INTEGER NOT NULL,
    model_version TEXT NOT NULL,
    acceptability_score REAL,
    validation_score REAL,
    combined_score REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (candidate_observation_id) REFERENCES candidate_observations(id),
    UNIQUE(candidate_observation_id, model_version)
  );

  CREATE TABLE IF NOT EXISTS ml_cycle_rankings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_observation_id INTEGER NOT NULL,
    model_version TEXT NOT NULL,
    heuristic_candidate_observation_id INTEGER,
    model_candidate_observation_id INTEGER,
    heuristic_strategy TEXT,
    model_strategy TEXT,
    disagreement INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (cycle_observation_id) REFERENCES cycle_observations(id),
    FOREIGN KEY (heuristic_candidate_observation_id) REFERENCES candidate_observations(id),
    FOREIGN KEY (model_candidate_observation_id) REFERENCES candidate_observations(id),
    UNIQUE(cycle_observation_id, model_version)
  );

  -- Indexes
  CREATE INDEX IF NOT EXISTS idx_repositories_owner_name ON repositories(owner, name);
  CREATE INDEX IF NOT EXISTS idx_repositories_status ON repositories(status);
  CREATE INDEX IF NOT EXISTS idx_scans_repository_id_commit_sha ON scans(repository_id, commit_sha);
  CREATE INDEX IF NOT EXISTS idx_cycles_scan_id ON cycles(scan_id);
  CREATE INDEX IF NOT EXISTS idx_cycle_observations_cycle_id ON cycle_observations(cycle_id);
  CREATE INDEX IF NOT EXISTS idx_cycle_observations_repository_id ON cycle_observations(repository_id);
  CREATE INDEX IF NOT EXISTS idx_cycle_observations_selected_classification ON cycle_observations(selected_classification);
  CREATE INDEX IF NOT EXISTS idx_fix_candidates_cycle_id ON fix_candidates(cycle_id);
  CREATE INDEX IF NOT EXISTS idx_fix_candidates_classification ON fix_candidates(classification);
  CREATE INDEX IF NOT EXISTS idx_fix_candidates_confidence ON fix_candidates(confidence);
  CREATE INDEX IF NOT EXISTS idx_patches_fix_candidate_id ON patches(fix_candidate_id);
  CREATE INDEX IF NOT EXISTS idx_patch_replays_patch_id ON patch_replays(patch_id);
  CREATE INDEX IF NOT EXISTS idx_patch_replays_scan_id ON patch_replays(scan_id);
  CREATE INDEX IF NOT EXISTS idx_candidate_observations_cycle_observation_id ON candidate_observations(cycle_observation_id);
  CREATE INDEX IF NOT EXISTS idx_candidate_observations_strategy ON candidate_observations(strategy);
  CREATE INDEX IF NOT EXISTS idx_candidate_observations_status ON candidate_observations(status);
  CREATE INDEX IF NOT EXISTS idx_candidate_observations_validation_failure_category ON candidate_observations(validation_failure_category);
  CREATE INDEX IF NOT EXISTS idx_benchmark_cases_repository ON benchmark_cases(repository);
  CREATE INDEX IF NOT EXISTS idx_benchmark_cases_commit_sha ON benchmark_cases(commit_sha);
  CREATE INDEX IF NOT EXISTS idx_benchmark_cases_source ON benchmark_cases(source);
  CREATE INDEX IF NOT EXISTS idx_review_decisions_patch_id ON review_decisions(patch_id);
  CREATE INDEX IF NOT EXISTS idx_review_decisions_decision ON review_decisions(decision);
  CREATE INDEX IF NOT EXISTS idx_acceptance_benchmark_repository ON acceptance_benchmark_cases(repository);
  CREATE INDEX IF NOT EXISTS idx_acceptance_benchmark_classification ON acceptance_benchmark_cases(classification);
  CREATE INDEX IF NOT EXISTS idx_acceptance_benchmark_acceptability ON acceptance_benchmark_cases(acceptability);
  CREATE INDEX IF NOT EXISTS idx_candidate_ml_scores_model_version ON candidate_ml_scores(model_version);
  CREATE INDEX IF NOT EXISTS idx_candidate_ml_scores_candidate_observation_id ON candidate_ml_scores(candidate_observation_id);
  CREATE INDEX IF NOT EXISTS idx_ml_cycle_rankings_model_version ON ml_cycle_rankings(model_version);
  CREATE INDEX IF NOT EXISTS idx_ml_cycle_rankings_disagreement ON ml_cycle_rankings(disagreement);
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
  ensureFixCandidateSchema(database);
  ensureObservationSchema(database);
}

interface TableColumnInfo {
  name: string;
}

function ensureFixCandidateSchema(database: DatabaseType): void {
  const existingColumns = new Set(
    (database.prepare('PRAGMA table_info(fix_candidates)').all() as TableColumnInfo[]).map((column) => column.name),
  );

  const requiredColumns = [
    ['strategy', 'TEXT'],
    ['planner_rank', 'INTEGER NOT NULL DEFAULT 1'],
    ['upstreamability_score', 'REAL'],
    ['summary', 'TEXT'],
    ['score_breakdown', 'TEXT'],
    ['signals', 'TEXT'],
  ] as const;

  for (const [columnName, columnDefinition] of requiredColumns) {
    if (existingColumns.has(columnName)) {
      continue;
    }

    database.exec(`ALTER TABLE fix_candidates ADD COLUMN ${columnName} ${columnDefinition}`);
  }

  database.exec(`
    UPDATE fix_candidates
    SET planner_rank = COALESCE(planner_rank, 1)
    WHERE planner_rank IS NULL
  `);
  database.exec(`
    UPDATE fix_candidates
    SET strategy = CASE classification
      WHEN 'autofix_import_type' THEN 'import_type'
      WHEN 'autofix_direct_import' THEN 'direct_import'
      WHEN 'autofix_extract_shared' THEN 'extract_shared'
      WHEN 'autofix_host_state_update' THEN 'host_state_update'
      ELSE strategy
    END
    WHERE strategy IS NULL
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_fix_candidates_cycle_rank
    ON fix_candidates(cycle_id, planner_rank, id)
  `);
}

function ensureObservationSchema(database: DatabaseType): void {
  const cycleObservationColumns = new Set(
    (database.prepare('PRAGMA table_info(cycle_observations)').all() as TableColumnInfo[]).map((column) => column.name),
  );

  if (!cycleObservationColumns.has('graph_summary')) {
    database.exec('ALTER TABLE cycle_observations ADD COLUMN graph_summary TEXT');
  }
}

/**
 * Create all prepared statements for a given database instance.
 */
export function createStatements(database: DatabaseType) {
  const addFixCandidateStatement = database.prepare(`
    INSERT INTO fix_candidates (
      cycle_id,
      strategy,
      planner_rank,
      classification,
      confidence,
      upstreamability_score,
      reasons,
      summary,
      score_breakdown,
      signals
    )
    VALUES (
      @cycle_id,
      @strategy,
      @planner_rank,
      @classification,
      @confidence,
      @upstreamability_score,
      @reasons,
      @summary,
      @score_breakdown,
      @signals
    )
  `);
  const addCycleObservationStatement = database.prepare(`
      INSERT INTO cycle_observations (
        cycle_id,
        scan_id,
        repository_id,
        observation_version,
        normalized_path,
        cycle_shape,
        cycle_size,
        cycle_signals,
        feature_vector,
        graph_summary,
        repo_profile,
        planner_summary,
        planner_attempts,
        selected_strategy,
        selected_classification,
        selected_score,
        fallback_classification,
        fallback_confidence,
        fallback_reasons
      )
      VALUES (
        @cycle_id,
        @scan_id,
        @repository_id,
        @observation_version,
        @normalized_path,
        @cycle_shape,
        @cycle_size,
        @cycle_signals,
        @feature_vector,
        @graph_summary,
        @repo_profile,
        @planner_summary,
        @planner_attempts,
        @selected_strategy,
        @selected_classification,
        @selected_score,
        @fallback_classification,
        @fallback_confidence,
        @fallback_reasons
      )
    `);

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
    addCycleObservation: {
      run: (params: {
        cycle_id: number | bigint;
        scan_id: number | bigint;
        repository_id: number | bigint;
        observation_version: number;
        normalized_path: string;
        cycle_shape?: string | null;
        cycle_size?: number;
        cycle_signals?: string | null;
        feature_vector?: string | null;
        graph_summary?: string | null;
        repo_profile?: string | null;
        planner_summary?: string | null;
        planner_attempts: string;
        selected_strategy?: string | null;
        selected_classification?: string | null;
        selected_score?: number | null;
        fallback_classification?: string | null;
        fallback_confidence?: number | null;
        fallback_reasons?: string | null;
      }) =>
        addCycleObservationStatement.run({
          cycle_shape: null,
          cycle_size: 0,
          cycle_signals: null,
          feature_vector: null,
          graph_summary: null,
          repo_profile: null,
          planner_summary: null,
          selected_strategy: null,
          selected_classification: null,
          selected_score: null,
          fallback_classification: null,
          fallback_confidence: null,
          fallback_reasons: null,
          ...params,
        }),
    },
    getCycleObservationsByScanId: database.prepare(`
      SELECT * FROM cycle_observations WHERE scan_id = ? ORDER BY observation_version DESC, id DESC
    `),
    getLatestCycleObservationByCycleId: database.prepare(`
      SELECT * FROM cycle_observations
      WHERE cycle_id = ?
      ORDER BY observation_version DESC, id DESC
      LIMIT 1
    `),

    // Fix Candidates
    addFixCandidate: {
      run: (params: {
        cycle_id: number | bigint;
        strategy?: string | null;
        planner_rank?: number;
        classification: string;
        confidence: number;
        upstreamability_score?: number | null;
        reasons?: string | null;
        summary?: string | null;
        score_breakdown?: string | null;
        signals?: string | null;
      }) =>
        addFixCandidateStatement.run({
          strategy: null,
          planner_rank: 1,
          upstreamability_score: null,
          reasons: null,
          summary: null,
          score_breakdown: null,
          signals: null,
          ...params,
        }),
    },
    getFixCandidatesByCycleId: database.prepare(`
      SELECT * FROM fix_candidates WHERE cycle_id = ? ORDER BY planner_rank ASC, id ASC
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
    addCandidateObservation: database.prepare(`
      INSERT INTO candidate_observations (
        cycle_observation_id,
        observation_version,
        fix_candidate_id,
        patch_id,
        strategy,
        status,
        planner_rank,
        promotion_eligible,
        summary,
        classification,
        confidence,
        upstreamability_score,
        reasons,
        score_breakdown,
        signals,
        plan,
        validation_status,
        validation_summary,
        validation_failure_category
      )
      VALUES (
        @cycle_observation_id,
        @observation_version,
        @fix_candidate_id,
        @patch_id,
        @strategy,
        @status,
        @planner_rank,
        @promotion_eligible,
        @summary,
        @classification,
        @confidence,
        @upstreamability_score,
        @reasons,
        @score_breakdown,
        @signals,
        @plan,
        @validation_status,
        @validation_summary,
        @validation_failure_category
      )
    `),
    getCandidateObservationsByCycleObservationId: database.prepare(`
      SELECT * FROM candidate_observations
      WHERE cycle_observation_id = ?
      ORDER BY planner_rank ASC, id ASC
    `),

    // Patch Replays
    addPatchReplay: database.prepare(`
      INSERT INTO patch_replays (patch_id, scan_id, source_target, commit_sha, replay_bundle)
      VALUES (@patch_id, @scan_id, @source_target, @commit_sha, @replay_bundle)
    `),
    getPatchReplayByPatchId: database.prepare(`
      SELECT * FROM patch_replays WHERE patch_id = ?
    `),

    // Benchmark Cases
    addBenchmarkCase: database.prepare(`
      INSERT OR IGNORE INTO benchmark_cases (
        repository, source, commit_sha, title, body, url, pr_number, issue_number,
        strategy_labels, validation_signals, diff_features, matched_terms, notes
      )
      VALUES (
        @repository, @source, @commit_sha, @title, @body, @url, @pr_number, @issue_number,
        @strategy_labels, @validation_signals, @diff_features, @matched_terms, @notes
      )
    `),
    getBenchmarkCases: database.prepare(`
      SELECT * FROM benchmark_cases ORDER BY created_at DESC, id DESC
    `),
    getBenchmarkCasesByRepository: database.prepare(`
      SELECT * FROM benchmark_cases WHERE repository = ? ORDER BY created_at DESC, id DESC
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

    // Acceptance benchmark cases
    upsertAcceptanceBenchmarkCase: database.prepare(`
      INSERT INTO acceptance_benchmark_cases (
        repository, local_path, commit_sha, scan_id, cycle_id, fix_candidate_id, patch_id,
        normalized_path, classification, confidence, upstreamability_score, validation_status,
        validation_summary, review_status, touched_files, feature_vector, planner_summary,
        planner_attempts, acceptability, rejection_reason, acceptability_note
      )
      VALUES (
        @repository, @local_path, @commit_sha, @scan_id, @cycle_id, @fix_candidate_id, @patch_id,
        @normalized_path, @classification, @confidence, @upstreamability_score, @validation_status,
        @validation_summary, @review_status, @touched_files, @feature_vector, @planner_summary,
        @planner_attempts, @acceptability, @rejection_reason, @acceptability_note
      )
      ON CONFLICT(repository, commit_sha, normalized_path, classification) DO UPDATE SET
        local_path = excluded.local_path,
        scan_id = excluded.scan_id,
        cycle_id = excluded.cycle_id,
        fix_candidate_id = excluded.fix_candidate_id,
        patch_id = excluded.patch_id,
        confidence = excluded.confidence,
        upstreamability_score = excluded.upstreamability_score,
        validation_status = excluded.validation_status,
        validation_summary = excluded.validation_summary,
        review_status = excluded.review_status,
        touched_files = excluded.touched_files,
        feature_vector = excluded.feature_vector,
        planner_summary = excluded.planner_summary,
        planner_attempts = excluded.planner_attempts,
        acceptability = excluded.acceptability,
        rejection_reason = excluded.rejection_reason,
        acceptability_note = excluded.acceptability_note,
        updated_at = CURRENT_TIMESTAMP
    `),
    getAcceptanceBenchmarkCases: database.prepare(`
      SELECT * FROM acceptance_benchmark_cases ORDER BY updated_at DESC, id DESC
    `),
    getAcceptanceBenchmarkCaseById: database.prepare(`
      SELECT * FROM acceptance_benchmark_cases WHERE id = ?
    `),
    getAcceptanceSummaryByClassification: database.prepare(`
      SELECT
        classification,
        COUNT(*) AS total_cases,
        SUM(CASE WHEN acceptability = 'accepted' THEN 1 ELSE 0 END) AS accepted_cases,
        SUM(CASE WHEN acceptability = 'rejected' THEN 1 ELSE 0 END) AS rejected_cases,
        SUM(CASE WHEN acceptability = 'needs_review' OR acceptability IS NULL THEN 1 ELSE 0 END) AS needs_review_cases
      FROM acceptance_benchmark_cases
      GROUP BY classification
      ORDER BY classification
    `),
    updateAcceptanceBenchmarkReview: database.prepare(`
      UPDATE acceptance_benchmark_cases
      SET
        acceptability = @acceptability,
        rejection_reason = @rejection_reason,
        acceptability_note = @acceptability_note,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = @id
    `),
    upsertCandidateMlScore: database.prepare(`
      INSERT INTO candidate_ml_scores (
        candidate_observation_id,
        model_version,
        acceptability_score,
        validation_score,
        combined_score
      )
      VALUES (
        @candidate_observation_id,
        @model_version,
        @acceptability_score,
        @validation_score,
        @combined_score
      )
      ON CONFLICT(candidate_observation_id, model_version) DO UPDATE SET
        acceptability_score = excluded.acceptability_score,
        validation_score = excluded.validation_score,
        combined_score = excluded.combined_score,
        updated_at = CURRENT_TIMESTAMP
    `),
    getCandidateMlScoresByModelVersion: database.prepare(`
      SELECT * FROM candidate_ml_scores
      WHERE model_version = ?
      ORDER BY combined_score DESC, id ASC
    `),
    upsertMlCycleRanking: database.prepare(`
      INSERT INTO ml_cycle_rankings (
        cycle_observation_id,
        model_version,
        heuristic_candidate_observation_id,
        model_candidate_observation_id,
        heuristic_strategy,
        model_strategy,
        disagreement
      )
      VALUES (
        @cycle_observation_id,
        @model_version,
        @heuristic_candidate_observation_id,
        @model_candidate_observation_id,
        @heuristic_strategy,
        @model_strategy,
        @disagreement
      )
      ON CONFLICT(cycle_observation_id, model_version) DO UPDATE SET
        heuristic_candidate_observation_id = excluded.heuristic_candidate_observation_id,
        model_candidate_observation_id = excluded.model_candidate_observation_id,
        heuristic_strategy = excluded.heuristic_strategy,
        model_strategy = excluded.model_strategy,
        disagreement = excluded.disagreement,
        updated_at = CURRENT_TIMESTAMP
    `),
    getMlCycleRankingsByModelVersion: database.prepare(`
      SELECT * FROM ml_cycle_rankings
      WHERE model_version = ?
      ORDER BY disagreement DESC, id ASC
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
export const addCycleObservation = {
  run: (...args: Parameters<ReturnType<typeof createStatements>['addCycleObservation']['run']>) =>
    getStatements().addCycleObservation.run(...args),
};
export const getCycleObservationsByScanId = {
  all: (...args: Parameters<ReturnType<typeof createStatements>['getCycleObservationsByScanId']['all']>) =>
    getStatements().getCycleObservationsByScanId.all(...args),
};
export const getLatestCycleObservationByCycleId = {
  get: (...args: Parameters<ReturnType<typeof createStatements>['getLatestCycleObservationByCycleId']['get']>) =>
    getStatements().getLatestCycleObservationByCycleId.get(...args),
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
export const addCandidateObservation = {
  run: (...args: Parameters<ReturnType<typeof createStatements>['addCandidateObservation']['run']>) =>
    getStatements().addCandidateObservation.run(...args),
};
export const upsertCandidateMlScore = {
  run: (...args: Parameters<ReturnType<typeof createStatements>['upsertCandidateMlScore']['run']>) =>
    getStatements().upsertCandidateMlScore.run(...args),
};
export const getCandidateMlScoresByModelVersion = {
  all: (...args: Parameters<ReturnType<typeof createStatements>['getCandidateMlScoresByModelVersion']['all']>) =>
    getStatements().getCandidateMlScoresByModelVersion.all(...args),
};
export const upsertMlCycleRanking = {
  run: (...args: Parameters<ReturnType<typeof createStatements>['upsertMlCycleRanking']['run']>) =>
    getStatements().upsertMlCycleRanking.run(...args),
};
export const getMlCycleRankingsByModelVersion = {
  all: (...args: Parameters<ReturnType<typeof createStatements>['getMlCycleRankingsByModelVersion']['all']>) =>
    getStatements().getMlCycleRankingsByModelVersion.all(...args),
};
export const getCandidateObservationsByCycleObservationId = {
  all: (
    ...args: Parameters<ReturnType<typeof createStatements>['getCandidateObservationsByCycleObservationId']['all']>
  ) => getStatements().getCandidateObservationsByCycleObservationId.all(...args),
};
export const addPatchReplay = {
  run: (...args: Parameters<ReturnType<typeof createStatements>['addPatchReplay']['run']>) =>
    getStatements().addPatchReplay.run(...args),
};
export const getPatchReplayByPatchId = {
  get: (...args: Parameters<ReturnType<typeof createStatements>['getPatchReplayByPatchId']['get']>) =>
    getStatements().getPatchReplayByPatchId.get(...args),
};
export const addBenchmarkCase = {
  run: (...args: Parameters<ReturnType<typeof createStatements>['addBenchmarkCase']['run']>) =>
    getStatements().addBenchmarkCase.run(...args),
};
export const getBenchmarkCases = {
  all: (...args: Parameters<ReturnType<typeof createStatements>['getBenchmarkCases']['all']>) =>
    getStatements().getBenchmarkCases.all(...args),
};
export const getBenchmarkCasesByRepository = {
  all: (...args: Parameters<ReturnType<typeof createStatements>['getBenchmarkCasesByRepository']['all']>) =>
    getStatements().getBenchmarkCasesByRepository.all(...args),
};
export const addReviewDecision = {
  run: (...args: Parameters<ReturnType<typeof createStatements>['addReviewDecision']['run']>) =>
    getStatements().addReviewDecision.run(...args),
};
export const getReviewDecisionByPatchId = {
  get: (...args: Parameters<ReturnType<typeof createStatements>['getReviewDecisionByPatchId']['get']>) =>
    getStatements().getReviewDecisionByPatchId.get(...args),
};
export const upsertAcceptanceBenchmarkCase = {
  run: (...args: Parameters<ReturnType<typeof createStatements>['upsertAcceptanceBenchmarkCase']['run']>) =>
    getStatements().upsertAcceptanceBenchmarkCase.run(...args),
};
export const getAcceptanceBenchmarkCases = {
  all: (...args: Parameters<ReturnType<typeof createStatements>['getAcceptanceBenchmarkCases']['all']>) =>
    getStatements().getAcceptanceBenchmarkCases.all(...args),
};
export const getAcceptanceBenchmarkCaseById = {
  get: (...args: Parameters<ReturnType<typeof createStatements>['getAcceptanceBenchmarkCaseById']['get']>) =>
    getStatements().getAcceptanceBenchmarkCaseById.get(...args),
};
export const getAcceptanceSummaryByClassification = {
  all: (...args: Parameters<ReturnType<typeof createStatements>['getAcceptanceSummaryByClassification']['all']>) =>
    getStatements().getAcceptanceSummaryByClassification.all(...args),
};
export const updateAcceptanceBenchmarkReview = {
  run: (...args: Parameters<ReturnType<typeof createStatements>['updateAcceptanceBenchmarkReview']['run']>) =>
    getStatements().updateAcceptanceBenchmarkReview.run(...args),
};
/* v8 ignore stop */
