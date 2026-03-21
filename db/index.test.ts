import type { Database as DatabaseType } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AcceptanceBenchmarkCaseDTO,
  type BenchmarkCaseDTO,
  type CycleDTO,
  createDatabase,
  createStatements,
  addBenchmarkCase as defaultAddBenchmarkCase,
  addCycle as defaultAddCycle,
  addFixCandidate as defaultAddFixCandidate,
  addPatch as defaultAddPatch,
  addPatchReplay as defaultAddPatchReplay,
  addRepository as defaultAddRepository,
  addReviewDecision as defaultAddReviewDecision,
  addScan as defaultAddScan,
  getAcceptanceBenchmarkCaseById as defaultGetAcceptanceBenchmarkCaseById,
  getAcceptanceBenchmarkCases as defaultGetAcceptanceBenchmarkCases,
  getAcceptanceSummaryByClassification as defaultGetAcceptanceSummaryByClassification,
  getAllRepositories as defaultGetAllRepositories,
  getBenchmarkCases as defaultGetBenchmarkCases,
  getBenchmarkCasesByRepository as defaultGetBenchmarkCasesByRepository,
  getCyclesByScanId as defaultGetCyclesByScanId,
  getFixCandidatesByCycleId as defaultGetFixCandidatesByCycleId,
  getPatch as defaultGetPatch,
  getPatchesByFixCandidateId as defaultGetPatchesByFixCandidateId,
  getPatchReplayByPatchId as defaultGetPatchReplayByPatchId,
  getRepository as defaultGetRepository,
  getRepositoryByOwnerName as defaultGetRepositoryByOwnerName,
  getReviewDecisionByPatchId as defaultGetReviewDecisionByPatchId,
  getScan as defaultGetScan,
  updateAcceptanceBenchmarkReview as defaultUpdateAcceptanceBenchmarkReview,
  updateRepositoryStatus as defaultUpdateRepositoryStatus,
  updateScanStatus as defaultUpdateScanStatus,
  upsertAcceptanceBenchmarkCase as defaultUpsertAcceptanceBenchmarkCase,
  type FixCandidateDTO,
  // Default production exports
  getDb as getDefaultDb,
  initDb,
  initSchema,
  type PatchDTO,
  type PatchReplayDTO,
  type RepositoryDTO,
  type ReviewDecisionDTO,
  type ScanDTO,
} from './index.js';

// eslint-disable-next-line sonarjs/publicly-writable-directories
const TEST_LOCAL_REPO_PATH = '/tmp/openclaw';

