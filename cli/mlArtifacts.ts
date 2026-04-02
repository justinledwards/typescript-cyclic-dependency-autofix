import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_ML_ARTIFACT_DIR } from './ml/shared.js';

export type MlArtifactKind = 'clusters' | 'ranker' | 'evaluation' | 'comparison';

export interface MlArtifactWriteResult {
  version: string;
  artifactPath: string;
  latestPath: string;
}

export function createMlArtifactVersion(): string {
  return new Date()
    .toISOString()
    .replaceAll(/[-:.TZ]/g, '')
    .slice(0, 14);
}

export async function writeMlArtifact(
  kind: MlArtifactKind,
  payload: unknown,
  version = createMlArtifactVersion(),
  baseDir = DEFAULT_ML_ARTIFACT_DIR,
): Promise<MlArtifactWriteResult> {
  await fs.mkdir(baseDir, { recursive: true });
  const artifactPath = path.join(baseDir, `${kind}-${version}.json`);
  const latestPath = path.join(baseDir, `latest-${kind}.json`);
  const json = `${JSON.stringify(payload, null, 2)}\n`;

  await fs.writeFile(artifactPath, json, 'utf8');
  await fs.writeFile(latestPath, json, 'utf8');

  return {
    version,
    artifactPath,
    latestPath,
  };
}

export async function readLatestMlArtifact<T>(
  kind: MlArtifactKind,
  baseDir = DEFAULT_ML_ARTIFACT_DIR,
): Promise<T | null> {
  const latestPath = path.join(baseDir, `latest-${kind}.json`);
  try {
    const contents = await fs.readFile(latestPath, 'utf8');
    return JSON.parse(contents) as T;
  } catch {
    return null;
  }
}
