import type { Database as DatabaseType } from 'better-sqlite3';
import { getDb } from '../db/index.js';
import {
  DEFAULT_ML_EXPORT_DIR,
  type MlPrepareResult,
  prepareMlDatasets,
  writePreparedMlDatasets,
} from './ml/shared.js';

export interface MlPrepareOptions {
  database?: DatabaseType;
  outputDir?: string;
}

export async function prepareMlDatasetsForTraining(options: MlPrepareOptions = {}): Promise<MlPrepareResult> {
  const datasets = prepareMlDatasets(options.database ?? getDb());
  return writePreparedMlDatasets(datasets, options.outputDir ?? DEFAULT_ML_EXPORT_DIR);
}
