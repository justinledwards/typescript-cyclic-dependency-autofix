import { describe, expect, it, vi } from 'vitest';
import type { PreparedMlDatasets } from './ml/shared.js';
import { clusterCyclePatterns } from './mlCluster.js';

vi.mock('./mlArtifacts.js', () => ({
  writeMlArtifact: vi.fn().mockImplementation(async (_kind: string, payload: unknown, version = 'cluster-test') => ({
    version,
    // eslint-disable-next-line sonarjs/publicly-writable-directories
    artifactPath: '/tmp/clusters.json',
    // eslint-disable-next-line sonarjs/publicly-writable-directories
    latestPath: '/tmp/latest-clusters.json',
    payload,
  })),
}));

describe('mlCluster', () => {
  it('produces stable pattern clusters from prepared cycle rows', async () => {
    const datasets: PreparedMlDatasets = {
      summary: {
        cyclePatterns: 4,
        candidateRanking: 0,
        syntheticFixtures: 0,
        candidatePreferences: 0,
      },
      cyclePatterns: [
        createCyclePatternRow('cycle-1', 'acme/a', 'host_state_update', ['ownership_localization'], 2, 1),
        createCyclePatternRow('cycle-2', 'acme/a', 'host_state_update', ['ownership_localization'], 2, 1),
        createCyclePatternRow('cycle-3', 'acme/b', 'direct_import', ['public_seam_bypass'], 5, 0),
        createCyclePatternRow('cycle-4', 'acme/b', 'direct_import', ['public_seam_bypass'], 5, 0),
      ],
      candidateRanking: [],
      syntheticFixtures: [],
      candidatePreferences: [],
    };

    const result = await clusterCyclePatterns({
      datasets,
      minClusters: 2,
      maxClusters: 2,
    });

    expect(result.selectedClusterCount).toBe(2);
    expect(result.clusters).toHaveLength(2);
    expect(result.clusters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dominantPatternLabels: ['ownership_localization'],
          dominantStrategies: ['host_state_update'],
        }),
        expect.objectContaining({
          dominantPatternLabels: ['public_seam_bypass'],
          dominantStrategies: ['direct_import'],
        }),
      ]),
    );
  });
});

function createCyclePatternRow(
  rowId: string,
  repositorySlug: string,
  selectedStrategy: string,
  patternCategories: string[],
  cycleSize: number,
  supportTarget: number,
): PreparedMlDatasets['cyclePatterns'][number] {
  return {
    datasetType: 'cycle_patterns',
    rowId,
    sourceType: 'cycle_observation',
    repositorySlug,
    commitSha: 'abc123',
    cycleId: Number(rowId.split('-').at(-1) ?? 0),
    observationId: Number(rowId.split('-').at(-1) ?? 0),
    normalizedPath: `${rowId}.ts`,
    cycleShape: cycleSize === 2 ? 'two_file' : 'multi_file',
    cycleSize,
    selectedStrategy,
    selectedClassification: supportTarget === 1 ? 'autofix_host_state_update' : 'unsupported',
    cyclePatternTarget: patternCategories[0] ?? 'unknown',
    supportTarget,
    candidateCount: 1,
    acceptedCandidateCount: supportTarget,
    rejectedCandidateCount: supportTarget === 1 ? 0 : 1,
    supportedCandidateCount: supportTarget,
    featureColumns: {
      numeric: {
        cycleSize,
        symbolNodeCount: cycleSize * 2,
      },
      categorical: {
        packageManager: 'pnpm',
        workspaceMode: 'workspace',
      },
      multiLabel: {
        patternCategories,
      },
    },
  };
}
