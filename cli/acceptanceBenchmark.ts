import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';
import simpleGit from 'simple-git';
import type { BenchmarkCorpusEntry } from '../benchmarks/repo-corpus.js';
import { BENCHMARK_REPO_CORPUS } from '../benchmarks/repo-corpus.js';
import {
  type AcceptanceBenchmarkCaseDTO,
  type AcceptanceBenchmarkDecision,
  type AcceptanceBenchmarkRejectionReason,
  createStatements,
  getDb,
} from '../db/index.js';
import {
  defaultWorkspaceDir,
  findLocalCheckout,
  normalizeSearchRoots,
  selectCorpusEntries,
} from './benchmarkCorpus.js';
import { scanRepository } from './scanner.js';

export interface AcceptanceBenchmarkOptions {
  database?: DatabaseType;
  entries?: BenchmarkCorpusEntry[];
  onlyRepositories?: string[];
  searchRoots?: string[];
  workspaceDir?: string;
  cloneMissing?: boolean;
  limit?: number;
  scanWorktreesDir?: string;
  dependencies?: AcceptanceBenchmarkDependencies;
}

export interface AcceptanceBenchmarkDependencies {
  findLocalCheckout?: typeof findLocalCheckout;
  cloneRepository?: typeof cloneCorpusRepository;
  scanRepository?: typeof scanRepository;
}

export interface AcceptanceBenchmarkRepositoryResult {
  slug: string;
  repoPath: string | null;
  status: 'benchmarked' | 'cloned' | 'skipped';
  scanId?: number;
  cyclesFound?: number;
  benchmarkedCases?: number;
  reason?: string;
}

export interface AcceptanceBenchmarkSummaryRow {
  classification: string;
  totalCases: number;
  acceptedCases: number;
  rejectedCases: number;
  needsReviewCases: number;
  acceptanceRate: number;
}

export interface AcceptanceBenchmarkResult {
  corpusSize: number;
  repositoriesBenchmarked: number;
  repositoriesCloned: number;
  repositoriesSkipped: number;
  totalCycles: number;
  totalAcceptanceCases: number;
  workspaceDir: string;
  searchRoots: string[];
  repositoryResults: AcceptanceBenchmarkRepositoryResult[];
  acceptanceSummary: AcceptanceBenchmarkSummaryRow[];
}

export interface AcceptanceBenchmarkAnnotation {
  acceptability: AcceptanceBenchmarkDecision;
  rejectionReason?: AcceptanceBenchmarkRejectionReason;
  note?: string;
}

interface AcceptanceSnapshotRow {
  commit_sha: string;
  cycle_id: number;
  normalized_path: string;
  raw_payload: string | null;
  fix_candidate_id: number | null;
  classification: string | null;
  confidence: number | null;
  patch_id: number | null;
  validation_status: string | null;
  validation_summary: string | null;
  touched_files: string | null;
  review_status: string;
}

interface AcceptanceBenchmarkSummaryQueryRow {
  classification?: string;
  total_cases?: number;
  accepted_cases?: number;
  rejected_cases?: number;
  needs_review_cases?: number;
}

interface AcceptanceRawPayload {
  analysis?: {
    classification?: string;
    confidence?: number;
    upstreamabilityScore?: number | null;
    planner?: {
      features?: Record<string, unknown>;
      selectionSummary?: string;
      attempts?: unknown[];
    };
  };
}

