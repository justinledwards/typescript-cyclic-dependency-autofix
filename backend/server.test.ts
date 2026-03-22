import path from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, createStatements, initSchema } from '../db/index.js';
import { buildApp } from './server.js';

const fixtureRoot = path.join(process.cwd(), '.test-fixtures');
const replayDetailPath = path.join(fixtureRoot, 'replay-detail');

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

    it('GET /api/repositories/:id/findings only returns the primary ranked candidate', async () => {
      const stmts = createStatements(testDb);
      const repoInfo = stmts.addRepository.run({
        owner: 'ranked-findings',
        name: 'repo',
        default_branch: null,
        local_path: null,
      });
      const scanInfo = stmts.addScan.run({
        repository_id: repoInfo.lastInsertRowid,
        commit_sha: 'ranked1',
        status: 'completed',
      });
      const cycleInfo = stmts.addCycle.run({
        scan_id: scanInfo.lastInsertRowid,
        normalized_path: 'a.ts -> b.ts -> a.ts',
        participating_files: JSON.stringify(['a.ts', 'b.ts', 'a.ts']),
        raw_payload: null,
      });
      stmts.addFixCandidate.run({
        cycle_id: cycleInfo.lastInsertRowid,
        strategy: 'extract_shared',
        planner_rank: 2,
        classification: 'autofix_extract_shared',
        confidence: 0.82,
        reasons: JSON.stringify(['secondary']),
      });
      stmts.addFixCandidate.run({
        cycle_id: cycleInfo.lastInsertRowid,
        strategy: 'import_type',
        planner_rank: 1,
        classification: 'autofix_import_type',
        confidence: 0.94,
        reasons: JSON.stringify(['primary']),
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/repositories/${repoInfo.lastInsertRowid}/findings`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([
        expect.objectContaining({
          classification: 'autofix_import_type',
          confidence: 0.94,
        }),
      ]);
    });

    it('GET /api/findings filters by repository, classification, validation, review, cycle size, and search', async () => {
      const stmts = createStatements(testDb);
      const repoInfo = stmts.addRepository.run({
        owner: 'acme',
        name: 'widget',
        default_branch: null,
        local_path: null,
      });
      const scanInfo = stmts.addScan.run({
        repository_id: repoInfo.lastInsertRowid,
        commit_sha: 'queue1',
        status: 'completed',
      });
      const matchingCycle = stmts.addCycle.run({
        scan_id: scanInfo.lastInsertRowid,
        normalized_path: 'a.ts -> b.ts -> a.ts',
        participating_files: JSON.stringify(['a.ts', 'b.ts']),
        raw_payload: null,
      });
      const matchingCandidate = stmts.addFixCandidate.run({
        cycle_id: matchingCycle.lastInsertRowid,
        classification: 'autofix_extract_shared',
        confidence: 0.98,
        reasons: JSON.stringify(['safe top-level function']),
      });
      const matchingPatch = stmts.addPatch.run({
        fix_candidate_id: matchingCandidate.lastInsertRowid,
        patch_text: '--- a.ts\n+++ b.ts',
        touched_files: JSON.stringify(['a.ts', 'b.ts']),
        validation_status: 'passed',
        validation_summary: 'Validation passed.',
      });
      stmts.addReviewDecision.run({
        patch_id: matchingPatch.lastInsertRowid,
        decision: 'approved',
        notes: 'Ship it',
      });

      stmts.addCycle.run({
        scan_id: scanInfo.lastInsertRowid,
        normalized_path: 'x.ts -> y.ts -> x.ts',
        participating_files: JSON.stringify(['x.ts', 'y.ts', 'x.ts']),
        raw_payload: null,
      });
      const otherCycle = stmts.addCycle.run({
        scan_id: scanInfo.lastInsertRowid,
        normalized_path: 'm.ts -> n.ts -> m.ts',
        participating_files: JSON.stringify(['m.ts', 'n.ts', 'm.ts']),
        raw_payload: null,
      });
      const otherCandidate = stmts.addFixCandidate.run({
        cycle_id: otherCycle.lastInsertRowid,
        classification: 'autofix_import_type',
        confidence: 0.74,
        reasons: null,
      });
      const otherPatch = stmts.addPatch.run({
        fix_candidate_id: otherCandidate.lastInsertRowid,
        patch_text: 'other diff',
        touched_files: JSON.stringify(['m.ts', 'n.ts']),
        validation_status: 'failed',
        validation_summary: 'TypeScript check failed.',
      });
      stmts.addReviewDecision.run({
        patch_id: otherPatch.lastInsertRowid,
        decision: 'pr_candidate',
        notes: null,
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/findings?repository_id=${repoInfo.lastInsertRowid}&classification=autofix_extract_shared&validation_status=passed&review_status=approved&cycle_size=2&search=acme/widget`,
      });
      expect(response.statusCode).toBe(200);
      const findings = response.json();
      expect(findings).toHaveLength(1);
      expect(findings[0].repository_id).toBe(repoInfo.lastInsertRowid);
      expect(findings[0].classification).toBe('autofix_extract_shared');
      expect(findings[0].validation_status).toBe('passed');
      expect(findings[0].review_status).toBe('approved');
      expect(findings[0].cycle_size).toBe(2);
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
        raw_payload: JSON.stringify({ violations: [] }),
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
      expect(detail.patch_id).toBeDefined();
      expect(detail.review_status).toBe('approved');
      expect(detail.candidates).toHaveLength(1);
    });

    it('GET /api/repositories/:id/cycles/:cycleId returns ranked candidate alternatives', async () => {
      const stmts = createStatements(testDb);
      const repoInfo = stmts.addRepository.run({
        owner: 'candidate-detail',
        name: 'repo',
        default_branch: null,
        local_path: null,
      });
      const scanInfo = stmts.addScan.run({
        repository_id: repoInfo.lastInsertRowid,
        commit_sha: 'candidate1',
        status: 'completed',
      });
      const cycleInfo = stmts.addCycle.run({
        scan_id: scanInfo.lastInsertRowid,
        normalized_path: 'a.ts -> b.ts -> a.ts',
        participating_files: JSON.stringify(['a.ts', 'b.ts', 'a.ts']),
        raw_payload: JSON.stringify({
          analysis: {
            planner: {
              selectionSummary: 'Selected import_type after ranking two candidates.',
            },
          },
        }),
      });
      const primaryCandidate = stmts.addFixCandidate.run({
        cycle_id: cycleInfo.lastInsertRowid,
        strategy: 'import_type',
        planner_rank: 1,
        classification: 'autofix_import_type',
        confidence: 0.93,
        upstreamability_score: 0.96,
        reasons: JSON.stringify(['primary']),
        summary: 'Most upstreamable option.',
        score_breakdown: JSON.stringify(['base 0.97']),
        signals: JSON.stringify({ introducesNewFile: false }),
      });
      const secondaryCandidate = stmts.addFixCandidate.run({
        cycle_id: cycleInfo.lastInsertRowid,
        strategy: 'extract_shared',
        planner_rank: 2,
        classification: 'autofix_extract_shared',
        confidence: 0.81,
        upstreamability_score: 0.76,
        reasons: JSON.stringify(['secondary']),
        summary: 'Fallback shared extraction.',
        score_breakdown: JSON.stringify(['base 0.68']),
        signals: JSON.stringify({ introducesNewFile: true }),
      });
      const secondaryPatch = stmts.addPatch.run({
        fix_candidate_id: secondaryCandidate.lastInsertRowid,
        patch_text: '--- a/a.ts\n+++ b/a.ts',
        touched_files: JSON.stringify(['a.ts', 'helper.shared.ts']),
        validation_status: 'failed',
        validation_summary: 'Introduced a new cycle.',
      });
      stmts.addReviewDecision.run({
        patch_id: secondaryPatch.lastInsertRowid,
        decision: 'rejected',
        notes: 'Too invasive',
      });
      const primaryPatch = stmts.addPatch.run({
        fix_candidate_id: primaryCandidate.lastInsertRowid,
        patch_text: '--- a/a.ts\n+++ b/a.ts',
        touched_files: JSON.stringify(['a.ts']),
        validation_status: 'passed',
        validation_summary: 'Validation passed.',
      });
      stmts.addReviewDecision.run({
        patch_id: primaryPatch.lastInsertRowid,
        decision: 'approved',
        notes: 'Ship it',
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/repositories/${repoInfo.lastInsertRowid}/cycles/${cycleInfo.lastInsertRowid}`,
      });

      expect(response.statusCode).toBe(200);
      const detail = response.json();
      expect(detail.classification).toBe('autofix_import_type');
      expect(detail.candidates).toHaveLength(2);
      expect(detail.candidates.map((candidate: { planner_rank: number }) => candidate.planner_rank)).toEqual([1, 2]);
      expect(detail.candidates[0]).toEqual(
        expect.objectContaining({
          classification: 'autofix_import_type',
          upstreamability_score: 0.96,
          patch_id: primaryPatch.lastInsertRowid,
          review_status: 'approved',
        }),
      );
      expect(detail.candidates[1]).toEqual(
        expect.objectContaining({
          classification: 'autofix_extract_shared',
          patch_id: secondaryPatch.lastInsertRowid,
          validation_status: 'failed',
          review_status: 'rejected',
        }),
      );
    });

    it('GET /api/repositories/:id/cycles/:cycleId returns replay provenance when available', async () => {
      const stmts = createStatements(testDb);
      const repoInfo = stmts.addRepository.run({
        owner: 'replay-detail',
        name: 'repo',
        default_branch: 'main',
        local_path: replayDetailPath,
      });
      const scanInfo = stmts.addScan.run({
        repository_id: repoInfo.lastInsertRowid,
        commit_sha: 'replay1',
        status: 'completed',
      });
      const cycleInfo = stmts.addCycle.run({
        scan_id: scanInfo.lastInsertRowid,
        normalized_path: 'x->y',
        participating_files: JSON.stringify(['x.ts', 'y.ts']),
        raw_payload: JSON.stringify({ violations: [] }),
      });
      const fcInfo = stmts.addFixCandidate.run({
        cycle_id: cycleInfo.lastInsertRowid,
        classification: 'autofix_extract_shared',
        confidence: 0.91,
        reasons: JSON.stringify(['safe']),
      });
      const patchInfo = stmts.addPatch.run({
        fix_candidate_id: fcInfo.lastInsertRowid,
        patch_text: '--- a/x.ts\n+++ b/x.ts',
        touched_files: '["x.ts"]',
        validation_status: 'passed',
        validation_summary: 'clean',
      });
      stmts.addPatchReplay.run({
        patch_id: patchInfo.lastInsertRowid,
        scan_id: scanInfo.lastInsertRowid,
        source_target: replayDetailPath,
        commit_sha: 'replay1',
        replay_bundle: JSON.stringify({
          scan_id: scanInfo.lastInsertRowid,
          source_target: replayDetailPath,
          commit_sha: 'replay1',
          repository: {
            owner: 'replay-detail',
            name: 'repo',
            default_branch: 'main',
            local_path: replayDetailPath,
          },
          cycle: {
            path: ['x.ts', 'y.ts'],
            normalized_path: 'x -> y',
            raw_payload: { violations: [] },
          },
          candidate: {
            classification: 'autofix_extract_shared',
            confidence: 0.91,
            reasons: ['safe'],
          },
          validation: {
            status: 'passed',
            summary: 'clean',
          },
          file_snapshots: [
            {
              path: 'x.ts',
              before: 'before',
              after: 'after',
            },
          ],
          patch_text: '--- a/x.ts\n+++ b/x.ts',
        }),
      });

      const response = await app.inject({
        method: 'GET',
        url: `/api/repositories/${repoInfo.lastInsertRowid}/cycles/${cycleInfo.lastInsertRowid}`,
      });
      expect(response.statusCode).toBe(200);
      const detail = response.json();
      expect(detail.replay.source_target).toBe(replayDetailPath);
      expect(detail.replay.commit_sha).toBe('replay1');
      expect(detail.replay.validation.summary).toBe('clean');
      expect(detail.replay.file_snapshots).toHaveLength(1);
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

  describe('reports', () => {
    it('GET /api/reports/patterns returns aggregated observation data', async () => {
      const stmts = createStatements(testDb);
      const repoInfo = stmts.addRepository.run({
        owner: 'patterns',
        name: 'repo',
        default_branch: null,
        local_path: replayDetailPath,
      });
      const scanInfo = stmts.addScan.run({
        repository_id: repoInfo.lastInsertRowid,
        commit_sha: 'pattern123',
        status: 'completed',
      });
      const cycleInfo = stmts.addCycle.run({
        scan_id: scanInfo.lastInsertRowid,
        normalized_path: 'a.ts -> b.ts -> a.ts',
        participating_files: JSON.stringify(['a.ts', 'b.ts', 'a.ts']),
        raw_payload: null,
      });
      const observationInfo = stmts.addCycleObservation.run({
        cycle_id: cycleInfo.lastInsertRowid,
        scan_id: scanInfo.lastInsertRowid,
        repository_id: repoInfo.lastInsertRowid,
        observation_version: 1,
        normalized_path: 'a.ts -> b.ts -> a.ts',
        cycle_shape: 'two_file',
        cycle_size: 2,
        cycle_signals: '{"explicitImportEdges":2}',
        feature_vector:
          '{"hasBarrelFile":true,"hasSharedModuleFile":false,"packageManager":"pnpm","workspaceMode":"workspace"}',
        repo_profile: '{"packageManager":"pnpm","workspaceMode":"workspace","validationCommandCount":2}',
        planner_summary: 'No strategy cleared the safety filters.',
        planner_attempts: '[]',
        selected_strategy: null,
        selected_classification: 'unsupported',
        selected_score: null,
        fallback_classification: 'unsupported',
        fallback_confidence: 1,
        fallback_reasons: '["Only two-file cycles are supported for autofix in v1."]',
      });
      stmts.addCandidateObservation.run({
        cycle_observation_id: observationInfo.lastInsertRowid,
        observation_version: 1,
        fix_candidate_id: null,
        patch_id: null,
        strategy: 'extract_shared',
        status: 'rejected',
        planner_rank: 0,
        promotion_eligible: 0,
        summary: 'No safe extraction found',
        classification: null,
        confidence: null,
        upstreamability_score: null,
        reasons: '["Imported symbols rely on runtime state."]',
        score_breakdown: null,
        signals: '{"loadedFiles":2}',
        plan: null,
        validation_status: null,
        validation_summary: null,
        validation_failure_category: 'original_cycle_persisted',
      });

      const response = await app.inject({ method: 'GET', url: '/api/reports/patterns' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        summary: {
          cycleObservations: 1,
          candidateObservations: 1,
        },
      });
      expect(response.json().unsupportedClusters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            classification: 'unsupported',
            cycleShape: 'two_file',
            count: 1,
          }),
        ]),
      );
    });

    it('GET /api/reports/strategy-performance returns profile and acceptance summaries', async () => {
      const stmts = createStatements(testDb);
      const repoInfo = stmts.addRepository.run({
        owner: 'strategy',
        name: 'repo',
        default_branch: null,
        local_path: replayDetailPath,
      });
      const scanInfo = stmts.addScan.run({
        repository_id: repoInfo.lastInsertRowid,
        commit_sha: 'strategy123',
        status: 'completed',
      });
      const cycleInfo = stmts.addCycle.run({
        scan_id: scanInfo.lastInsertRowid,
        normalized_path: 'c.ts -> d.ts -> c.ts',
        participating_files: JSON.stringify(['c.ts', 'd.ts', 'c.ts']),
        raw_payload: null,
      });
      const observationInfo = stmts.addCycleObservation.run({
        cycle_id: cycleInfo.lastInsertRowid,
        scan_id: scanInfo.lastInsertRowid,
        repository_id: repoInfo.lastInsertRowid,
        observation_version: 1,
        normalized_path: 'c.ts -> d.ts -> c.ts',
        cycle_shape: 'two_file',
        cycle_size: 2,
        cycle_signals: '{"explicitImportEdges":2}',
        feature_vector: '{"packageManager":"pnpm","workspaceMode":"workspace"}',
        repo_profile: '{"packageManager":"pnpm","workspaceMode":"workspace","validationCommandCount":2}',
        planner_summary: 'Selected import_type',
        planner_attempts: '[]',
        selected_strategy: 'import_type',
        selected_classification: 'autofix_import_type',
        selected_score: 0.93,
        fallback_classification: 'autofix_import_type',
        fallback_confidence: 0.9,
        fallback_reasons: '[]',
      });
      const fixCandidateInfo = stmts.addFixCandidate.run({
        cycle_id: cycleInfo.lastInsertRowid,
        strategy: 'import_type',
        planner_rank: 1,
        classification: 'autofix_import_type',
        confidence: 0.9,
        upstreamability_score: 0.93,
        reasons: '["Convert imports to type-only"]',
        summary: 'Convert imports to type-only',
        score_breakdown: '["base 0.97"]',
        signals: '{"touchedFiles":1}',
      });
      const patchInfo = stmts.addPatch.run({
        fix_candidate_id: fixCandidateInfo.lastInsertRowid,
        patch_text: 'diff',
        touched_files: '["c.ts"]',
        validation_status: 'passed',
        validation_summary: 'Cycle removed',
      });
      stmts.addCandidateObservation.run({
        cycle_observation_id: observationInfo.lastInsertRowid,
        observation_version: 1,
        fix_candidate_id: fixCandidateInfo.lastInsertRowid,
        patch_id: patchInfo.lastInsertRowid,
        strategy: 'import_type',
        status: 'candidate',
        planner_rank: 1,
        promotion_eligible: 1,
        summary: 'Convert imports to type-only',
        classification: 'autofix_import_type',
        confidence: 0.9,
        upstreamability_score: 0.93,
        reasons: '["Convert imports to type-only"]',
        score_breakdown: '["base 0.97"]',
        signals: '{"touchedFiles":1}',
        plan: '{"kind":"import_type"}',
        validation_status: 'passed',
        validation_summary: 'Cycle removed',
        validation_failure_category: null,
      });
      stmts.addReviewDecision.run({
        patch_id: patchInfo.lastInsertRowid,
        decision: 'approved',
        notes: null,
      });
      stmts.upsertAcceptanceBenchmarkCase.run({
        repository: 'strategy/repo',
        local_path: replayDetailPath,
        commit_sha: 'strategy123',
        scan_id: scanInfo.lastInsertRowid as number,
        cycle_id: cycleInfo.lastInsertRowid as number,
        fix_candidate_id: fixCandidateInfo.lastInsertRowid as number,
        patch_id: patchInfo.lastInsertRowid as number,
        normalized_path: 'c.ts -> d.ts -> c.ts',
        classification: 'autofix_import_type',
        confidence: 0.9,
        upstreamability_score: 0.93,
        validation_status: 'passed',
        validation_summary: 'Cycle removed',
        review_status: 'approved',
        touched_files: '["c.ts"]',
        feature_vector: '{"cycleSize":2}',
        planner_summary: 'Selected import_type',
        planner_attempts: '[{"strategy":"import_type","status":"candidate"}]',
        acceptability: 'accepted',
        rejection_reason: null,
        acceptability_note: null,
      });

      const response = await app.inject({ method: 'GET', url: '/api/reports/strategy-performance' });
      expect(response.statusCode).toBe(200);
      expect(response.json().byRepositoryProfile).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            strategy: 'import_type',
            packageManager: 'pnpm',
            workspaceMode: 'workspace',
            attempts: 1,
            approvedReviews: 1,
            passedValidations: 1,
          }),
        ]),
      );
      expect(response.json().acceptanceByStrategy).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            strategy: 'import_type',
            classification: 'autofix_import_type',
            totalCases: 1,
            acceptedCases: 1,
            acceptanceRate: 1,
          }),
        ]),
      );
    });

    it('GET /api/reports/unsupported-clusters returns recurrent manual buckets', async () => {
      const stmts = createStatements(testDb);
      const repoInfo = stmts.addRepository.run({
        owner: 'unsupported',
        name: 'repo',
        default_branch: null,
        local_path: replayDetailPath,
      });
      const scanInfo = stmts.addScan.run({
        repository_id: repoInfo.lastInsertRowid,
        commit_sha: 'unsupported123',
        status: 'completed',
      });
      const cycleInfo = stmts.addCycle.run({
        scan_id: scanInfo.lastInsertRowid,
        normalized_path: 'e.ts -> f.ts -> g.ts -> e.ts',
        participating_files: JSON.stringify(['e.ts', 'f.ts', 'g.ts', 'e.ts']),
        raw_payload: null,
      });
      stmts.addCycleObservation.run({
        cycle_id: cycleInfo.lastInsertRowid,
        scan_id: scanInfo.lastInsertRowid,
        repository_id: repoInfo.lastInsertRowid,
        observation_version: 1,
        normalized_path: 'e.ts -> f.ts -> g.ts -> e.ts',
        cycle_shape: 'multi_file',
        cycle_size: 3,
        cycle_signals: '{"explicitImportEdges":3}',
        feature_vector: '{"hasBarrelFile":false,"packageManager":"npm","workspaceMode":"single-package"}',
        repo_profile: '{"packageManager":"npm","workspaceMode":"single-package","validationCommandCount":1}',
        planner_summary: 'No strategy cleared the safety filters.',
        planner_attempts: '[]',
        selected_strategy: null,
        selected_classification: 'suggest_manual',
        selected_score: null,
        fallback_classification: 'suggest_manual',
        fallback_confidence: 0.6,
        fallback_reasons:
          '["Barrel re-export graph is ambiguous or side-effectful, so a direct-import rewrite is not safe."]',
      });

      const response = await app.inject({ method: 'GET', url: '/api/reports/unsupported-clusters' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            classification: 'suggest_manual',
            cycleShape: 'multi_file',
            cycleSize: 3,
            count: 1,
          }),
        ]),
      );
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

    it('POST /api/patches/:patchId/review updates the latest review decision', async () => {
      const stmts = createStatements(testDb);
      const repoInfo = stmts.addRepository.run({
        owner: 'rev-update',
        name: 'repo',
        default_branch: null,
        local_path: null,
      });
      const scanInfo = stmts.addScan.run({
        repository_id: repoInfo.lastInsertRowid,
        commit_sha: 'rev3',
        status: 'completed',
      });
      const cycleInfo = stmts.addCycle.run({
        scan_id: scanInfo.lastInsertRowid,
        normalized_path: 'u->v',
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

      await app.inject({
        method: 'POST',
        url: `/api/patches/${patchInfo.lastInsertRowid}/review`,
        payload: { decision: 'approved' },
      });

      const updateResponse = await app.inject({
        method: 'POST',
        url: `/api/patches/${patchInfo.lastInsertRowid}/review`,
        payload: { decision: 'rejected', notes: 'Needs more work' },
      });
      expect(updateResponse.statusCode).toBe(201);

      const detailResponse = await app.inject({
        method: 'GET',
        url: `/api/repositories/${repoInfo.lastInsertRowid}/cycles/${cycleInfo.lastInsertRowid}`,
      });
      expect(detailResponse.statusCode).toBe(200);
      expect(detailResponse.json().review_status).toBe('rejected');
      expect(detailResponse.json().review_notes).toBe('Needs more work');
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
