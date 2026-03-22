import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import type { Database as DatabaseType } from 'better-sqlite3';
import { getDb } from '../db/index.js';
import { getTrainingDataExport } from '../db/trainingData.js';

const DEFAULT_OUTPUT_DIR = path.join(process.cwd(), 'exports', 'training-data');

export type TrainingDataFormat = 'json' | 'jsonl' | 'parquet';

export interface ExportTrainingDataOptions {
  database?: DatabaseType;
  format?: TrainingDataFormat;
}

export interface ExportTrainingDataResult {
  outputPath: string;
  format: TrainingDataFormat;
  totalRows: number;
  cycleObservationRows: number;
  candidateObservationRows: number;
  acceptanceBenchmarkRows: number;
  benchmarkCaseRows: number;
}

export async function exportTrainingData(
  outputPath?: string,
  options: ExportTrainingDataOptions = {},
): Promise<ExportTrainingDataResult> {
  const format = options.format ?? 'jsonl';
  const database = options.database ?? getDb();
  const exportData = getTrainingDataExport(database);
  const resolvedOutputPath = outputPath ?? defaultOutputPath(format);
  await fs.mkdir(path.dirname(resolvedOutputPath), { recursive: true });
  await writeExport(resolvedOutputPath, format, exportData);

  return {
    outputPath: resolvedOutputPath,
    format,
    totalRows: exportData.summary.totalRows,
    cycleObservationRows: exportData.summary.cycleObservationRows,
    candidateObservationRows: exportData.summary.candidateObservationRows,
    acceptanceBenchmarkRows: exportData.summary.acceptanceBenchmarkRows,
    benchmarkCaseRows: exportData.summary.benchmarkCaseRows,
  };
}

async function writeExport(
  outputPath: string,
  format: TrainingDataFormat,
  exportData: ReturnType<typeof getTrainingDataExport>,
): Promise<void> {
  if (format === 'json') {
    await fs.writeFile(outputPath, JSON.stringify(exportData, null, 2), 'utf8');
    return;
  }

  const jsonl = serializeJsonl(exportData.rows);
  if (format === 'jsonl') {
    await fs.writeFile(outputPath, jsonl, 'utf8');
    return;
  }

  await writeParquet(outputPath, jsonl);
}

function serializeJsonl(rows: unknown[]): string {
  if (rows.length === 0) {
    return '';
  }

  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

function defaultOutputPath(format: TrainingDataFormat): string {
  return path.join(DEFAULT_OUTPUT_DIR, `training-data.${format}`);
}

async function writeParquet(outputPath: string, jsonl: string): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autofix-training-data-'));
  const jsonlPath = path.join(tempDir, 'training-data.jsonl');

  try {
    await fs.writeFile(jsonlPath, jsonl, 'utf8');

    const instance = await DuckDBInstance.create(':memory:');
    try {
      const connection = await instance.connect();
      try {
        await connection.run('LOAD json');
        await connection.run('LOAD parquet');
        await connection.run(`
          CREATE TABLE training_data AS
          SELECT *
          FROM read_json_auto('${escapeSqlString(normalizeForDuckDb(jsonlPath))}', format = 'newline_delimited')
        `);
        await connection.run(`
          COPY training_data
          TO '${escapeSqlString(normalizeForDuckDb(outputPath))}'
          (FORMAT parquet, COMPRESSION zstd)
        `);
      } finally {
        connection.closeSync();
      }
    } finally {
      instance.closeSync();
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function normalizeForDuckDb(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function escapeSqlString(value: string): string {
  return value.replaceAll("'", "''");
}