export async function runAcceptanceBenchmark(
  options: AcceptanceBenchmarkOptions = {},
): Promise<AcceptanceBenchmarkResult> {
  const database = options.database ?? getDb();
  const statements = createStatements(database);
  const localCheckoutResolver = options.dependencies?.findLocalCheckout ?? findLocalCheckout;
  const cloneRepo = options.dependencies?.cloneRepository ?? cloneCorpusRepository;
  const scanRepo = options.dependencies?.scanRepository ?? scanRepository;
  const entries = selectCorpusEntries(
    options.entries ?? BENCHMARK_REPO_CORPUS,
    options.onlyRepositories,
    options.limit,
  );
  const workspaceDir = options.workspaceDir ? path.resolve(options.workspaceDir) : defaultWorkspaceDir();
  const searchRoots = dedupePaths([...normalizeSearchRoots(options.searchRoots), workspaceDir]);
  const scanWorktreesDir = options.scanWorktreesDir
    ? path.resolve(options.scanWorktreesDir)
    : path.join(workspaceDir, 'scan-worktrees');

  const repositoryResults: AcceptanceBenchmarkRepositoryResult[] = [];
  let repositoriesBenchmarked = 0;
  let repositoriesCloned = 0;
  let repositoriesSkipped = 0;
  let totalCycles = 0;
  let totalAcceptanceCases = 0;

  for (const entry of entries) {
    let repoPath = localCheckoutResolver(entry, searchRoots);
    let status: AcceptanceBenchmarkRepositoryResult['status'] = 'benchmarked';

    if (!repoPath) {
      if (!options.cloneMissing) {
        repositoriesSkipped += 1;
        repositoryResults.push({
          slug: entry.slug,
          repoPath: null,
          status: 'skipped',
          reason: 'No local checkout matched the configured search roots',
        });
        continue;
      }

      try {
        repoPath = await cloneRepo(entry, workspaceDir);
        repositoriesCloned += 1;
        status = 'cloned';
      } catch (error) {
        repositoriesSkipped += 1;
        repositoryResults.push({
          slug: entry.slug,
          repoPath: null,
          status: 'skipped',
          reason: stringifyError(error),
        });
        continue;
      }
    }

    try {
      const scan = await scanRepo(repoPath, scanWorktreesDir);
      const benchmarkedCases = snapshotAcceptanceBenchmark(database, entry.slug, repoPath, scan.scanId);
      repositoriesBenchmarked += 1;
      totalCycles += scan.cyclesFound;
      totalAcceptanceCases += benchmarkedCases;
      repositoryResults.push({
        slug: entry.slug,
        repoPath,
        status,
        scanId: scan.scanId,
        cyclesFound: scan.cyclesFound,
        benchmarkedCases,
      });
    } catch (error) {
      repositoriesSkipped += 1;
      repositoryResults.push({
        slug: entry.slug,
        repoPath,
        status: 'skipped',
        reason: stringifyError(error),
      });
    }
  }

  return {
    corpusSize: entries.length,
    repositoriesBenchmarked,
    repositoriesCloned,
    repositoriesSkipped,
    totalCycles,
    totalAcceptanceCases,
    workspaceDir,
    searchRoots,
    repositoryResults,
    acceptanceSummary: buildAcceptanceSummary(
      statements.getAcceptanceSummaryByClassification.all() as AcceptanceBenchmarkSummaryQueryRow[],
    ),
  };
}

export function getAcceptanceBenchmarkReport(database: DatabaseType = getDb()): {
  totalCases: number;
  cases: AcceptanceBenchmarkCaseDTO[];
  summary: AcceptanceBenchmarkSummaryRow[];
} {
  const statements = createStatements(database);
  const cases = statements.getAcceptanceBenchmarkCases.all() as AcceptanceBenchmarkCaseDTO[];
  const summaryRows = statements.getAcceptanceSummaryByClassification.all() as AcceptanceBenchmarkSummaryQueryRow[];

  return {
    totalCases: cases.length,
    cases,
    summary: buildAcceptanceSummary(summaryRows),
  };
}