describe('db module', () => {
  let db: DatabaseType;
  let stmts: ReturnType<typeof createStatements>;

  beforeEach(() => {
    db = createDatabase(':memory:');
    initSchema(db);
    stmts = createStatements(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('createDatabase', () => {
    it('creates an in-memory database', () => {
      const testDb = createDatabase(':memory:');
      expect(testDb).toBeDefined();
      expect(testDb.open).toBe(true);
      testDb.close();
    });
  });

  describe('initSchema', () => {
    it('creates all expected tables', () => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[];

      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain('repositories');
      expect(tableNames).toContain('scans');
      expect(tableNames).toContain('cycles');
      expect(tableNames).toContain('fix_candidates');
      expect(tableNames).toContain('patches');
      expect(tableNames).toContain('patch_replays');
      expect(tableNames).toContain('benchmark_cases');
      expect(tableNames).toContain('review_decisions');
      expect(tableNames).toContain('acceptance_benchmark_cases');
    });

    it('creates expected indexes', () => {
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name")
        .all() as { name: string }[];

      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain('idx_repositories_owner_name');
      expect(indexNames).toContain('idx_repositories_status');
      expect(indexNames).toContain('idx_scans_repository_id_commit_sha');
      expect(indexNames).toContain('idx_cycles_scan_id');
      expect(indexNames).toContain('idx_fix_candidates_cycle_id');
      expect(indexNames).toContain('idx_fix_candidates_classification');
      expect(indexNames).toContain('idx_fix_candidates_confidence');
      expect(indexNames).toContain('idx_patches_fix_candidate_id');
      expect(indexNames).toContain('idx_patch_replays_patch_id');
      expect(indexNames).toContain('idx_patch_replays_scan_id');
      expect(indexNames).toContain('idx_benchmark_cases_repository');
      expect(indexNames).toContain('idx_benchmark_cases_commit_sha');
      expect(indexNames).toContain('idx_benchmark_cases_source');
      expect(indexNames).toContain('idx_review_decisions_patch_id');
      expect(indexNames).toContain('idx_review_decisions_decision');
      expect(indexNames).toContain('idx_acceptance_benchmark_repository');
      expect(indexNames).toContain('idx_acceptance_benchmark_classification');
      expect(indexNames).toContain('idx_acceptance_benchmark_acceptability');
    });

    it('is idempotent (safe to call multiple times)', () => {
      expect(() => initSchema(db)).not.toThrow();
      expect(() => initSchema(db)).not.toThrow();
    });

    it('adds ranked-candidate columns to legacy fix_candidates tables', () => {
      const legacyDb = createDatabase(':memory:');
      legacyDb.exec(`
        CREATE TABLE fix_candidates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          cycle_id INTEGER NOT NULL,
          classification TEXT NOT NULL,
          confidence REAL NOT NULL,
          reasons TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO fix_candidates (cycle_id, classification, confidence, reasons)
        VALUES (1, 'autofix_import_type', 0.9, NULL);
      `);

      initSchema(legacyDb);

      const columns = legacyDb.prepare('PRAGMA table_info(fix_candidates)').all() as Array<{ name: string }>;
      const candidate = legacyDb
        .prepare('SELECT strategy, planner_rank, upstreamability_score FROM fix_candidates LIMIT 1')
        .get() as {
        strategy: string | null;
        planner_rank: number;
        upstreamability_score: number | null;
      };

      expect(columns.map((column) => column.name)).toEqual(
        expect.arrayContaining([
          'strategy',
          'planner_rank',
          'upstreamability_score',
          'summary',
          'score_breakdown',
          'signals',
        ]),
      );
      expect(candidate.strategy).toBe('import_type');
      expect(candidate.planner_rank).toBe(1);
      expect(candidate.upstreamability_score).toBeNull();

      legacyDb.close();
    });
  });

  describe('repositories', () => {
    it('adds and retrieves a repository', () => {
      const info = stmts.addRepository.run({
        owner: 'testowner',
        name: 'testrepo',
        default_branch: 'main',
        // eslint-disable-next-line sonarjs/publicly-writable-directories
        local_path: '/tmp/testrepo',
      });

      const repo = stmts.getRepository.get(info.lastInsertRowid) as RepositoryDTO;
      expect(repo.owner).toBe('testowner');
      expect(repo.name).toBe('testrepo');
      expect(repo.default_branch).toBe('main');
      // eslint-disable-next-line sonarjs/publicly-writable-directories
      expect(repo.local_path).toBe('/tmp/testrepo');
      expect(repo.status).toBe('queued');
      expect(repo.created_at).toBeDefined();
    });

    it('retrieves repository by owner and name', () => {
      stmts.addRepository.run({
        owner: 'org1',
        name: 'repo1',
        default_branch: null,
        local_path: null,
      });

      const repo = stmts.getRepositoryByOwnerName.get('org1', 'repo1') as RepositoryDTO;
      expect(repo.owner).toBe('org1');
      expect(repo.name).toBe('repo1');
    });

    it('returns undefined for non-existent repository', () => {
      const repo = stmts.getRepository.get(999);
      expect(repo).toBeUndefined();
    });

    it('returns undefined for non-existent owner/name combo', () => {
      const repo = stmts.getRepositoryByOwnerName.get('nonexistent', 'nope');
      expect(repo).toBeUndefined();
    });

    it('lists all repositories ordered by updated_at DESC', () => {
      stmts.addRepository.run({ owner: 'a', name: 'first', default_branch: null, local_path: null });
      stmts.addRepository.run({ owner: 'b', name: 'second', default_branch: null, local_path: null });

      const repos = stmts.getAllRepositories.all() as RepositoryDTO[];
      expect(repos).toHaveLength(2);
    });

    it('updates repository status', () => {
      const info = stmts.addRepository.run({
        owner: 'test',
        name: 'repo',
        default_branch: null,
        local_path: null,
      });

      stmts.updateRepositoryStatus.run({
        id: info.lastInsertRowid,
        status: 'scanning',
      });

      const repo = stmts.getRepository.get(info.lastInsertRowid) as RepositoryDTO;
      expect(repo.status).toBe('scanning');
    });

    it('enforces unique owner+name constraint', () => {
      stmts.addRepository.run({ owner: 'dup', name: 'repo', default_branch: null, local_path: null });
      expect(() =>
        stmts.addRepository.run({ owner: 'dup', name: 'repo', default_branch: null, local_path: null }),
      ).toThrow();
    });
  });

  describe('scans', () => {
    let repoId: number | bigint;

    beforeEach(() => {
      const info = stmts.addRepository.run({
        owner: 'scan-test',
        name: 'repo',
        default_branch: null,
        local_path: null,
      });
      repoId = info.lastInsertRowid;
    });

    it('adds and retrieves a scan', () => {
      const info = stmts.addScan.run({
        repository_id: repoId,
        commit_sha: 'abc123',
        status: 'running',
      });

      const scan = stmts.getScan.get(info.lastInsertRowid) as ScanDTO;
      expect(scan.repository_id).toBe(repoId);
      expect(scan.commit_sha).toBe('abc123');
      expect(scan.status).toBe('running');
      expect(scan.completed_at).toBeNull();
    });

    it('returns undefined for non-existent scan', () => {
      const scan = stmts.getScan.get(999);
      expect(scan).toBeUndefined();
    });

    it('updates scan status and sets completed_at for terminal statuses', () => {
      const info = stmts.addScan.run({
        repository_id: repoId,
        commit_sha: 'def456',
        status: 'running',
      });

      stmts.updateScanStatus.run({ id: info.lastInsertRowid, status: 'completed' });

      const scan = stmts.getScan.get(info.lastInsertRowid) as ScanDTO;
      expect(scan.status).toBe('completed');
      expect(scan.completed_at).not.toBeNull();
    });

    it('does not set completed_at for non-terminal statuses', () => {
      const info = stmts.addScan.run({
        repository_id: repoId,
        commit_sha: 'ghi789',
        status: 'running',
      });

      stmts.updateScanStatus.run({ id: info.lastInsertRowid, status: 'analyzing' });

      const scan = stmts.getScan.get(info.lastInsertRowid) as ScanDTO;
      expect(scan.status).toBe('analyzing');
      expect(scan.completed_at).toBeNull();
    });
  });

  describe('cycles', () => {
    let scanId: number | bigint;

    beforeEach(() => {
      const repoInfo = stmts.addRepository.run({
        owner: 'cycle-test',
        name: 'repo',
        default_branch: null,
        local_path: null,
      });
      const scanInfo = stmts.addScan.run({
        repository_id: repoInfo.lastInsertRowid,
        commit_sha: 'cycle123',
        status: 'completed',
      });
      scanId = scanInfo.lastInsertRowid;
    });

    it('adds and retrieves cycles by scan ID', () => {
      stmts.addCycle.run({
        scan_id: scanId,
        normalized_path: 'a.ts -> b.ts -> a.ts',
        participating_files: JSON.stringify(['a.ts', 'b.ts']),
        raw_payload: JSON.stringify({ violations: [] }),
      });

      const cycles = stmts.getCyclesByScanId.all(scanId) as CycleDTO[];
      expect(cycles).toHaveLength(1);
      expect(cycles[0].normalized_path).toBe('a.ts -> b.ts -> a.ts');
      expect(JSON.parse(cycles[0].participating_files)).toEqual(['a.ts', 'b.ts']);
    });

    it('returns empty array when no cycles exist for scan', () => {
      const cycles = stmts.getCyclesByScanId.all(scanId) as CycleDTO[];
      expect(cycles).toEqual([]);
    });

    it('enforces unique scan_id + normalized_path constraint', () => {
      stmts.addCycle.run({
        scan_id: scanId,
        normalized_path: 'dup-cycle',
        participating_files: '[]',
        raw_payload: null,
      });
      expect(() =>
        stmts.addCycle.run({
          scan_id: scanId,
          normalized_path: 'dup-cycle',
          participating_files: '[]',
          raw_payload: null,
        }),
      ).toThrow();
    });
  });

  describe('fix_candidates', () => {
    let cycleId: number | bigint;

    beforeEach(() => {
      const repoInfo = stmts.addRepository.run({
        owner: 'fc-test',
        name: 'repo',
        default_branch: null,
        local_path: null,
      });
      const scanInfo = stmts.addScan.run({
        repository_id: repoInfo.lastInsertRowid,
        commit_sha: 'fc123',
        status: 'completed',
      });
      const cycleInfo = stmts.addCycle.run({
        scan_id: scanInfo.lastInsertRowid,
        normalized_path: 'x.ts -> y.ts',
        participating_files: JSON.stringify(['x.ts', 'y.ts']),
        raw_payload: null,
      });
      cycleId = cycleInfo.lastInsertRowid;
    });

    it('adds and retrieves fix candidates by cycle ID', () => {
      stmts.addFixCandidate.run({
        cycle_id: cycleId,
        classification: 'autofix_extract_shared',
        confidence: 0.95,
        reasons: JSON.stringify(['safe top-level function', 'no mutable state']),
      });

      const candidates = stmts.getFixCandidatesByCycleId.all(cycleId) as FixCandidateDTO[];
      expect(candidates).toHaveLength(1);
      expect(candidates[0].classification).toBe('autofix_extract_shared');
      expect(candidates[0].confidence).toBe(0.95);
      expect(JSON.parse((candidates[0].reasons as string) || '[]')).toHaveLength(2);
    });

    it('returns empty array when no candidates exist', () => {
      const candidates = stmts.getFixCandidatesByCycleId.all(cycleId);
      expect(candidates).toEqual([]);
    });

    it('orders ranked candidates by planner rank and persists scoring metadata', () => {
      stmts.addFixCandidate.run({
        cycle_id: cycleId,
        strategy: 'extract_shared',
        planner_rank: 2,
        classification: 'autofix_extract_shared',
        confidence: 0.81,
        upstreamability_score: 0.74,
        reasons: JSON.stringify(['extract helper']),
        summary: 'Introduces a shared helper file.',
        score_breakdown: JSON.stringify(['base 0.68']),
        signals: JSON.stringify({ introducesNewFile: true }),
      });
      stmts.addFixCandidate.run({
        cycle_id: cycleId,
        strategy: 'import_type',
        planner_rank: 1,
        classification: 'autofix_import_type',
        confidence: 0.94,
        upstreamability_score: 0.95,
        reasons: JSON.stringify(['type-only edge']),
        summary: 'Converts runtime imports to import type.',
        score_breakdown: JSON.stringify(['base 0.97']),
        signals: JSON.stringify({ introducesNewFile: false }),
      });

      const candidates = stmts.getFixCandidatesByCycleId.all(cycleId) as FixCandidateDTO[];

      expect(candidates).toHaveLength(2);
      expect(candidates.map((candidate) => candidate.planner_rank)).toEqual([1, 2]);
      expect(candidates[0].strategy).toBe('import_type');
      expect(candidates[0].upstreamability_score).toBe(0.95);
      expect(candidates[0].summary).toContain('import type');
    });
  });

  describe('patches', () => {
    let fixCandidateId: number | bigint;

    beforeEach(() => {
      const repoInfo = stmts.addRepository.run({
        owner: 'patch-test',
        name: 'repo',
        default_branch: null,
        local_path: null,
      });
      const scanInfo = stmts.addScan.run({
        repository_id: repoInfo.lastInsertRowid,
        commit_sha: 'patch123',
        status: 'completed',
      });
      const cycleInfo = stmts.addCycle.run({
        scan_id: scanInfo.lastInsertRowid,
        normalized_path: 'p.ts -> q.ts',
        participating_files: '[]',
        raw_payload: null,
      });
      const fcInfo = stmts.addFixCandidate.run({
        cycle_id: cycleInfo.lastInsertRowid,
        classification: 'autofix_extract_shared',
        confidence: 0.9,
        reasons: null,
      });
      fixCandidateId = fcInfo.lastInsertRowid;
    });

    it('adds and retrieves a patch by ID', () => {
      const info = stmts.addPatch.run({
        fix_candidate_id: fixCandidateId,
        patch_text: '--- a/p.ts\n+++ b/p.ts\n@@ ...\n',
        touched_files: JSON.stringify(['p.ts', 'q.ts', 'shared.ts']),
        validation_status: 'passed',
        validation_summary: 'tsc clean, no new cycles',
      });

      const patch = stmts.getPatch.get(info.lastInsertRowid) as PatchDTO;
      expect(patch.patch_text).toContain('--- a/p.ts');
      expect(patch.validation_status).toBe('passed');
      expect(JSON.parse(patch.touched_files)).toHaveLength(3);
    });

    it('retrieves patches by fix candidate ID', () => {
      stmts.addPatch.run({
        fix_candidate_id: fixCandidateId,
        patch_text: 'patch1',
        touched_files: '[]',
        validation_status: null,
        validation_summary: null,
      });
      stmts.addPatch.run({
        fix_candidate_id: fixCandidateId,
        patch_text: 'patch2',
        touched_files: '[]',
        validation_status: 'failed',
        validation_summary: 'tsc errors',
      });

      const patches = stmts.getPatchesByFixCandidateId.all(fixCandidateId) as PatchDTO[];
      expect(patches).toHaveLength(2);
    });

    it('returns undefined for non-existent patch', () => {
      const patch = stmts.getPatch.get(999);
      expect(patch).toBeUndefined();
    });
  });

  describe('patch_replays', () => {
    let patchId: number | bigint;
    let scanId: number | bigint;

    beforeEach(() => {
      const repoInfo = stmts.addRepository.run({
        owner: 'replay-test',
        name: 'repo',
        default_branch: 'main',
        // eslint-disable-next-line sonarjs/publicly-writable-directories
        local_path: '/tmp/replay-test',
      });
      const scanInfo = stmts.addScan.run({
        repository_id: repoInfo.lastInsertRowid,
        commit_sha: 'replay123',
        status: 'completed',
      });
      scanId = scanInfo.lastInsertRowid;
      const cycleInfo = stmts.addCycle.run({
        scan_id: scanInfo.lastInsertRowid,
        normalized_path: 'r.ts -> s.ts',
        participating_files: JSON.stringify(['r.ts', 's.ts']),
        raw_payload: JSON.stringify({ type: 'circular', path: ['r.ts', 's.ts'] }),
      });
      const fcInfo = stmts.addFixCandidate.run({
        cycle_id: cycleInfo.lastInsertRowid,
        classification: 'autofix_extract_shared',
        confidence: 0.88,
        reasons: JSON.stringify(['safe to extract shared symbol']),
      });
      const patchInfo = stmts.addPatch.run({
        fix_candidate_id: fcInfo.lastInsertRowid,
        patch_text: '--- a/r.ts\n+++ b/r.ts',
        touched_files: JSON.stringify(['r.ts', 's.ts']),
        validation_status: 'passed',
        validation_summary: 'validation ok',
      });
      patchId = patchInfo.lastInsertRowid;
    });

    it('stores a replay bundle for a patch', () => {
      const info = stmts.addPatchReplay.run({
        patch_id: patchId,
        scan_id: scanId,
        source_target: 'https://github.com/example/replay.git',
        commit_sha: 'replay123',
        replay_bundle: JSON.stringify({
          scan_id: scanId,
          source_target: 'https://github.com/example/replay.git',
          commit_sha: 'replay123',
          repository: {
            owner: 'replay-test',
            name: 'repo',
            default_branch: 'main',
            // eslint-disable-next-line sonarjs/publicly-writable-directories
            local_path: '/tmp/replay-test',
          },
          cycle: {
            path: ['r.ts', 's.ts'],
            normalized_path: 'r.ts -> s.ts',
            raw_payload: { type: 'circular', path: ['r.ts', 's.ts'] },
          },
          candidate: {
            classification: 'autofix_extract_shared',
            confidence: 0.88,
            reasons: ['safe to extract shared symbol'],
          },
          validation: {
            status: 'passed',
            summary: 'validation ok',
          },
          file_snapshots: [
            {
              path: 'r.ts',
              before: 'before',
              after: 'after',
            },
          ],
          patch_text: '--- a/r.ts\n+++ b/r.ts',
        }),
      });

      const replay = stmts.getPatchReplayByPatchId.get(info.lastInsertRowid) as PatchReplayDTO;
      expect(replay.patch_id).toBe(patchId);
      expect(replay.commit_sha).toBe('replay123');
      expect(JSON.parse(replay.replay_bundle).source_target).toBe('https://github.com/example/replay.git');
    });
  });

  describe('benchmark_cases', () => {
    it('adds and retrieves benchmark cases by repository', () => {
      const info = stmts.addBenchmarkCase.run({
        repository: 'acme/widget',
        source: 'git-log',
        commit_sha: 'abc123',
        title: 'Fix circular dependency with import type',
        body: 'Converts a runtime import to type-only.',
        url: 'https://github.com/acme/widget/commit/abc123',
        pr_number: null,
        issue_number: 42,
        strategy_labels: JSON.stringify(['import_type', 'type_runtime_split']),
        validation_signals: JSON.stringify({
          matched_terms: ['import type', 'circular dependency'],
          search_terms: 14,
        }),
        diff_features: JSON.stringify({
          files_changed: 2,
          additions: 4,
          deletions: 2,
          new_files: 0,
          renamed_files: 0,
          modified_files: 2,
          binary_files: 0,
        }),
        matched_terms: JSON.stringify(['import type', 'circular dependency']),
        notes: 'Curated from git log',
      });

      const caseRow = stmts.getBenchmarkCasesByRepository.all('acme/widget') as BenchmarkCaseDTO[];
      expect(caseRow).toHaveLength(1);
      expect(caseRow[0].commit_sha).toBe('abc123');
      expect(JSON.parse(caseRow[0].strategy_labels)).toEqual(['import_type', 'type_runtime_split']);
      expect(JSON.parse(caseRow[0].matched_terms)).toContain('circular dependency');
      expect(info.changes).toBe(1);
    });

    it('returns all benchmark cases ordered by newest first', () => {
      stmts.addBenchmarkCase.run({
        repository: 'acme/widget',
        source: 'git-log',
        commit_sha: 'first',
        title: 'First',
        body: null,
        url: null,
        pr_number: null,
        issue_number: null,
        strategy_labels: '["extract_shared"]',
        validation_signals: '{}',
        diff_features: '{}',
        matched_terms: '[]',
        notes: null,
      });
      stmts.addBenchmarkCase.run({
        repository: 'acme/widget',
        source: 'git-log',
        commit_sha: 'second',
        title: 'Second',
        body: null,
        url: null,
        pr_number: null,
        issue_number: null,
        strategy_labels: '["direct_import"]',
        validation_signals: '{}',
        diff_features: '{}',
        matched_terms: '[]',
        notes: null,
      });

      const cases = stmts.getBenchmarkCases.all() as BenchmarkCaseDTO[];
      expect(cases[0].commit_sha).toBe('second');
      expect(cases[1].commit_sha).toBe('first');
    });
  });

  describe('review_decisions', () => {
    let patchId: number | bigint;

    beforeEach(() => {
      const repoInfo = stmts.addRepository.run({
        owner: 'review-test',
        name: 'repo',
        default_branch: null,
        local_path: null,
      });
      const scanInfo = stmts.addScan.run({
        repository_id: repoInfo.lastInsertRowid,
        commit_sha: 'review123',
        status: 'completed',
      });
      const cycleInfo = stmts.addCycle.run({
        scan_id: scanInfo.lastInsertRowid,
        normalized_path: 'r.ts -> s.ts',
        participating_files: '[]',
        raw_payload: null,
      });
      const fcInfo = stmts.addFixCandidate.run({
        cycle_id: cycleInfo.lastInsertRowid,
        classification: 'autofix_import_type',
        confidence: 0.8,
        reasons: null,
      });
      const patchInfo = stmts.addPatch.run({
        fix_candidate_id: fcInfo.lastInsertRowid,
        patch_text: 'diff content',
        touched_files: '[]',
        validation_status: 'passed',
        validation_summary: null,
      });
      patchId = patchInfo.lastInsertRowid;
    });

    it('adds and retrieves a review decision by patch ID', () => {
      stmts.addReviewDecision.run({
        patch_id: patchId,
        decision: 'approved',
        notes: 'Looks good to me',
      });

      const decision = stmts.getReviewDecisionByPatchId.get(patchId) as ReviewDecisionDTO;
      expect(decision.decision).toBe('approved');
      expect(decision.notes).toBe('Looks good to me');
    });

    it('updates the existing review decision for a patch', () => {
      stmts.addReviewDecision.run({
        patch_id: patchId,
        decision: 'approved',
        notes: 'Looks good to me',
      });
      stmts.addReviewDecision.run({
        patch_id: patchId,
        decision: 'rejected',
        notes: 'Needs more work',
      });

      const decisions = db
        .prepare('SELECT * FROM review_decisions WHERE patch_id = ?')
        .all(patchId) as ReviewDecisionDTO[];
      expect(decisions).toHaveLength(1);

      const decision = stmts.getReviewDecisionByPatchId.get(patchId) as ReviewDecisionDTO;
      expect(decision.decision).toBe('rejected');
      expect(decision.notes).toBe('Needs more work');
    });

    it('handles null notes', () => {
      stmts.addReviewDecision.run({
        patch_id: patchId,
        decision: 'rejected',
        notes: null,
      });

      const decision = stmts.getReviewDecisionByPatchId.get(patchId) as ReviewDecisionDTO;
      expect(decision.decision).toBe('rejected');
      expect(decision.notes).toBeNull();
    });

    it('returns undefined when no decision exists for patch', () => {
      const decision = stmts.getReviewDecisionByPatchId.get(patchId);
      expect(decision).toBeUndefined();
    });
  });

  describe('acceptance_benchmark_cases', () => {
    it('upserts and retrieves acceptance benchmark cases', () => {
      const insert = stmts.upsertAcceptanceBenchmarkCase.run({
        repository: 'openclaw/openclaw',
        local_path: TEST_LOCAL_REPO_PATH,
        commit_sha: 'abc123',
        scan_id: 1,
        cycle_id: 2,
        fix_candidate_id: 3,
        patch_id: 4,
        normalized_path: 'a.ts -> b.ts -> a.ts',
        classification: 'autofix_import_type',
        confidence: 0.91,
        upstreamability_score: 0.88,
        validation_status: 'passed',
        validation_summary: 'Cycle removed',
        review_status: 'approved',
        touched_files: '["a.ts","b.ts"]',
        feature_vector: '{"cycleSize":2}',
        planner_summary: 'Selected import_type',
        planner_attempts: '[{"strategy":"import_type"}]',
        acceptability: 'accepted',
        rejection_reason: null,
        acceptability_note: null,
      });

      const acceptanceCase = stmts.getAcceptanceBenchmarkCaseById.get(
        insert.lastInsertRowid,
      ) as AcceptanceBenchmarkCaseDTO;
      expect(acceptanceCase.repository).toBe('openclaw/openclaw');
      expect(acceptanceCase.classification).toBe('autofix_import_type');
      expect(acceptanceCase.acceptability).toBe('accepted');
      expect(acceptanceCase.feature_vector).toBe('{"cycleSize":2}');
    });

    it('updates an existing acceptance benchmark case on conflict', () => {
      stmts.upsertAcceptanceBenchmarkCase.run({
        repository: 'openclaw/openclaw',
        local_path: TEST_LOCAL_REPO_PATH,
        commit_sha: 'abc123',
        scan_id: 1,
        cycle_id: 2,
        fix_candidate_id: 3,
        patch_id: 4,
        normalized_path: 'a.ts -> b.ts -> a.ts',
        classification: 'autofix_import_type',
        confidence: 0.91,
        upstreamability_score: 0.88,
        validation_status: 'passed',
        validation_summary: 'Cycle removed',
        review_status: 'approved',
        touched_files: '["a.ts","b.ts"]',
        feature_vector: '{"cycleSize":2}',
        planner_summary: 'Selected import_type',
        planner_attempts: '[{"strategy":"import_type"}]',
        acceptability: 'accepted',
        rejection_reason: null,
        acceptability_note: null,
      });

      stmts.upsertAcceptanceBenchmarkCase.run({
        repository: 'openclaw/openclaw',
        local_path: TEST_LOCAL_REPO_PATH,
        commit_sha: 'abc123',
        scan_id: 11,
        cycle_id: 12,
        fix_candidate_id: 13,
        patch_id: 14,
        normalized_path: 'a.ts -> b.ts -> a.ts',
        classification: 'autofix_import_type',
        confidence: 0.72,
        upstreamability_score: 0.64,
        validation_status: 'failed',
        validation_summary: 'Typecheck failed',
        review_status: 'rejected',
        touched_files: '["a.ts"]',
        feature_vector: '{"cycleSize":2,"barrel":true}',
        planner_summary: 'Selected import_type after review',
        planner_attempts: '[{"strategy":"import_type","status":"candidate"}]',
        acceptability: 'rejected',
        rejection_reason: 'semantic_wrong',
        acceptability_note: 'Rejected during benchmark review',
      });

      const rows = stmts.getAcceptanceBenchmarkCases.all() as AcceptanceBenchmarkCaseDTO[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        scan_id: 11,
        cycle_id: 12,
        fix_candidate_id: 13,
        patch_id: 14,
        confidence: 0.72,
        upstreamability_score: 0.64,
        validation_status: 'failed',
        review_status: 'rejected',
        acceptability: 'rejected',
        rejection_reason: 'semantic_wrong',
        acceptability_note: 'Rejected during benchmark review',
      });
    });

    it('summarizes acceptance benchmark cases by classification', () => {
      stmts.upsertAcceptanceBenchmarkCase.run({
        repository: 'openclaw/openclaw',
        local_path: TEST_LOCAL_REPO_PATH,
        commit_sha: 'abc123',
        scan_id: 1,
        cycle_id: 2,
        fix_candidate_id: 3,
        patch_id: 4,
        normalized_path: 'a.ts -> b.ts -> a.ts',
        classification: 'autofix_import_type',
        confidence: 0.91,
        upstreamability_score: 0.88,
        validation_status: 'passed',
        validation_summary: 'Cycle removed',
        review_status: 'approved',
        touched_files: '["a.ts","b.ts"]',
        feature_vector: '{"cycleSize":2}',
        planner_summary: 'Selected import_type',
        planner_attempts: '[{"strategy":"import_type"}]',
        acceptability: 'accepted',
        rejection_reason: null,
        acceptability_note: null,
      });
      stmts.upsertAcceptanceBenchmarkCase.run({
        repository: 'openclaw/openclaw',
        local_path: TEST_LOCAL_REPO_PATH,
        commit_sha: 'def456',
        scan_id: 5,
        cycle_id: 6,
        fix_candidate_id: 7,
        patch_id: 8,
        normalized_path: 'c.ts -> d.ts -> c.ts',
        classification: 'autofix_import_type',
        confidence: 0.83,
        upstreamability_score: 0.8,
        validation_status: 'passed',
        validation_summary: 'Cycle removed',
        review_status: 'pending',
        touched_files: '["c.ts","d.ts"]',
        feature_vector: '{"cycleSize":2}',
        planner_summary: 'Selected import_type',
        planner_attempts: '[{"strategy":"import_type"}]',
        acceptability: 'needs_review',
        rejection_reason: null,
        acceptability_note: null,
      });
      stmts.upsertAcceptanceBenchmarkCase.run({
        repository: 'openclaw/openclaw',
        local_path: TEST_LOCAL_REPO_PATH,
        commit_sha: 'ghi789',
        scan_id: 9,
        cycle_id: 10,
        fix_candidate_id: 11,
        patch_id: 12,
        normalized_path: 'e.ts -> f.ts -> e.ts',
        classification: 'autofix_extract_shared',
        confidence: 0.67,
        upstreamability_score: 0.6,
        validation_status: 'failed',
        validation_summary: 'Typecheck failed',
        review_status: 'rejected',
        touched_files: '["e.ts","f.ts","shared.ts"]',
        feature_vector: '{"cycleSize":2,"introducesNewFile":true}',
        planner_summary: 'Selected extract_shared',
        planner_attempts: '[{"strategy":"extract_shared"}]',
        acceptability: 'rejected',
        rejection_reason: 'repo_conventions_mismatch',
        acceptability_note: 'Rejected by benchmark review',
      });

      const summaryRows = stmts.getAcceptanceSummaryByClassification.all() as Array<Record<string, unknown>>;
      expect(summaryRows).toEqual([
        {
          classification: 'autofix_extract_shared',
          total_cases: 1,
          accepted_cases: 0,
          rejected_cases: 1,
          needs_review_cases: 0,
        },
        {
          classification: 'autofix_import_type',
          total_cases: 2,
          accepted_cases: 1,
          rejected_cases: 0,
          needs_review_cases: 1,
        },
      ]);
    });

    it('updates review annotations for an acceptance benchmark case', () => {
      const insert = stmts.upsertAcceptanceBenchmarkCase.run({
        repository: 'openclaw/openclaw',
        local_path: TEST_LOCAL_REPO_PATH,
        commit_sha: 'abc123',
        scan_id: 1,
        cycle_id: 2,
        fix_candidate_id: 3,
        patch_id: 4,
        normalized_path: 'a.ts -> b.ts -> a.ts',
        classification: 'autofix_import_type',
        confidence: 0.91,
        upstreamability_score: 0.88,
        validation_status: 'passed',
        validation_summary: 'Cycle removed',
        review_status: 'approved',
        touched_files: '["a.ts","b.ts"]',
        feature_vector: '{"cycleSize":2}',
        planner_summary: 'Selected import_type',
        planner_attempts: '[{"strategy":"import_type"}]',
        acceptability: 'needs_review',
        rejection_reason: null,
        acceptability_note: null,
      });

      stmts.updateAcceptanceBenchmarkReview.run({
        id: insert.lastInsertRowid,
        acceptability: 'rejected',
        rejection_reason: 'validation_weak',
        acceptability_note: 'Needs repo-native validation',
      });

      const updated = stmts.getAcceptanceBenchmarkCaseById.get(insert.lastInsertRowid) as AcceptanceBenchmarkCaseDTO;
      expect(updated.acceptability).toBe('rejected');
      expect(updated.rejection_reason).toBe('validation_weak');
      expect(updated.acceptability_note).toBe('Needs repo-native validation');
    });
  });
});

describe('default production exports', () => {
  it('exports a working db instance', () => {
    const defaultDb = getDefaultDb();
    expect(defaultDb).toBeDefined();
    expect(defaultDb.open).toBe(true);
  });

  it('exports initDb function', () => {
    expect(typeof initDb).toBe('function');
    // Should not throw when called
    expect(() => initDb()).not.toThrow();
  });

  it('exports all prepared statement bindings', () => {
    expect(defaultAddRepository).toBeDefined();
    expect(defaultGetRepository).toBeDefined();
    expect(defaultGetRepositoryByOwnerName).toBeDefined();
    expect(defaultGetAllRepositories).toBeDefined();
    expect(defaultUpdateRepositoryStatus).toBeDefined();
    expect(defaultAddScan).toBeDefined();
    expect(defaultGetScan).toBeDefined();
    expect(defaultUpdateScanStatus).toBeDefined();
    expect(defaultAddCycle).toBeDefined();
    expect(defaultGetCyclesByScanId).toBeDefined();
    expect(defaultAddFixCandidate).toBeDefined();
    expect(defaultGetFixCandidatesByCycleId).toBeDefined();
    expect(defaultAddPatch).toBeDefined();
    expect(defaultGetPatch).toBeDefined();
    expect(defaultGetPatchesByFixCandidateId).toBeDefined();
    expect(defaultAddPatchReplay).toBeDefined();
    expect(defaultGetPatchReplayByPatchId).toBeDefined();
    expect(defaultAddBenchmarkCase).toBeDefined();
    expect(defaultGetBenchmarkCases).toBeDefined();
    expect(defaultGetBenchmarkCasesByRepository).toBeDefined();
    expect(defaultAddReviewDecision).toBeDefined();
    expect(defaultGetReviewDecisionByPatchId).toBeDefined();
    expect(defaultUpsertAcceptanceBenchmarkCase).toBeDefined();
    expect(defaultGetAcceptanceBenchmarkCases).toBeDefined();
    expect(defaultGetAcceptanceBenchmarkCaseById).toBeDefined();
    expect(defaultGetAcceptanceSummaryByClassification).toBeDefined();
    expect(defaultUpdateAcceptanceBenchmarkReview).toBeDefined();
  });
});
