import type { Database as DatabaseType } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CycleDTO,
  createDatabase,
  createStatements,
  addCycle as defaultAddCycle,
  addFixCandidate as defaultAddFixCandidate,
  addPatch as defaultAddPatch,
  addRepository as defaultAddRepository,
  addReviewDecision as defaultAddReviewDecision,
  addScan as defaultAddScan,
  // Default production exports
  db as defaultDb,
  getAllRepositories as defaultGetAllRepositories,
  getCyclesByScanId as defaultGetCyclesByScanId,
  getFixCandidatesByCycleId as defaultGetFixCandidatesByCycleId,
  getPatch as defaultGetPatch,
  getPatchesByFixCandidateId as defaultGetPatchesByFixCandidateId,
  getRepository as defaultGetRepository,
  getRepositoryByOwnerName as defaultGetRepositoryByOwnerName,
  getReviewDecisionByPatchId as defaultGetReviewDecisionByPatchId,
  getScan as defaultGetScan,
  updateRepositoryStatus as defaultUpdateRepositoryStatus,
  updateScanStatus as defaultUpdateScanStatus,
  type FixCandidateDTO,
  initDb,
  initSchema,
  type PatchDTO,
  type RepositoryDTO,
  type ReviewDecisionDTO,
  type ScanDTO,
} from './index.js';

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
      expect(tableNames).toContain('review_decisions');
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
      expect(indexNames).toContain('idx_review_decisions_patch_id');
      expect(indexNames).toContain('idx_review_decisions_decision');
    });

    it('is idempotent (safe to call multiple times)', () => {
      expect(() => initSchema(db)).not.toThrow();
      expect(() => initSchema(db)).not.toThrow();
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
});

describe('default production exports', () => {
  it('exports a working db instance', () => {
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
    expect(defaultAddReviewDecision).toBeDefined();
    expect(defaultGetReviewDecisionByPatchId).toBeDefined();
  });
});
