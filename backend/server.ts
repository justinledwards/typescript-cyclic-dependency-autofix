import cors from '@fastify/cors';
import type { Database as DatabaseType } from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  type CycleDTO,
  createStatements,
  type FixCandidateDTO,
  getDb,
  initSchema,
  type PatchDTO,
  type RepositoryDTO,
  type RepositoryStatus,
  type ReviewDecision,
  type ReviewDecisionDTO,
} from '../db/index.js';

/**
 * Build and configure the Fastify app.
 * Accepts an optional database instance for testing (defaults to the production DB).
 */
export async function buildApp(database?: DatabaseType): Promise<FastifyInstance> {
  const db = database ?? getDb();
  const stmts = createStatements(db);

  const fastify = Fastify({
    logger: !database,
  });

  // Enable CORS for frontend dev server
  await fastify.register(cors, {
    origin: ['http://localhost:3000'],
  });

  // ─── Health ───────────────────────────────────────────────

  fastify.get('/api/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // ─── Repositories ─────────────────────────────────────────

  fastify.get('/api/repositories', async () => {
    return stmts.getAllRepositories.all();
  });

  fastify.get<{ Params: { id: string } }>('/api/repositories/:id', async (request, reply) => {
    const repo = stmts.getRepository.get(Number(request.params.id)) as RepositoryDTO | undefined;
    if (!repo) {
      reply.status(404);
      return { error: 'Repository not found' };
    }
    return repo;
  });

  fastify.post<{
    Body: { owner: string; name: string; default_branch?: string; local_path?: string };
  }>('/api/repositories', async (request, reply) => {
    const { owner, name, default_branch, local_path } = request.body;
    if (!owner || !name) {
      reply.status(400);
      return { error: 'owner and name are required' };
    }

    try {
      const info = stmts.addRepository.run({
        owner,
        name,
        default_branch: default_branch ?? null,
        local_path: local_path ?? null,
      });
      reply.status(201);
      return { id: info.lastInsertRowid, owner, name };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : /* v8 ignore next */ 'Unknown error';
      fastify.log.error(error);
      reply.status(500);
      return { error: 'Failed to add repository', message };
    }
  });

  fastify.patch<{
    Params: { id: string };
    Body: { status: RepositoryStatus };
  }>('/api/repositories/:id/status', async (request, reply) => {
    const { status } = request.body;
    if (!status) {
      reply.status(400);
      return { error: 'status is required' };
    }
    stmts.updateRepositoryStatus.run({ id: Number(request.params.id), status });
    return { success: true };
  });

  // ─── Scans ────────────────────────────────────────────────

  fastify.post<{
    Params: { id: string };
    Body: { commit_sha: string };
  }>('/api/repositories/:id/scans', async (request, reply) => {
    const { commit_sha } = request.body;
    if (!commit_sha) {
      reply.status(400);
      return { error: 'commit_sha is required' };
    }

    const info = stmts.addScan.run({
      repository_id: Number(request.params.id),
      commit_sha,
      status: 'running',
    });
    reply.status(201);
    return { id: info.lastInsertRowid };
  });

  fastify.get<{ Params: { scanId: string } }>('/api/scans/:scanId', async (request, reply) => {
    const scan = stmts.getScan.get(Number(request.params.scanId));
    if (!scan) {
      reply.status(404);
      return { error: 'Scan not found' };
    }
    return scan;
  });

  // ─── Cycles ───────────────────────────────────────────────

  fastify.get<{ Params: { scanId: string } }>('/api/scans/:scanId/cycles', async (request) => {
    return stmts.getCyclesByScanId.all(Number(request.params.scanId));
  });

  // Combined findings view: cycles + fix candidates for a repository
  fastify.get<{
    Params: { id: string };
    Querystring: { status?: string };
  }>('/api/repositories/:id/findings', async (request) => {
    const repoId = Number(request.params.id);
    const statusFilter = request.query.status;

    // Get the latest scan for this repo
    const latestScan = db
      .prepare('SELECT * FROM scans WHERE repository_id = ? ORDER BY started_at DESC LIMIT 1')
      .get(repoId) as { id: number } | undefined;

    if (!latestScan) return [];

    let query = `
      SELECT
        c.id,
        c.normalized_path,
        c.participating_files,
        fc.classification,
        fc.confidence,
        rd.decision as status
      FROM cycles c
      LEFT JOIN fix_candidates fc ON fc.cycle_id = c.id
      LEFT JOIN patches p ON p.fix_candidate_id = fc.id
      LEFT JOIN review_decisions rd ON rd.patch_id = p.id
      WHERE c.scan_id = ?
    `;

    const params: unknown[] = [latestScan.id];

    if (statusFilter && statusFilter !== 'all') {
      query += " AND (rd.decision = ? OR (rd.decision IS NULL AND ? = 'pending'))";
      params.push(statusFilter, statusFilter);
    }

    query += ' ORDER BY fc.confidence DESC';

    const rows = db.prepare(query).all(...params) as Record<string, unknown>[];

    return rows.map((row) => ({
      ...row,
      cycle_path: row.participating_files ? JSON.parse(row.participating_files as string) : [],
    }));
  });

  // Cycle detail with patch
  fastify.get<{
    Params: { id: string; cycleId: string };
  }>('/api/repositories/:id/cycles/:cycleId', async (request, reply) => {
    const cycleId = Number(request.params.cycleId);

    const cycle = db.prepare('SELECT * FROM cycles WHERE id = ?').get(cycleId) as CycleDTO | undefined;
    if (!cycle) {
      reply.status(404);
      return { error: 'Cycle not found' };
    }

    const fixCandidate = db.prepare('SELECT * FROM fix_candidates WHERE cycle_id = ? LIMIT 1').get(cycleId) as
      | FixCandidateDTO
      | undefined;

    let patch: PatchDTO | undefined;
    let reviewDecision: ReviewDecisionDTO | undefined;

    if (fixCandidate) {
      patch = db.prepare('SELECT * FROM patches WHERE fix_candidate_id = ? LIMIT 1').get(fixCandidate.id) as
        | PatchDTO
        | undefined;

      if (patch) {
        reviewDecision = stmts.getReviewDecisionByPatchId.get(patch.id) as ReviewDecisionDTO | undefined;
      }
    }

    return {
      ...cycle,
      cycle_path: cycle.participating_files ? JSON.parse(cycle.participating_files) : /* v8 ignore next */ [],
      raw_payload: cycle.raw_payload ? JSON.parse(cycle.raw_payload) : /* v8 ignore next */ null,
      classification: fixCandidate?.classification ?? null,
      confidence: fixCandidate?.confidence ?? null,
      reasons: fixCandidate?.reasons ? JSON.parse(fixCandidate.reasons) : null,
      patch: patch?.patch_text ?? null,
      validation_status: patch?.validation_status ?? null,
      validation_summary: patch?.validation_summary ?? null,
      review_status: reviewDecision?.decision ?? 'pending',
    };
  });

  // ─── Review Decisions ─────────────────────────────────────

  fastify.post<{
    Params: { patchId: string };
    Body: { decision: ReviewDecision; notes?: string };
  }>('/api/patches/:patchId/review', async (request, reply) => {
    const { decision, notes } = request.body;
    if (!decision) {
      reply.status(400);
      return { error: 'decision is required' };
    }

    const validDecisions: ReviewDecision[] = ['approved', 'rejected', 'ignored', 'pr_candidate'];
    if (!validDecisions.includes(decision)) {
      reply.status(400);
      return { error: `decision must be one of: ${validDecisions.join(', ')}` };
    }

    const info = stmts.addReviewDecision.run({
      patch_id: Number(request.params.patchId),
      decision,
      notes: notes ?? null,
    });

    reply.status(201);
    return { id: info.lastInsertRowid, decision };
  });

  return fastify;
}

// ─── Start (only when run directly) ──────────────────────
// When imported as a module (e.g. from tests), the server does not start.

/* v8 ignore start */
const isMainModule = process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js');

if (isMainModule) {
  initSchema(getDb());

  const app = await buildApp();
  const port = Number(process.env.BACKEND_PORT) || 3001;
  try {
    await app.listen({ port, host: '0.0.0.0' });
    app.log.info(`Fastify backend listening on port ${port}`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}
/* v8 ignore stop */
