import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import type { Database as DatabaseType } from 'better-sqlite3';
import { createStatements, getDb } from '../db/index.js';
import {
  classifyStrategyLabels,
  findMatchedTerms,
  getDefaultBenchmarkSearchTerms,
  normalizeSearchTerms,
} from './benchmarkSignals.js';

const TRAINING_CODE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mts', '.cts']);

export type BenchmarkDatasetFormat = 'json' | 'jsonl' | 'parquet';

export interface ImportBenchmarkDatasetOptions {
  database?: DatabaseType;
  datasetName?: string;
  source?: string;
  format?: BenchmarkDatasetFormat;
  searchTerms?: string[];
  maxRows?: number;
  relatedOnly?: boolean;
}

export interface ImportBenchmarkDatasetResult {
  inputPath: string;
  datasetName: string;
  source: string;
  format: BenchmarkDatasetFormat;
  totalRows: number;
  jsTsRows: number;
  relatedRows: number;
  insertedCases: number;
  skippedNonJsTs: number;
  skippedUnrelated: number;
}

interface ImportedDatasetRow {
  repository: string;
  commitSha: string;
  title: string;
  body: string | null;
  url: string | null;
  prNumber: number | null;
  issueNumber: number | null;
  text: string;
  changedFiles: ChangedFileSummary;
  diffFeatures: Record<string, unknown>;
  validationSignals: Record<string, unknown>;
}

interface ChangedFileSummary {
  allPaths: string[];
  jsTsPaths: string[];
  nonJsTsPaths: string[];
}

export async function importBenchmarkDataset(
  inputPath: string,
  options: ImportBenchmarkDatasetOptions = {},
): Promise<ImportBenchmarkDatasetResult> {
  const database = options.database ?? getDb();
  const statements = createStatements(database);
  const resolvedInputPath = path.resolve(inputPath);
  const format = options.format ?? detectDatasetFormat(resolvedInputPath);
  const datasetName = options.datasetName?.trim() || path.basename(resolvedInputPath, path.extname(resolvedInputPath));
  const source = options.source?.trim() || `dataset:${datasetName}`;
  const relatedOnly = options.relatedOnly ?? true;
  const searchTerms = normalizeSearchTerms(options.searchTerms ?? getDefaultBenchmarkSearchTerms());
  const rawRows = await loadDatasetRows(resolvedInputPath, format);

  let totalRows = 0;
  let jsTsRows = 0;
  let relatedRows = 0;
  let insertedCases = 0;
  let skippedNonJsTs = 0;
  let skippedUnrelated = 0;

  for (const [index, rawRow] of rawRows.entries()) {
    if (typeof options.maxRows === 'number' && totalRows >= options.maxRows) {
      break;
    }

    totalRows += 1;
    const normalizedRow = normalizeImportedRow(rawRow, datasetName, source, index);
    if (normalizedRow.changedFiles.jsTsPaths.length === 0) {
      skippedNonJsTs += 1;
      continue;
    }

    jsTsRows += 1;
    const matchedTerms = findMatchedTerms(normalizedRow.text, searchTerms);
    if (matchedTerms.length > 0) {
      relatedRows += 1;
    } else if (relatedOnly) {
      skippedUnrelated += 1;
      continue;
    }

    statements.addBenchmarkCase.run({
      repository: normalizedRow.repository,
      source,
      commit_sha: normalizedRow.commitSha,
      title: normalizedRow.title,
      body: normalizedRow.body,
      url: normalizedRow.url,
      pr_number: normalizedRow.prNumber,
      issue_number: normalizedRow.issueNumber,
      strategy_labels: JSON.stringify(classifyStrategyLabels(normalizedRow.text)),
      validation_signals: JSON.stringify({
        ...normalizedRow.validationSignals,
        dataset_name: datasetName,
        imported: true,
        language_scope: buildLanguageScopeSignals(normalizedRow.changedFiles),
        matched_terms: matchedTerms,
        search_terms: searchTerms.length,
      }),
      diff_features: JSON.stringify(normalizedRow.diffFeatures),
      matched_terms: JSON.stringify(matchedTerms),
      notes: buildImportNote(datasetName, matchedTerms, normalizedRow.changedFiles),
    });

    insertedCases += 1;
  }

  return {
    inputPath: resolvedInputPath,
    datasetName,
    source,
    format,
    totalRows,
    jsTsRows,
    relatedRows,
    insertedCases,
    skippedNonJsTs,
    skippedUnrelated,
  };
}

