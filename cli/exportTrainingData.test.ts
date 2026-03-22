import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, createStatements, initSchema } from '../db/index.js';
import { exportTrainingData } from './exportTrainingData.js';

const fixtureRoot = path.join(process.cwd(), '.test-fixtures', 'training-export');

describe('exportTrainingData', () => {
  let db: ReturnType<typeof createDatabase>;
  let statements: ReturnType<typeof createStatements>;
  let outputDir: string;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    initSchema(db);
    statements = createStatements(db);
    outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'training-export-'));
  });

  afterEach(async () => {
    db.close();
    await fs.rm(outputDir, { recursive: true, force: true });
  });

  it('exports JSONL training rows from observations and benchmark tables', async () => {
    seedTrainingRows(statements);

    const outputPath = path.join(outputDir, 'training-data.jsonl');
    const result = await exportTrainingData(outputPath, {
      database: db,
      format: 'jsonl',
    });

    const contents = await fs.readFile(outputPath, 'utf8');
    const rows = contents
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { rowType: string; repository?: { slug?: string } });

    expect(result).toMatchObject({
      outputPath,
      format: 'jsonl',
      totalRows: 4,
      cycleObservationRows: 1,
      candidateObservationRows: 1,
      acceptanceBenchmarkRows: 1,
      benchmarkCaseRows: 1,
    });
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rowType: 'cycle_observation',
          repository: expect.objectContaining({ slug: 'acme/widget' }),
        }),
        expect.objectContaining({
          rowType: 'candidate_observation',
          repository: expect.objectContaining({ slug: 'acme/widget' }),
        }),
        expect.objectContaining({ rowType: 'acceptance_benchmark' }),
        expect.objectContaining({ rowType: 'benchmark_case' }),
      ]),
    );
  });

  it('exports Parquet training rows through DuckDB', async () => {
    seedTrainingRows(statements);

    const outputPath = path.join(outputDir, 'training-data.parquet');
    const result = await exportTrainingData(outputPath, {
      database: db,
      format: 'parquet',
    });

    expect(result).toMatchObject({
      outputPath,
      format: 'parquet',
      totalRows: 4,
    });

    const instance = await DuckDBInstance.create(':memory:');
    try {
      const connection = await instance.connect();
      try {
        const reader = await connection.runAndReadAll(`
          SELECT
            COUNT(*) AS total_rows,
            SUM(CASE WHEN rowType = 'candidate_observation' THEN 1 ELSE 0 END) AS candidate_rows
          FROM read_parquet('${outputPath.replaceAll('\\', '/')}')
        `);
        const rows = reader.getRowObjectsJson() as Array<{
          total_rows: string | number;
          candidate_rows: string | number;
        }>;

        expect(rows[0]).toMatchObject({
          total_rows: '4',
          candidate_rows: '1',
        });
      } finally {
        connection.closeSync();
      }
    } finally {
      instance.closeSync();
    }
  });
});

