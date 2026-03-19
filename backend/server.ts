import cors from '@fastify/cors';
import type { Database as DatabaseType } from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  type CycleDTO,
  createStatements,
  type FixCandidateDTO,
  getDb,
  initSchema,
  type PatchReplayDTO,
  type PatchDTO,
  type RepositoryDTO,
  type RepositoryStatus,
  type ReviewDecision,
  type ReviewDecisionDTO,
} from '../db/index.js';

interface FindingsFilters {
  repositoryId?: number;
  classification?: string;
  validationStatus?: string;
  reviewStatus?: string;
  cycleSize?: number;
  search?: string;
}

interface FindingsQueryRow {
  cycle_id: number;
  scan_id: number;
  normalized_path: string;
  participating_files: string;
  raw_payload: string | null;
  fix_candidate_id: number | null;
  classification: string | null;
  confidence: number | null;
  reasons: string | null;
  patch_id: number | null;
  patch_text: string | null;
  validation_status: string | null;
  validation_summary: string | null;
  review_status: string | null;
  review_notes: string | null;
  repository_id: number;
  owner: string;
  name: string;
  commit_sha: string;
  cycle_size: number;
}

function parseJsonArray(value: string | null): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseJsonValue<T>(value: string | null, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function parseReplayBundle(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function toOptionalNumber(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function buildFindingsQuery(filters: FindingsFilters): { query: string; params: unknown[] } {
  const queryParts = [
    `
    SELECT
      c.id AS cycle_id,
      c.scan_id,
      c.normalized_path,
      c.participating_files,
      c.raw_payload,
      fc.id AS fix_candidate_id,
      fc.classification,
      fc.confidence,
      fc.reasons,
      p.id AS patch_id,
      p.patch_text,
      p.validation_status,
      p.validation_summary,
      rd.decision AS review_status,
      rd.notes AS review_notes,
      r.id AS repository_id,
      r.owner,
      r.name,
      s.commit_sha,
      CASE
        WHEN json_valid(c.participating_files) THEN json_array_length(c.participating_files)
        ELSE 0
      END AS cycle_size
    FROM cycles c
    INNER JOIN scans s ON s.id = c.scan_id
    INNER JOIN repositories r ON r.id = s.repository_id
    LEFT JOIN fix_candidates fc ON fc.cycle_id = c.id
    LEFT JOIN patches p ON p.fix_candidate_id = fc.id
    LEFT JOIN review_decisions rd ON rd.id = (
      SELECT id
      FROM review_decisions
      WHERE patch_id = p.id
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    )
    WHERE 1 = 1
      AND c.scan_id = (
        SELECT id
        FROM scans
        WHERE repository_id = r.id
        ORDER BY started_at DESC, id DESC
        LIMIT 1
      )
  `,
  ];

  const params: unknown[] = [];

  appendRepositoryFilter(queryParts, params, filters.repositoryId);
  appendSearchFilter(queryParts, params, filters.search);
  appendClassificationFilter(queryParts, params, filters.classification);
  appendValidationStatusFilter(queryParts, params, filters.validationStatus);
  appendReviewStatusFilter(queryParts, params, filters.reviewStatus);
  appendCycleSizeFilter(queryParts, params, filters.cycleSize);

  queryParts.push(`
    ORDER BY COALESCE(fc.confidence, 0) DESC, r.owner ASC, r.name ASC, c.id ASC
  `);

  return { query: queryParts.join(''), params };
}

function appendRepositoryFilter(query: string[], params: unknown[], repositoryId?: number): void {
  if (repositoryId === undefined) {
    return;
  }

  query.push(' AND r.id = ?');
  params.push(repositoryId);
}

function appendSearchFilter(query: string[], params: unknown[], search?: string): void {
  const trimmedSearch = search?.trim();
  if (!trimmedSearch) {
    return;
  }

  query.push(" AND LOWER(r.owner || '/' || r.name || ' ' || c.normalized_path) LIKE ?");
  params.push(`%${trimmedSearch.toLowerCase()}%`);
}

function appendClassificationFilter(query: string[], params: unknown[], classification?: string): void {
  if (!classification || classification === 'all') {
    return;
  }

  if (classification === 'unclassified') {
    query.push(' AND fc.id IS NULL');
    return;
  }

  query.push(' AND fc.classification = ?');
  params.push(classification);
}

function appendValidationStatusFilter(query: string[], params: unknown[], validationStatus?: string): void {
  if (!validationStatus || validationStatus === 'all') {
    return;
  }

  if (validationStatus === 'pending') {
    query.push(' AND p.validation_status IS NULL');
    return;
  }

  query.push(' AND p.validation_status = ?');
  params.push(validationStatus);
}

function appendReviewStatusFilter(query: string[], params: unknown[], reviewStatus?: string): void {
  if (!reviewStatus || reviewStatus === 'all') {
    return;
  }

  if (reviewStatus === 'pending') {
    query.push(' AND rd.decision IS NULL');
    return;
  }

  query.push(' AND rd.decision = ?');
  params.push(reviewStatus);
}

function appendCycleSizeFilter(query: string[], params: unknown[], cycleSize?: number): void {
  if (cycleSize === undefined) {
    return;
  }

  query.push(`
    AND CASE
      WHEN json_valid(c.participating_files) THEN json_array_length(c.participating_files)
      ELSE 0
    END = ?
  `);
  params.push(cycleSize);
}

function mapFindingRows(rows: FindingsQueryRow[]) {
  return rows.map((row) => ({
    ...row,
    cycle_path: parseJsonArray(row.participating_files),
    raw_payload: parseJsonValue(row.raw_payload, null),
    reasons: parseJsonValue(row.reasons, null),
    validation_status: row.validation_status ?? 'pending',
    review_status: row.review_status ?? 'pending',
    status: row.review_status ?? 'pending',
  }));
}

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

  fastify.get<{
    Querystring: {
      repository_id?: string;
      search?: string;
      classification?: string;
      validation_status?: string;
      review_status?: string;
      cycle_size?: string;
    };
  }>('/api/findings', async (request) => {
    const { query, params } = buildFindingsQuery({
      repositoryId: toOptionalNumber(request.query.repository_id),
      search: request.query.search,
      classification: request.query.classification,
      validationStatus: request.query.validation_status,
      reviewStatus: request.query.review_status,
      cycleSize: toOptionalNumber(request.query.cycle_size),
    });

    const rows = db.prepare(query).all(...params) as FindingsQueryRow[];
    return mapFindingRows(rows);
  });

  // Combined findings view: cycles + fix candidates for a repository
  fastify.get<{
    Params: { id: string };
    Querystring: {
      search?: string;
      classification?: string;
      validation_status?: string;
      review_status?: string;
      cycle_size?: string;
    };
  }>('/api/repositories/:id/findings', async (request) => {
    const { query, params } = buildFindingsQuery({
      repositoryId: toOptionalNumber(request.params.id),
      search: request.query.search,
      classification: request.query.classification,
      validationStatus: request.query.validation_status,
      reviewStatus: request.query.review_status,
      cycleSize: toOptionalNumber(request.query.cycle_size),
    });

    const rows = db.prepare(query).all(...params) as FindingsQueryRow[];
    return mapFindingRows(rows);
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
    let patchReplay: PatchReplayDTO | undefined;
    let reviewDecision: ReviewDecisionDTO | undefined;

    if (fixCandidate) {
      patch = db.prepare('SELECT * FROM patches WHERE fix_candidate_id = ? LIMIT 1').get(fixCandidate.id) as
        | PatchDTO
        | undefined;

      if (patch) {
        patchReplay = db.prepare('SELECT * FROM patch_replays WHERE patch_id = ? LIMIT 1').get(patch.id) as
          | PatchReplayDTO
          | undefined;
        reviewDecision = stmts.getReviewDecisionByPatchId.get(patch.id) as ReviewDecisionDTO | undefined;
      }
    }

    const replay = patchReplay ? parseReplayBundle(patchReplay.replay_bundle) : null;

    return {
      ...cycle,
      patch_id: patch?.id ?? null,
      cycle_path: parseJsonArray(cycle.participating_files),
      raw_payload: parseJsonValue(cycle.raw_payload, null),
      classification: fixCandidate?.classification ?? null,
      confidence: fixCandidate?.confidence ?? null,
      reasons: parseJsonValue(fixCandidate?.reasons ?? null, null),
      patch: patch?.patch_text ?? null,
      validation_status: patch?.validation_status ?? null,
      validation_summary: patch?.validation_summary ?? null,
      replay: replay
        ? {
            patch_id: patchReplay?.patch_id ?? null,
            scan_id: patchReplay?.scan_id ?? null,
            source_target: patchReplay?.source_target ?? null,
            commit_sha: patchReplay?.commit_sha ?? null,
            ...replay,
          }
        : null,
      review_status: reviewDecision?.decision ?? 'pending',
      review_notes: reviewDecision?.notes ?? null,
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