function detectDatasetFormat(inputPath: string): BenchmarkDatasetFormat {
  const lowerPath = inputPath.toLowerCase();
  if (lowerPath.endsWith('.jsonl')) {
    return 'jsonl';
  }
  if (lowerPath.endsWith('.parquet')) {
    return 'parquet';
  }

  return 'json';
}

async function loadDatasetRows(inputPath: string, format: BenchmarkDatasetFormat): Promise<Record<string, unknown>[]> {
  if (format === 'json') {
    const contents = await fs.readFile(inputPath, 'utf8');
    const parsed = JSON.parse(contents) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((entry): entry is Record<string, unknown> => isRecord(entry));
    }
    if (isRecord(parsed) && Array.isArray(parsed.rows)) {
      return parsed.rows.filter((entry): entry is Record<string, unknown> => isRecord(entry));
    }

    throw new Error(`JSON benchmark dataset must be an array or contain a "rows" array: ${inputPath}`);
  }

  if (format === 'jsonl') {
    const contents = await fs.readFile(inputPath, 'utf8');
    return contents
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown)
      .filter((entry): entry is Record<string, unknown> => isRecord(entry));
  }

  const instance = await DuckDBInstance.create(':memory:');
  try {
    const connection = await instance.connect();
    try {
      const reader = await connection.runAndReadAll(`
        SELECT *
        FROM read_parquet('${escapeSqlString(normalizeForDuckDb(inputPath))}')
      `);
      return (reader.getRowObjectsJson() as unknown[]).filter((entry): entry is Record<string, unknown> =>
        isRecord(entry),
      );
    } finally {
      connection.closeSync();
    }
  } finally {
    instance.closeSync();
  }
}

function normalizeImportedRow(
  row: Record<string, unknown>,
  datasetName: string,
  source: string,
  index: number,
): ImportedDatasetRow {
  const textParts = collectTextParts(row);
  const text = textParts.join('\n\n').trim();
  const changedFiles = extractChangedFiles(row);
  const repository =
    firstString(row.repository, row.repo, row.repo_name, row.project, row.project_name, row.slug) ??
    `dataset/${datasetName}`;
  const title = firstString(row.title, row.issue_title, row.summary, row.problem_title) ?? fallbackTitle(text, index);
  const body =
    firstString(row.body, row.problem_statement, row.description, row.issue_body, row.message, row.commit_message) ??
    null;
  const commitSha =
    firstString(row.commit_sha, row.base_commit, row.sha, row.instance_id, row.id, row.record_id) ??
    buildSyntheticIdentifier(source, repository, title, index);
  const url = firstString(row.url, row.html_url, row.pull_request_url, row.issue_url) ?? null;
  const prNumber = firstInteger(row.pr_number, row.pull_request_number, row.pr, row.pull_number);
  const issueNumber = firstInteger(row.issue_number, row.issue, row.issue_id);
  const patch = firstString(row.patch, row.test_patch, row.diff) ?? '';

  return {
    repository,
    commitSha,
    title,
    body,
    url,
    prNumber,
    issueNumber,
    text,
    changedFiles,
    diffFeatures: {
      files_changed: changedFiles.allPaths.length,
      js_ts_files_changed: changedFiles.jsTsPaths.length,
      non_js_ts_files_changed: changedFiles.nonJsTsPaths.length,
      patch_length: patch.length,
      text_length: text.length,
    },
    validationSignals: {
      source_fields: Object.keys(row),
      row_identifier:
        firstString(row.instance_id, row.id, row.record_id, row.base_commit, row.commit_sha, row.sha) ??
        `row-${index + 1}`,
      has_patch: patch.length > 0,
    },
  };
}