function seedTrainingRows(statements: ReturnType<typeof createStatements>) {
  const repositoryInfo = statements.addRepository.run({
    owner: 'acme',
    name: 'widget',
    default_branch: 'main',
    local_path: path.join(fixtureRoot, 'repo'),
  });
  const scanInfo = statements.addScan.run({
    repository_id: repositoryInfo.lastInsertRowid,
    commit_sha: 'abc123',
    status: 'completed',
  });
  const cycleInfo = statements.addCycle.run({
    scan_id: scanInfo.lastInsertRowid,
    normalized_path: 'a.ts -> b.ts -> a.ts',
    participating_files: JSON.stringify(['a.ts', 'b.ts', 'a.ts']),
    raw_payload: JSON.stringify({
      type: 'circular',
      path: ['a.ts', 'b.ts', 'a.ts'],
    }),
  });
  const cycleObservationInfo = statements.addCycleObservation.run({
    cycle_id: cycleInfo.lastInsertRowid,
    scan_id: scanInfo.lastInsertRowid,
    repository_id: repositoryInfo.lastInsertRowid,
    observation_version: 1,
    normalized_path: 'a.ts -> b.ts -> a.ts',
    cycle_shape: 'two_file',
    cycle_size: 2,
    cycle_signals: JSON.stringify({ explicitImportEdges: 2 }),
    feature_vector: JSON.stringify({ cycleSize: 2, packageManager: 'pnpm' }),
    graph_summary: JSON.stringify({ metrics: { symbolSccCount: 1 } }),
    repo_profile: JSON.stringify({ packageManager: 'pnpm', workspaceMode: 'workspace' }),
    planner_summary: 'Selected import_type after ranking one candidate.',
    planner_attempts: JSON.stringify([{ strategy: 'import_type', status: 'candidate' }]),
    selected_strategy: 'import_type',
    selected_classification: 'autofix_import_type',
    selected_score: 0.94,
    fallback_classification: 'autofix_import_type',
    fallback_confidence: 0.9,
    fallback_reasons: JSON.stringify(['Cycle can be resolved by converting imports to type-only.']),
  });
  const fixCandidateInfo = statements.addFixCandidate.run({
    cycle_id: cycleInfo.lastInsertRowid,
    strategy: 'import_type',
    planner_rank: 1,
    classification: 'autofix_import_type',
    confidence: 0.9,
    upstreamability_score: 0.94,
    reasons: JSON.stringify(['Cycle can be resolved by converting imports to type-only.']),
    summary: 'Convert import to type-only.',
    score_breakdown: JSON.stringify(['base 0.97']),
    signals: JSON.stringify({ importEdges: 2 }),
  });
  const patchInfo = statements.addPatch.run({
    fix_candidate_id: fixCandidateInfo.lastInsertRowid,
    patch_text: '--- a.ts\n+++ a.ts\n',
    touched_files: JSON.stringify(['a.ts']),
    validation_status: 'passed',
    validation_summary: 'Validation passed.',
  });
  statements.addReviewDecision.run({
    patch_id: patchInfo.lastInsertRowid,
    decision: 'approved',
    notes: 'Looks good',
  });
  statements.addCandidateObservation.run({
    cycle_observation_id: cycleObservationInfo.lastInsertRowid,
    observation_version: 1,
    fix_candidate_id: fixCandidateInfo.lastInsertRowid,
    patch_id: patchInfo.lastInsertRowid,
    strategy: 'import_type',
    status: 'candidate',
    planner_rank: 1,
    promotion_eligible: 1,
    summary: 'Convert import to type-only.',
    classification: 'autofix_import_type',
    confidence: 0.9,
    upstreamability_score: 0.94,
    reasons: JSON.stringify(['Cycle can be resolved by converting imports to type-only.']),
    score_breakdown: JSON.stringify(['base 0.97']),
    signals: JSON.stringify({ importEdges: 2 }),
    plan: JSON.stringify({ kind: 'import_type', imports: [{ sourceFile: 'a.ts', targetFile: 'b.ts' }] }),
    validation_status: 'passed',
    validation_summary: 'Validation passed.',
    validation_failure_category: null,
  });
  statements.upsertAcceptanceBenchmarkCase.run({
    repository: 'acme/widget',
    local_path: path.join(fixtureRoot, 'repo'),
    commit_sha: 'abc123',
    scan_id: scanInfo.lastInsertRowid,
    cycle_id: cycleInfo.lastInsertRowid,
    fix_candidate_id: fixCandidateInfo.lastInsertRowid,
    patch_id: patchInfo.lastInsertRowid,
    normalized_path: 'a.ts -> b.ts -> a.ts',
    classification: 'autofix_import_type',
    confidence: 0.9,
    upstreamability_score: 0.94,
    validation_status: 'passed',
    validation_summary: 'Validation passed.',
    review_status: 'approved',
    touched_files: JSON.stringify(['a.ts']),
    feature_vector: JSON.stringify({ packageManager: 'pnpm' }),
    planner_summary: 'Selected import_type.',
    planner_attempts: JSON.stringify([{ strategy: 'import_type', status: 'candidate' }]),
    acceptability: 'accepted',
    rejection_reason: null,
    acceptability_note: 'Accepted training sample',
  });
  statements.addBenchmarkCase.run({
    repository: 'acme/widget',
    source: 'git_history',
    commit_sha: 'def456',
    title: 'Break circular dependency via type-only import',
    body: 'Converts a runtime import into import type.',
    url: 'https://example.com/commit/def456',
    pr_number: null,
    issue_number: null,
    strategy_labels: JSON.stringify(['import_type']),
    validation_signals: JSON.stringify({ repository_profile: { package_manager: 'pnpm' } }),
    diff_features: JSON.stringify({ filesTouched: 1 }),
    matched_terms: JSON.stringify(['circular dependency', 'import type']),
    notes: 'Seed benchmark sample',
  });
}
