import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatSmokeSuiteResult, loadSmokeFixtures, runSmokeSuite } from './smoke.js';

const tempDirs: string[] = [];
// eslint-disable-next-line sonarjs/publicly-writable-directories
const TEST_REPO_ONE_PATH = '/tmp/repo-one';
// eslint-disable-next-line sonarjs/publicly-writable-directories
const TEST_REPO_THREE_PATH = '/tmp/repo-three';
// eslint-disable-next-line sonarjs/publicly-writable-directories
const TEST_REPO_FOUR_PATH = '/tmp/repo-four';

interface ExpectationFailureCase {
  name: string;
  expectations: {
    exactCycles?: number;
    minCycles?: number;
    maxCycles?: number;
    minClassifications?: Record<string, number>;
    minPatches?: number;
  };
  cycles: Array<{ id: number }>;
  candidatesByCycle: Record<number, Array<{ id: number; classification: string }>>;
  patchesByCandidate: Record<number, Array<{ id: number }>>;
  messageFragment: string;
}

async function createFixturesFile(contents: unknown): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smoke-fixtures-'));
  tempDirs.push(tempDir);
  const fixturePath = path.join(tempDir, 'fixtures.json');
  await fs.writeFile(fixturePath, JSON.stringify(contents), 'utf8');
  return fixturePath;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((candidate) => fs.rm(candidate, { recursive: true, force: true })));
});

