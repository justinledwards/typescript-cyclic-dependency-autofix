import type { Database as DatabaseType } from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, createStatements, initSchema } from '../db/index.js';
import { buildApp } from './server.js';

describe('backend API', () => {
  let app: FastifyInstance;
  let testDb: DatabaseType;

  beforeEach(async () => {
    testDb = createDatabase(':memory:');
    initSchema(testDb);
    app = await buildApp(testDb);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    testDb.close();
  });

  describe('GET /api/health', () => {
    it('returns ok status', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/health' });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toBe('ok');
      expect(body.timestamp).toBeDefined();
    });
  });

  describe('repositories', () => {
    it('GET /api/repositories returns empty list initially', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/repositories' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
    });

    it('POST /api/repositories creates a repository', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/repositories',
        payload: { owner: 'testorg', name: 'testrepo', default_branch: 'main' },
      });
      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.owner).toBe('testorg');
      expect(body.name).toBe('testrepo');
      expect(body.id).toBeDefined();
    });

    it('POST /api/repositories returns 400 when owner is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/repositories',
        payload: { name: 'testrepo' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain('required');
    });

    it('POST /api/repositories returns 400 when name is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/repositories',
        payload: { owner: 'testorg' },
      });
      expect(response.statusCode).toBe(400);
    });

    it('POST /api/repositories returns 500 on duplicate', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/repositories',
        payload: { owner: 'dup', name: 'repo' },
      });
      const response = await app.inject({
        method: 'POST',
        url: '/api/repositories',
        payload: { owner: 'dup', name: 'repo' },
      });
      expect(response.statusCode).toBe(500);
      expect(response.json().error).toBe('Failed to add repository');
    });

    it('GET /api/repositories/:id returns a repository', async () => {
      const createResponse = await app.inject({
        method: 'POST',
        url: '/api/repositories',
        payload: { owner: 'get-test', name: 'repo' },
      });
      const { id } = createResponse.json();

      const response = await app.inject({ method: 'GET', url: `/api/repositories/${id}` });
      expect(response.statusCode).toBe(200);
      expect(response.json().owner).toBe('get-test');
    });

    it('GET /api/repositories/:id returns 404 for non-existent', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/repositories/999' });
      expect(response.statusCode).toBe(404);
    });

    it('PATCH /api/repositories/:id/status updates status', async () => {
      const createResponse = await app.inject({
        method: 'POST',
        url: '/api/repositories',
        payload: { owner: 'status-test', name: 'repo' },
      });
      const { id } = createResponse.json();

      const response = await app.inject({
        method: 'PATCH',
        url: `/api/repositories/${id}/status`,
        payload: { status: 'scanning' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().success).toBe(true);

      const getResponse = await app.inject({ method: 'GET', url: `/api/repositories/${id}` });
      expect(getResponse.json().status).toBe('scanning');
    });

    it('PATCH /api/repositories/:id/status returns 400 when status is missing', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/repositories/1/status',
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('scans', () => {
    let repoId: number;

    beforeEach(async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/repositories',
        payload: { owner: 'scan-test', name: 'repo' },
      });
      repoId = response.json().id;
    });

    it('POST /api/repositories/:id/scans creates a scan', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/repositories/${repoId}/scans`,
        payload: { commit_sha: 'abc123' },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().id).toBeDefined();
    });

    it('POST /api/repositories/:id/scans returns 400 without commit_sha', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/api/repositories/${repoId}/scans`,
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });

    it('GET /api/scans/:scanId returns a scan', async () => {
      const createResponse = await app.inject({
        method: 'POST',
        url: `/api/repositories/${repoId}/scans`,
        payload: { commit_sha: 'def456' },
      });
      const { id } = createResponse.json();

      const response = await app.inject({ method: 'GET', url: `/api/scans/${id}` });
      expect(response.statusCode).toBe(200);
      expect(response.json().commit_sha).toBe('def456');
    });

    it('GET /api/scans/:scanId returns 404 for non-existent', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/scans/999' });
      expect(response.statusCode).toBe(404);
    });

    it('GET /api/scans/:scanId/cycles returns cycles for a scan', async () => {
      const scanResponse = await app.inject({
        method: 'POST',
        url: `/api/repositories/${repoId}/scans`,
        payload: { commit_sha: 'ghi789' },
      });
      const scanId = scanResponse.json().id;

      const response = await app.inject({ method: 'GET', url: `/api/scans/${scanId}/cycles` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
    });
  });

  describe('findings', () => {
    it('GET /api/repositories/:id/findings returns empty when no scans', async () => {
      const repoResponse = await app.inject({
        method: 'POST',
        url: '/api/repositories',
        payload: { owner: 'findings-test', name: 'repo' },
      });
      const repoId = repoResponse.json().id;

      const response = await app.inject({ method: 'GET', url: `/api/repositories/${repoId}/findings` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
    });

    it('GET /api/repositories/:id/findings returns cycles with classifications', async () => {
      const stmts = createStatements(testDb);
      const repoInfo = stmts.addRepository.run({
        owner: 'f-test',
        name: 'repo',
        default_branch: null,
        local_path: null,
      });
      const scanInfo = stmts.addScan.run({
        repository_id: repoInfo.lastInsertRowid,
        commit_sha: 'f1',
        status: 'completed',
      });
      const cycleInfo = stmts.addCycle.run({
        scan_id: scanInfo.lastInsertRowid,
        normalized_path: 'a->b',
        participating_files: JSON.stringify(['a.ts', 'b.ts']),
        raw_payload: null,
      });
      stmts.addFixCandidate.run({
        cycle_id: cycleInfo.lastInsertRowid,
        classification: 'autofix_extract_shared',
        confidence: 0.95,
        reasons: null,
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/repositories/${repoInfo.lastInsertRowid}/findings`,
      });
      expect(response.statusCode).toBe(200);
      const findings = response.json();
      expect(findings).toHaveLength(1);
      expect(findings[0].classification).toBe('autofix_extract_shared');
      expect(findings[0].cycle_path).toEqual(['a.ts', 'b.ts']);
    });

    it('GET /api/repositories/:id/findings filters by status', async () => {
      const stmts = createStatements(testDb);
      const repoInfo = stmts.addRepository.run({
        owner: 'filter-test',
        name: 'repo',
        default_branch: null,
        local_path: null,
      });
      const scanInfo = stmts.addScan.run({
        repository_id: repoInfo.lastInsertRowid,
        commit_sha: 'filter1',
        status: 'completed',
      });
      stmts.addCycle.run({
        scan_id: scanInfo.lastInsertRowid,
        normalized_path: 'x->y',
        participating_files: '[]',
        raw_payload: null,
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/repositories/${repoInfo.lastInsertRowid}/findings?status=pending`,
      });
      expect(response.statusCode).toBe(200);
    });
  });

  describe('cycle detail', () => {
    it('GET /api/repositories/:id/cycles/:cycleId returns cycle detail', async () => {
      const stmts = createStatements(testDb);
      const repoInfo = stmts.addRepository.run({
        owner: 'detail-test',
        name: 'repo',
        default_branch: null,
        local_path: null,
      });
      const scanInfo = stmts.addScan.run({
        repository_id: repoInfo.lastInsertRowid,
        commit_sha: 'd1',
        status: 'completed',
      });
      const cycleInfo = stmts.addCycle.run({
        scan_id: scanInfo.lastInsertRowid,
        normalized_path: 'm->n',
        participating_files: JSON.stringify(['m.ts', 'n.ts']),
        raw_payload: null,
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/repositories/${repoInfo.lastInsertRowid}/cycles/${cycleInfo.lastInsertRowid}`,
      });
      expect(response.statusCode).toBe(200);
      const detail = response.json();
      expect(detail.cycle_path).toEqual(['m.ts', 'n.ts']);
      expect(detail.classification).toBeNull();
      expect(detail.patch).toBeNull();
    });

    it('GET /api/repositories/:id/cycles/:cycleId returns full detail with fix candidate and patch', async () => {
      const stmts = createStatements(testDb);
      const repoInfo = stmts.addRepository.run({
        owner: 'full-detail',
        name: 'repo',
        default_branch: null,
        local_path: null,
      });
      const scanInfo = stmts.addScan.run({
        repository_id: repoInfo.lastInsertRowid,
        commit_sha: 'full1',
        status: 'completed',
      });
      const cycleInfo = stmts.addCycle.run({
        scan_id: scanInfo.lastInsertRowid,
        normalized_path: 'p->q',
        participating_files: JSON.stringify(['p.ts', 'q.ts']),
        raw_payload: null,
      });
      const fcInfo = stmts.addFixCandidate.run({
        cycle_id: cycleInfo.lastInsertRowid,
        classification: 'autofix_import_type',
        confidence: 0.85,
        reasons: JSON.stringify(['type-only import']),
      });
      const patchInfo = stmts.addPatch.run({
        fix_candidate_id: fcInfo.lastInsertRowid,
        patch_text: '--- a/p.ts\n+++ b/p.ts',
        touched_files: '["p.ts"]',
        validation_status: 'passed',
        validation_summary: 'clean',
      });
      stmts.addReviewDecision.run({
        patch_id: patchInfo.lastInsertRowid,
        decision: 'approved',
        notes: 'LGTM',
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/repositories/${repoInfo.lastInsertRowid}/cycles/${cycleInfo.lastInsertRowid}`,
      });
      expect(response.statusCode).toBe(200);
      const detail = response.json();
      expect(detail.classification).toBe('autofix_import_type');
      expect(detail.confidence).toBe(0.85);
      expect(detail.reasons).toEqual(['type-only import']);
      expect(detail.patch).toContain('--- a/p.ts');
      expect(detail.review_status).toBe('approved');
    });

    it('GET /api/repositories/:id/cycles/:cycleId returns 404 for non-existent cycle', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/repositories/1/cycles/999',
      });
      expect(response.statusCode).toBe(404);
    });

    it('GET /api/repositories/:id/cycles/:cycleId returns detail with fix candidate but no patch', async () => {
      const stmts = createStatements(testDb);
      const repoInfo = stmts.addRepository.run({
        owner: 'fc-nopatch',
        name: 'repo',
        default_branch: null,
        local_path: null,
      });
      const scanInfo = stmts.addScan.run({
        repository_id: repoInfo.lastInsertRowid,
        commit_sha: 'np1',
        status: 'completed',
      });
      const cycleInfo = stmts.addCycle.run({
        scan_id: scanInfo.lastInsertRowid,
        normalized_path: 'np->nq',
        participating_files: JSON.stringify(['np.ts', 'nq.ts']),
        raw_payload: null,
      });
      stmts.addFixCandidate.run({
        cycle_id: cycleInfo.lastInsertRowid,
        classification: 'suggest_manual',
        confidence: 0.4,
        reasons: null,
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/repositories/${repoInfo.lastInsertRowid}/cycles/${cycleInfo.lastInsertRowid}`,
      });
      expect(response.statusCode).toBe(200);
      const detail = response.json();
      expect(detail.classification).toBe('suggest_manual');
      expect(detail.reasons).toBeNull();
      expect(detail.patch).toBeNull();
      expect(detail.review_status).toBe('pending');
    });

    it('GET /api/repositories/:id/cycles/:cycleId returns detail with patch but no review', async () => {
      const stmts = createStatements(testDb);
      const repoInfo = stmts.addRepository.run({
        owner: 'patch-noreview',
        name: 'repo',
        default_branch: null,
        local_path: null,
      });
      const scanInfo = stmts.addScan.run({
        repository_id: repoInfo.lastInsertRowid,
        commit_sha: 'pnr1',
        status: 'completed',
      });
      const cycleInfo = stmts.addCycle.run({
        scan_id: scanInfo.lastInsertRowid,
        normalized_path: 'pnr->q',
        participating_files: JSON.stringify(['pnr.ts']),
        raw_payload: null,
      });
      const fcInfo = stmts.addFixCandidate.run({
        cycle_id: cycleInfo.lastInsertRowid,
        classification: 'autofix_extract_shared',
        confidence: 0.9,
        reasons: JSON.stringify(['safe']),
      });
      stmts.addPatch.run({
        fix_candidate_id: fcInfo.lastInsertRowid,
        patch_text: 'some diff',
        touched_files: '["pnr.ts"]',
        validation_status: 'passed',
        validation_summary: null,
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/repositories/${repoInfo.lastInsertRowid}/cycles/${cycleInfo.lastInsertRowid}`,
      });
      expect(response.statusCode).toBe(200);
      const detail = response.json();
      expect(detail.patch).toBe('some diff');
      expect(detail.review_status).toBe('pending');
    });
  });

  describe('review decisions', () => {
    it('POST /api/patches/:patchId/review creates a decision', async () => {
      const stmts = createStatements(testDb);
      const repoInfo = stmts.addRepository.run({ owner: 'rev', name: 'repo', default_branch: null, local_path: null });
      const scanInfo = stmts.addScan.run({
        repository_id: repoInfo.lastInsertRowid,
        commit_sha: 'rev1',
        status: 'completed',
      });
      const cycleInfo = stmts.addCycle.run({
        scan_id: scanInfo.lastInsertRowid,
        normalized_path: 'a->b',
        participating_files: '[]',
        raw_payload: null,
      });
      const fcInfo = stmts.addFixCandidate.run({
        cycle_id: cycleInfo.lastInsertRowid,
        classification: 'autofix_extract_shared',
        confidence: 0.9,
        reasons: null,
      });
      const patchInfo = stmts.addPatch.run({
        fix_candidate_id: fcInfo.lastInsertRowid,
        patch_text: 'diff',
        touched_files: '[]',
        validation_status: 'passed',
        validation_summary: null,
      });

      const response = await app.inject({
        method: 'POST',
        url: `/api/patches/${patchInfo.lastInsertRowid}/review`,
        payload: { decision: 'approved', notes: 'LGTM' },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().decision).toBe('approved');
    });

    it('POST /api/patches/:patchId/review returns 400 without decision', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/patches/1/review',
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });

    it('POST /api/patches/:patchId/review returns 400 for invalid decision', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/patches/1/review',
        payload: { decision: 'invalid_option' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain('must be one of');
    });

    it('POST /api/patches/:patchId/review creates a decision without notes', async () => {
      const stmts = createStatements(testDb);
      const repoInfo = stmts.addRepository.run({
        owner: 'rev-nonotes',
        name: 'repo',
        default_branch: null,
        local_path: null,
      });
      const scanInfo = stmts.addScan.run({
        repository_id: repoInfo.lastInsertRowid,
        commit_sha: 'rev2',
        status: 'completed',
      });
      const cycleInfo = stmts.addCycle.run({
        scan_id: scanInfo.lastInsertRowid,
        normalized_path: 'nn->b',
        participating_files: '[]',
        raw_payload: null,
      });
      const fcInfo = stmts.addFixCandidate.run({
        cycle_id: cycleInfo.lastInsertRowid,
        classification: 'autofix_extract_shared',
        confidence: 0.9,
        reasons: null,
      });
      const patchInfo = stmts.addPatch.run({
        fix_candidate_id: fcInfo.lastInsertRowid,
        patch_text: 'diff',
        touched_files: '[]',
        validation_status: 'passed',
        validation_summary: null,
      });

      const response = await app.inject({
        method: 'POST',
        url: `/api/patches/${patchInfo.lastInsertRowid}/review`,
        payload: { decision: 'rejected' },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().decision).toBe('rejected');
    });
  });

  describe('findings edge cases', () => {
    it('GET /api/repositories/:id/findings with status=all does not filter', async () => {
      const stmts = createStatements(testDb);
      const repoInfo = stmts.addRepository.run({
        owner: 'all-test',
        name: 'repo',
        default_branch: null,
        local_path: null,
      });
      const scanInfo = stmts.addScan.run({
        repository_id: repoInfo.lastInsertRowid,
        commit_sha: 'all1',
        status: 'completed',
      });
      stmts.addCycle.run({
        scan_id: scanInfo.lastInsertRowid,
        normalized_path: 'all->b',
        participating_files: JSON.stringify(['all.ts']),
        raw_payload: null,
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/repositories/${repoInfo.lastInsertRowid}/findings?status=all`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toHaveLength(1);
    });

    it('GET /api/repositories/:id/findings handles null participating_files', async () => {
      const stmts = createStatements(testDb);
      const repoInfo = stmts.addRepository.run({
        owner: 'null-pf-test',
        name: 'repo',
        default_branch: null,
        local_path: null,
      });
      const scanInfo = stmts.addScan.run({
        repository_id: repoInfo.lastInsertRowid,
        commit_sha: 'npf1',
        status: 'completed',
      });
      // Insert a cycle directly with a valid but empty participating_files
      testDb
        .prepare('INSERT INTO cycles (scan_id, normalized_path, participating_files) VALUES (?, ?, ?)')
        .run(scanInfo.lastInsertRowid, 'npf->b', '');

      const response = await app.inject({
        method: 'GET',
        url: `/api/repositories/${repoInfo.lastInsertRowid}/findings`,
      });
      expect(response.statusCode).toBe(200);
    });
  });

  describe('buildApp with default database', () => {
    it('builds app without explicit database argument', async () => {
      const defaultApp = await buildApp();
      await defaultApp.ready();
      const response = await defaultApp.inject({ method: 'GET', url: '/api/health' });
      expect(response.statusCode).toBe(200);
      await defaultApp.close();
    });
  });
});
