import type { Database as DatabaseType } from 'better-sqlite3';
import { kmeans } from 'ml-kmeans';
import { getDb } from '../db/index.js';
import {
  buildFeatureSchema,
  encodeFeatureRows,
  type MlCyclePatternRow,
  type PreparedMlDatasets,
  prepareMlDatasets,
  sortCopy,
} from './ml/shared.js';
import { writeMlArtifact } from './mlArtifacts.js';

export interface MlClusterOptions {
  database?: DatabaseType;
  datasets?: PreparedMlDatasets;
  minClusters?: number;
  maxClusters?: number;
}

export interface MlClusterSummary {
  version: string;
  repositoryCount: number;
  totalRows: number;
  selectedClusterCount: number;
  selectedSilhouetteScore: number;
  clusters: Array<{
    clusterId: number;
    size: number;
    dominantPatternLabels: string[];
    dominantStrategies: string[];
    dominantRepositorys: string[];
    supportedCount: number;
    unsupportedCount: number;
    acceptedCandidateCount: number;
    rejectedCandidateCount: number;
    representativeRows: string[];
  }>;
}

export async function clusterCyclePatterns(options: MlClusterOptions = {}): Promise<MlClusterSummary> {
  const datasets = options.datasets ?? prepareMlDatasets(options.database ?? getDb());
  const rows = datasets.cyclePatterns;
  if (rows.length < 2) {
    const payload: MlClusterSummary = {
      version: 'empty',
      repositoryCount: new Set(rows.map((row) => row.repositorySlug)).size,
      totalRows: rows.length,
      selectedClusterCount: 0,
      selectedSilhouetteScore: 0,
      clusters: [],
    };
    const artifact = await writeMlArtifact('clusters', payload, 'empty');
    return {
      ...payload,
      version: artifact.version,
    };
  }

  const schema = buildFeatureSchema(rows);
  const encoded = encodeFeatureRows(rows, schema);
  const candidateKs = buildClusterCandidates(rows.length, options.minClusters ?? 2, options.maxClusters ?? 8);

  let bestClusterIds: number[] | null = null;
  let bestK = 0;
  let bestSilhouette = Number.NEGATIVE_INFINITY;

  for (const clusterCount of candidateKs) {
    const result = kmeans(encoded.matrix, clusterCount, { initialization: 'kmeans++', seed: 42, maxIterations: 200 });
    const silhouette = computeSilhouetteScore(encoded.matrix, result.clusters);
    if (silhouette > bestSilhouette) {
      bestSilhouette = silhouette;
      bestK = clusterCount;
      bestClusterIds = result.clusters as number[];
    }
  }

  const clusterIds = bestClusterIds ?? Array.from({ length: rows.length }, () => 0);
  const clusters = summarizeClusters(rows, clusterIds);
  const payload: Omit<MlClusterSummary, 'version'> = {
    repositoryCount: new Set(rows.map((row) => row.repositorySlug)).size,
    totalRows: rows.length,
    selectedClusterCount: bestK,
    selectedSilhouetteScore: Number.isFinite(bestSilhouette) ? bestSilhouette : 0,
    clusters,
  };
  const artifact = await writeMlArtifact('clusters', payload);

  return {
    version: artifact.version,
    ...payload,
  };
}

function buildClusterCandidates(rowCount: number, minClusters: number, maxClusters: number): number[] {
  const upperBound = Math.min(maxClusters, Math.max(minClusters, Math.floor(Math.sqrt(rowCount))));
  const values = new Set<number>();
  for (let clusterCount = minClusters; clusterCount <= upperBound; clusterCount += 1) {
    if (clusterCount < rowCount) {
      values.add(clusterCount);
    }
  }
  return sortCopy([...values], (left, right) => left - right);
}

function summarizeClusters(rows: MlCyclePatternRow[], clusterIds: number[]) {
  const grouped = new Map<number, MlCyclePatternRow[]>();

  for (const [index, clusterId] of clusterIds.entries()) {
    const members = grouped.get(clusterId) ?? [];
    members.push(rows[index] as MlCyclePatternRow);
    grouped.set(clusterId, members);
  }

  return sortCopy([...grouped.entries()], ([left], [right]) => left - right).map(([clusterId, members]) => ({
    clusterId,
    size: members.length,
    dominantPatternLabels: topCounts(
      members.flatMap((member) => member.featureColumns.multiLabel.patternCategories ?? []),
    ),
    dominantStrategies: topCounts(members.map((member) => member.selectedStrategy ?? 'unsupported')),
    dominantRepositorys: topCounts(members.map((member) => member.repositorySlug)),
    supportedCount: members.filter((member) => member.supportTarget === 1).length,
    unsupportedCount: members.filter((member) => member.supportTarget === 0).length,
    acceptedCandidateCount: members.reduce((sum, member) => sum + member.acceptedCandidateCount, 0),
    rejectedCandidateCount: members.reduce((sum, member) => sum + member.rejectedCandidateCount, 0),
    representativeRows: members.slice(0, 3).map((member) => member.rowId),
  }));
}

function topCounts(values: string[], limit = 3): string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return sortCopy([...counts.entries()], (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([value]) => value);
}

// eslint-disable-next-line sonarjs/cognitive-complexity
function computeSilhouetteScore(matrix: number[][], clusterIds: number[]): number {
  if (matrix.length <= 1) {
    return 0;
  }

  const clusters = new Map<number, number[]>();
  for (const [index, clusterId] of clusterIds.entries()) {
    const members = clusters.get(clusterId) ?? [];
    members.push(index);
    clusters.set(clusterId, members);
  }

  const scores: number[] = [];
  for (let index = 0; index < matrix.length; index += 1) {
    const currentClusterId = clusterIds[index] ?? 0;
    const currentMembers = clusters.get(currentClusterId) ?? [];
    const intraDistances = currentMembers
      .filter((member) => member !== index)
      .map((member) => euclideanDistance(matrix[index] ?? [], matrix[member] ?? []));
    const a = intraDistances.length > 0 ? average(intraDistances) : 0;

    let b = Number.POSITIVE_INFINITY;
    for (const [clusterId, members] of clusters.entries()) {
      if (clusterId === currentClusterId) {
        continue;
      }
      const distances = members.map((member) => euclideanDistance(matrix[index] ?? [], matrix[member] ?? []));
      const candidate = average(distances);
      if (candidate < b) {
        b = candidate;
      }
    }

    if (!Number.isFinite(b) && a === 0) {
      scores.push(0);
      continue;
    }
    const denominator = Math.max(a, b);
    scores.push(denominator === 0 ? 0 : (b - a) / denominator);
  }

  return average(scores);
}

function euclideanDistance(left: number[], right: number[]): number {
  let sum = 0;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    sum += delta * delta;
  }
  return Math.sqrt(sum);
}

function average(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}
