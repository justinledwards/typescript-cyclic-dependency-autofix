import fs from 'node:fs/promises';
import path from 'node:path';
import type { Database as DatabaseType } from 'better-sqlite3';
import { getDb } from '../db/index.js';

const DEFAULT_OUTPUT_DIR = path.join(process.cwd(), 'exports', 'patches');

interface ExportablePatchRow {
  patch_id: number;
  fix_candidate_id: number;
  cycle_id: number;
  scan_id: number;
  owner: string;
  name: string;
  patch_text: string;
  review_status: string;
  validation_status: string | null;
}

export interface ExportResult {
  outputDir: string;
  exportedCount: number;
  files: string[];
}

export async function exportApprovedPatches(
  outputDir = DEFAULT_OUTPUT_DIR,
  database: DatabaseType = getDb(),
): Promise<ExportResult> {
  const rows = database
    .prepare(`
    SELECT
      p.id AS patch_id,
      fc.id AS fix_candidate_id,
      c.id AS cycle_id,
      s.id AS scan_id,
      r.owner,
      r.name,
      p.patch_text,
      COALESCE(rd.decision, 'pending') AS review_status,
      p.validation_status
    FROM patches p
    INNER JOIN fix_candidates fc ON fc.id = p.fix_candidate_id
    INNER JOIN cycles c ON c.id = fc.cycle_id
    INNER JOIN scans s ON s.id = c.scan_id
    INNER JOIN repositories r ON r.id = s.repository_id
    LEFT JOIN review_decisions rd ON rd.id = (
      SELECT id
      FROM review_decisions
      WHERE patch_id = p.id
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    )
    WHERE rd.decision IN ('approved', 'pr_candidate')
      AND p.validation_status = 'passed'
    ORDER BY r.owner ASC, r.name ASC, s.id ASC, fc.id ASC, p.id ASC
  `)
    .all() as ExportablePatchRow[];

  await fs.mkdir(outputDir, { recursive: true });

  const exportedFiles: string[] = [];
  for (const row of rows) {
    const filePath = buildExportPath(outputDir, row);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, row.patch_text, 'utf8');
    exportedFiles.push(filePath);
  }

  return {
    outputDir,
    exportedCount: exportedFiles.length,
    files: exportedFiles,
  };
}

function buildExportPath(outputDir: string, row: ExportablePatchRow): string {
  const repoSegment = `${sanitizeSegment(row.owner)}-${sanitizeSegment(row.name)}`;
  const scanSegment = `scan-${row.scan_id}`;
  const cycleSegment = `cycle-${row.cycle_id}`;
  const fileSegment = `fix-${row.fix_candidate_id}-patch-${row.patch_id}-${row.review_status}.patch`;

  return path.join(outputDir, repoSegment, scanSegment, cycleSegment, fileSegment);
}

function sanitizeSegment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]+/g, '-');
}