describe('smoke suite', () => {
  it('loads smoke fixtures from JSON', async () => {
    const fixturePath = await createFixturesFile([
      {
        name: 'openclaw',
        target: '../openclaw',
        expectations: {
          minCycles: 1,
        },
      },
    ]);

    const fixtures = await loadSmokeFixtures(fixturePath);
    expect(fixtures).toEqual([
      {
        name: 'openclaw',
        target: '../openclaw',
        expectations: {
          minCycles: 1,
          exactCycles: undefined,
          maxCycles: undefined,
          minClassifications: undefined,
          minPatches: undefined,
        },
      },
    ]);
  });

  it('rejects invalid fixture files', async () => {
    const fixturePath = await createFixturesFile({ name: 'broken' });
    await expect(loadSmokeFixtures(fixturePath)).rejects.toThrow('must contain an array');
  });

  it('rejects invalid fixture entries and expectation blocks', async () => {
    const fixturePath = await createFixturesFile([
      null,
      {
        name: 'broken',
        target: '../broken',
        expectations: 42,
      },
    ]);

    await expect(loadSmokeFixtures(fixturePath)).rejects.toThrow('must be an object');
  });

  it('runs the smoke suite and reports pass/fail results with stage information', async () => {
    const scanRepository = vi
      .fn()
      .mockResolvedValueOnce({
        scanId: 1,
        repoPath: TEST_REPO_ONE_PATH,
        cyclesFound: 2,
      })
      .mockRejectedValueOnce(new Error('Validation failed: the original cycle is still present.'));

    const report = await runSmokeSuite(
      [
        {
          name: 'repo-one',
          target: '../repo-one',
          expectations: {
            minCycles: 2,
            minClassifications: {
              autofix_extract_shared: 2,
            },
            minPatches: 1,
          },
        },
        {
          name: 'repo-two',
          target: 'https://github.com/org/repo-two.git',
        },
      ],
      {
        worktreesDir: './worktrees/smoke',
        dependencies: {
          scanRepository,
          getCyclesByScanId: (scanId) => (scanId === 1 ? [{ id: 11 }, { id: 12 }] : []),
          getFixCandidatesByCycleId: (cycleId) =>
            ({
              11: [
                { id: 111, classification: 'autofix_extract_shared' },
                { id: 112, classification: 'unsupported' },
              ],
              12: [{ id: 121, classification: 'autofix_extract_shared' }],
            })[cycleId] ?? [],
          getPatchesByFixCandidateId: (candidateId) =>
            ({
              111: [{ id: 1 }],
            })[candidateId] ?? [],
        },
      },
    );

    expect(report).toMatchObject({
      passed: 1,
      failed: 1,
      results: [
        {
          name: 'repo-one',
          status: 'passed',
          cyclesFound: 2,
          candidateCount: 3,
          patchCount: 1,
        },
        {
          name: 'repo-two',
          status: 'failed',
          stage: 'validation',
          message: 'Validation failed: the original cycle is still present.',
        },
      ],
    });
    expect(formatSmokeSuiteResult(report)).toContain('PASS repo-one');
    expect(formatSmokeSuiteResult(report)).toContain('FAIL repo-two [validation]');
  });

  it.each<ExpectationFailureCase>([
    {
      name: 'exact cycle expectations',
      expectations: { exactCycles: 2 },
      cycles: [{ id: 11 }],
      candidatesByCycle: { 11: [] },
      patchesByCandidate: {},
      messageFragment: 'Expected exactly 2 cycles',
    },
    {
      name: 'minimum cycle expectations',
      expectations: { minCycles: 1 },
      cycles: [],
      candidatesByCycle: {},
      patchesByCandidate: {},
      messageFragment: 'Expected at least 1 cycles',
    },
    {
      name: 'maximum cycle expectations',
      expectations: { maxCycles: 1 },
      cycles: [{ id: 11 }, { id: 12 }],
      candidatesByCycle: { 11: [], 12: [] },
      patchesByCandidate: {},
      messageFragment: 'Expected at most 1 cycles',
    },
    {
      name: 'classification expectations',
      expectations: { minClassifications: { autofix_extract_shared: 1 } },
      cycles: [{ id: 11 }],
      candidatesByCycle: { 11: [{ id: 111, classification: 'unsupported' }] },
      patchesByCandidate: { 111: [] },
      messageFragment: 'Expected at least 1 autofix_extract_shared candidates',
    },
    {
      name: 'patch expectations',
      expectations: { minPatches: 1 },
      cycles: [{ id: 11 }],
      candidatesByCycle: { 11: [{ id: 111, classification: 'autofix_extract_shared' }] },
      patchesByCandidate: { 111: [] },
      messageFragment: 'Expected at least 1 generated patches',
    },
  ])('reports expectation failures for $name', async ({
    expectations,
    cycles,
    candidatesByCycle,
    patchesByCandidate,
    messageFragment,
  }) => {
    const report = await runSmokeSuite(
      [
        {
          name: 'repo-four',
          target: '../repo-four',
          expectations,
        },
      ],
      {
        dependencies: {
          scanRepository: vi.fn().mockResolvedValue({
            scanId: 1,
            repoPath: TEST_REPO_FOUR_PATH,
            cyclesFound: cycles.length,
          }),
          getCyclesByScanId: () => cycles,
          getFixCandidatesByCycleId: (cycleId) => candidatesByCycle[cycleId] ?? [],
          getPatchesByFixCandidateId: (candidateId) => patchesByCandidate[candidateId] ?? [],
        },
      },
    );

    expect(report.results[0]).toMatchObject({
      status: 'failed',
      stage: 'expectation',
    });
    expect(report.results[0].message).toContain(messageFragment);
  });

  it('classifies clone failures as clone-stage failures', async () => {
    const report = await runSmokeSuite(
      [
        {
          name: 'dify',
          target: 'https://github.com/langgenius/dify.git',
        },
      ],
      {
        dependencies: {
          scanRepository: vi.fn().mockRejectedValue(new Error('Clone error')),
        },
      },
    );

    expect(report.results[0]).toMatchObject({
      status: 'failed',
      stage: 'clone',
      message: 'Clone error',
    });
  });

  it('passes fixtures without explicit expectations', async () => {
    const report = await runSmokeSuite(
      [
        {
          name: 'repo-three',
          target: '../repo-three',
        },
      ],
      {
        dependencies: {
          scanRepository: vi.fn().mockResolvedValue({
            scanId: 1,
            repoPath: TEST_REPO_THREE_PATH,
            cyclesFound: 1,
          }),
          getCyclesByScanId: () => [{ id: 11 }],
          getFixCandidatesByCycleId: () => [{ id: 111, classification: 'unsupported' }],
          getPatchesByFixCandidateId: () => [],
        },
      },
    );

    expect(report.results[0]).toMatchObject({
      status: 'passed',
      scanId: 1,
      cyclesFound: 1,
      candidateCount: 1,
      patchCount: 0,
    });
  });
});
