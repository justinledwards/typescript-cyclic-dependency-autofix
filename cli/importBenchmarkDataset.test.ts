import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type BenchmarkCaseDTO, createDatabase, createStatements, initSchema } from '../db/index.js';
import { importBenchmarkDataset } from './importBenchmarkDataset.js';

describe('importBenchmarkDataset', () => {
  let db: ReturnType<typeof createDatabase>;
  let outputDir: string;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    initSchema(db);
    outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'benchmark-import-'));
  });

  afterEach(async () => {
    db.close();
    await fs.rm(outputDir, { recursive: true, force: true });
  });

  it('imports JSONL rows that are both JS/TS and cycle-related', async () => {
    const inputPath = path.join(outputDir, 'swebench.jsonl');
    await fs.writeFile(
      inputPath,
      [
        JSON.stringify({
          repo: 'acme/widget',
          base_commit: 'abc123',
          problem_statement: 'Fix circular dependency in the TS planner by converting an import to import type.',
          patch: [
            'diff --git a/src/planner.ts b/src/planner.ts',
            '--- a/src/planner.ts',
            '+++ b/src/planner.ts',
            '@@',
            "-import { Node } from './types'",
            "+import type { Node } from './types'",
          ].join('\n'),
        }),
        JSON.stringify({
          repo: 'acme/widget',
          base_commit: 'def456',
          problem_statement: 'Document the circular dependency workaround in the README.',
          patch: ['diff --git a/README.md b/README.md', '--- a/README.md', '+++ b/README.md'].join('\n'),
        }),
        JSON.stringify({
          repo: 'acme/widget',
          base_commit: 'ghi789',
          problem_statement: 'Fix a rendering bug in the TS app shell.',
          patch: ['diff --git a/src/app.ts b/src/app.ts', '--- a/src/app.ts', '+++ b/src/app.ts'].join('\n'),
        }),
      ].join('\n'),
      'utf8',
    );

    const result = await importBenchmarkDataset(inputPath, {
      database: db,
      datasetName: 'swe-bench-multilingual',
    });

    const cases = createStatements(db).getBenchmarkCases.all() as BenchmarkCaseDTO[];

    expect(result).toMatchObject({
      format: 'jsonl',
      totalRows: 3,
      jsTsRows: 2,
      relatedRows: 1,
      insertedCases: 1,
      skippedNonJsTs: 1,
      skippedUnrelated: 1,
    });
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      repository: 'acme/widget',
      source: 'dataset:swe-bench-multilingual',
      commit_sha: 'abc123',
    });
    expect(JSON.parse(cases[0].strategy_labels)).toEqual(expect.arrayContaining(['import_type']));
    expect(JSON.parse(cases[0].validation_signals)).toMatchObject({
      dataset_name: 'swe-bench-multilingual',
      imported: true,
      language_scope: {
        training_language: 'js_ts',
        eligible: true,
        js_ts_changed_files: ['src/planner.ts'],
      },
      matched_terms: expect.arrayContaining(['circular dependency', 'import type']),
    });
  });

  it('imports Parquet rows through DuckDB', async () => {
    const parquetPath = path.join(outputDir, 'fixjs.parquet');
    await writeParquetFixture(parquetPath, [
      {
        repository: 'acme/core',
        instance_id: 'case-1',
        title: 'Break cyclic dependency with barrel cleanup',
        patch: [
          'diff --git a/src/index.ts b/src/index.ts',
          '--- a/src/index.ts',
          '+++ b/src/index.ts',
          'diff --git a/src/runtime.ts b/src/runtime.ts',
          '--- a/src/runtime.ts',
          '+++ b/src/runtime.ts',
        ].join('\n'),
      },
    ]);

    const result = await importBenchmarkDataset(parquetPath, {
      database: db,
      datasetName: 'fixjs-derived',
    });

    const cases = createStatements(db).getBenchmarkCases.all() as BenchmarkCaseDTO[];

    expect(result).toMatchObject({
      format: 'parquet',
      totalRows: 1,
      jsTsRows: 1,
      relatedRows: 1,
      insertedCases: 1,
    });
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      repository: 'acme/core',
      source: 'dataset:fixjs-derived',
      commit_sha: 'case-1',
    });
    expect(JSON.parse(cases[0].matched_terms)).toEqual(expect.arrayContaining(['cyclic dependency', 'barrel']));
  });
});

async function writeParquetFixture(outputPath: string, rows: Array<Record<string, unknown>>) {
  const instance = await DuckDBInstance.create(':memory:');
  try {
    const connection = await instance.connect();
    try {
      const jsonlPath = path.join(path.dirname(outputPath), 'fixture.jsonl');
      await fs.writeFile(`${jsonlPath}`, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
      await connection.run('LOAD json');
      await connection.run('LOAD parquet');
      await connection.run(`
        CREATE TABLE fixture_rows AS
        SELECT *
        FROM read_json_auto('${jsonlPath.replaceAll('\\', '/')}', format = 'newline_delimited')
      `);
      await connection.run(`
        COPY fixture_rows
        TO '${outputPath.replaceAll('\\', '/')}'
        (FORMAT parquet, COMPRESSION zstd)
      `);
    } finally {
      connection.closeSync();
    }
  } finally {
    instance.closeSync();
  }
}