export function annotateAcceptanceBenchmarkCase(
  id: number,
  annotation: AcceptanceBenchmarkAnnotation,
  database: DatabaseType = getDb(),
): AcceptanceBenchmarkCaseDTO {
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Acceptance benchmark case ID must be a positive integer. Received: ${id}`);
  }

  if (annotation.acceptability === 'rejected' && !annotation.rejectionReason) {
    throw new Error('Rejected acceptance benchmark cases must include a rejection reason.');
  }

  const statements = createStatements(database);
  const existingCase = statements.getAcceptanceBenchmarkCaseById.get(id) as AcceptanceBenchmarkCaseDTO | undefined;
  if (!existingCase) {
    throw new Error(`Acceptance benchmark case ${id} was not found.`);
  }

  statements.updateAcceptanceBenchmarkReview.run({
    id,
    acceptability: annotation.acceptability,
    rejection_reason: annotation.acceptability === 'rejected' ? (annotation.rejectionReason ?? null) : null,
    acceptability_note: annotation.note ?? null,
  });

  return statements.getAcceptanceBenchmarkCaseById.get(id) as AcceptanceBenchmarkCaseDTO;
}

function snapshotAcceptanceBenchmark(
  database: DatabaseType,
  repository: string,
  repoPath: string,
  scanId: number,
): number {
  const statements = createStatements(database);
  const rows = database
    .prepare(
      `
        SELECT
          s.commit_sha,
          c.id AS cycle_id,
          c.normalized_path,
          c.raw_payload,
          fc.id AS fix_candidate_id,
          fc.classification,
          fc.confidence,
          p.id AS patch_id,
          p.validation_status,
          p.validation_summary,
          p.touched_files,
          COALESCE(rd.decision, 'pending') AS review_status
        FROM cycles c
        INNER JOIN scans s ON s.id = c.scan_id
        LEFT JOIN fix_candidates fc ON fc.cycle_id = c.id
        LEFT JOIN patches p ON p.fix_candidate_id = fc.id
        LEFT JOIN review_decisions rd ON rd.id = (
          SELECT id
          FROM review_decisions
          WHERE patch_id = p.id
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        )
        WHERE c.scan_id = ?
        ORDER BY c.id ASC
      `,
    )
    .all(scanId) as AcceptanceSnapshotRow[];

  for (const row of rows) {
    const rawPayload = parseRawPayload(row.raw_payload);
    const planner = rawPayload?.analysis?.planner;
    const acceptability = deriveAcceptability(row.review_status);

    statements.upsertAcceptanceBenchmarkCase.run({
      repository,
      local_path: repoPath,
      commit_sha: row.commit_sha,
      scan_id: scanId,
      cycle_id: row.cycle_id,
      fix_candidate_id: row.fix_candidate_id,
      patch_id: row.patch_id,
      normalized_path: row.normalized_path,
      classification: row.classification ?? rawPayload?.analysis?.classification ?? 'unsupported',
      confidence: row.confidence ?? rawPayload?.analysis?.confidence ?? 0,
      upstreamability_score: rawPayload?.analysis?.upstreamabilityScore ?? null,
      validation_status: row.validation_status,
      validation_summary: row.validation_summary,
      review_status: row.review_status,
      touched_files: row.touched_files,
      feature_vector: JSON.stringify(planner?.features ?? {}),
      planner_summary: planner?.selectionSummary ?? null,
      planner_attempts: JSON.stringify(planner?.attempts ?? []),
      acceptability,
      rejection_reason: null,
      acceptability_note: null,
    });
  }

  return rows.length;
}

async function cloneCorpusRepository(entry: BenchmarkCorpusEntry, workspaceDir: string): Promise<string> {
  const destination = path.join(workspaceDir, ...entry.slug.split('/'));
  await mkdir(path.dirname(destination), { recursive: true });

  if (isGitRepository(destination)) {
    return destination;
  }

  if (existsSync(destination)) {
    throw new Error(`Workspace path already exists but is not a git repository: ${destination}`);
  }

  const git = simpleGit();
  await git.clone(`https://github.com/${entry.slug}.git`, destination, ['--depth', '1']);
  return destination;
}

function buildAcceptanceSummary(rows: AcceptanceBenchmarkSummaryQueryRow[]): AcceptanceBenchmarkSummaryRow[] {
  return rows.map((row) => {
    const totalCases = Number(row.total_cases ?? 0);
    const acceptedCases = Number(row.accepted_cases ?? 0);
    const rejectedCases = Number(row.rejected_cases ?? 0);
    const needsReviewCases = Number(row.needs_review_cases ?? 0);

    return {
      classification: String(row.classification ?? 'unknown'),
      totalCases,
      acceptedCases,
      rejectedCases,
      needsReviewCases,
      acceptanceRate: totalCases === 0 ? 0 : Number((acceptedCases / totalCases).toFixed(2)),
    };
  });
}

function parseRawPayload(value: string | null): AcceptanceRawPayload | null {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as AcceptanceRawPayload;
  } catch {
    return null;
  }
}

function deriveAcceptability(reviewStatus: string): AcceptanceBenchmarkDecision {
  if (reviewStatus === 'approved' || reviewStatus === 'pr_candidate') {
    return 'accepted';
  }

  if (reviewStatus === 'rejected') {
    return 'rejected';
  }

  return 'needs_review';
}

function dedupePaths(paths: string[]): string[] {
  return [...new Set(paths.map((candidate) => path.resolve(candidate)))];
}

function isGitRepository(candidatePath: string): boolean {
  return existsSync(path.join(candidatePath, '.git'));
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