function collectTextParts(row: Record<string, unknown>): string[] {
  return [
    firstString(row.title, row.issue_title, row.summary, row.problem_title),
    firstString(row.problem_statement, row.body, row.description, row.issue_body),
    firstString(row.commit_message, row.message),
    firstString(row.patch, row.test_patch, row.diff),
  ].filter(Boolean) as string[];
}

function extractChangedFiles(row: Record<string, unknown>): ChangedFileSummary {
  const pathSet = new Set<string>();

  for (const field of [row.file_path, row.path, row.file, row.changed_files, row.files, row.paths]) {
    for (const filePath of extractPathsFromField(field)) {
      pathSet.add(filePath);
    }
  }

  for (const patchText of [row.patch, row.test_patch, row.diff]) {
    for (const filePath of extractPathsFromPatch(firstString(patchText) ?? '')) {
      pathSet.add(filePath);
    }
  }

  const allPaths = [...pathSet];
  const jsTsPaths: string[] = [];
  const nonJsTsPaths: string[] = [];

  for (const filePath of allPaths) {
    if (isJavaScriptOrTypeScriptPath(filePath)) {
      jsTsPaths.push(filePath);
      continue;
    }

    nonJsTsPaths.push(filePath);
  }

  return {
    allPaths,
    jsTsPaths,
    nonJsTsPaths,
  };
}

function extractPathsFromField(value: unknown): string[] {
  if (typeof value === 'string') {
    return value
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => firstString(entry)).filter((entry): entry is string => entry !== undefined);
  }

  return [];
}

function extractPathsFromPatch(patch: string): string[] {
  const pathSet = new Set<string>();
  for (const line of patch.split('\n')) {
    const diffGitMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (diffGitMatch) {
      pathSet.add(diffGitMatch[2]);
      continue;
    }

    const fileMatch = line.match(/^(?:\+\+\+|---) [ab]\/(.+)$/);
    if (fileMatch) {
      pathSet.add(fileMatch[1]);
    }
  }

  return [...pathSet].map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function buildLanguageScopeSignals(changedFiles: ChangedFileSummary): Record<string, unknown> {
  return {
    training_language: 'js_ts',
    eligible: true,
    js_ts_changed_files: changedFiles.jsTsPaths,
    non_js_ts_changed_files: changedFiles.nonJsTsPaths,
    total_changed_paths: changedFiles.allPaths.length,
  };
}

function buildImportNote(datasetName: string, matchedTerms: string[], changedFiles: ChangedFileSummary): string {
  const relatedNote = matchedTerms.length > 0 ? matchedTerms.join(', ') : 'none';
  return [
    `dataset: ${datasetName}`,
    `matched terms: ${relatedNote}`,
    `js/ts files: ${changedFiles.jsTsPaths.length}`,
    `other files: ${changedFiles.nonJsTsPaths.length}`,
  ].join('; ');
}

function fallbackTitle(text: string, index: number): string {
  const normalizedText = text.replaceAll(/\s+/g, ' ').trim();
  if (normalizedText.length > 0) {
    return normalizedText.slice(0, 120);
  }

  return `Imported benchmark row ${index + 1}`;
}

function buildSyntheticIdentifier(source: string, repository: string, title: string, index: number): string {
  return createHash('sha256')
    .update(`${source}\u001F${repository}\u001F${title}\u001F${index}`)
    .digest('hex')
    .slice(0, 16);
}

function isJavaScriptOrTypeScriptPath(filePath: string): boolean {
  const normalizedPath = filePath.trim().toLowerCase();
  if (!normalizedPath) {
    return false;
  }

  return TRAINING_CODE_EXTENSIONS.has(path.extname(normalizedPath));
}

function normalizeForDuckDb(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function escapeSqlString(value: string): string {
  return value.replaceAll("'", "''");
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }

  return undefined;
}

function firstInteger(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isInteger(value)) {
      return value;
    }

    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isInteger(parsed)) {
        return parsed;
      }
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
