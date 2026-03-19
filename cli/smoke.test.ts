import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as dbModule from '../db/index.js';
import { scanRepository } from './scanner.js';
import { formatSmokeSuiteResult, loadSmokeFixtures, runSmokeSuite } from './smoke.js';

vi.mock('./scanner.js', () => ({
  scanRepository: vi.fn(),
}));

vi.mock('../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../db/index.js')>('../db/index.js');
  return {
    ...actual,
    getCyclesByScanId: {
      all: vi.fn(),
    },
    getFixCandidatesByCycleId: {
      all: vi.fn(),
    },
    getPatchesByFixCandidateId: {
      all: vi.fn(),
    },
  };
});

describe('smoke suite', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  function mockMetrics(
    cycles: Array<{ id: number }>,
    candidatesByCycle: Record<number, Array<{ id: number; classification: string }>>,
    patchesByCandidate: Record<number, Array<{ id: number }>>,
  ): void {
    vi.mocked(dbModule.getCyclesByScanId.all).mockImplementation((scanId: number) => (scanId === 1 ? cycles : []));
    vi.mocked(dbModule.getFixCandidatesByCycleId.all).mockImplementation((cycleId: number) => candidatesByCycle[cycleId] ?? []);
    vi.mocked(dbModule.getPatchesByFixCandidateId.all).mockImplementation((candidateId: number) => patchesByCandidate[candidateId] ?? []);
  }

  it('loads smoke fixtures from JSON', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smoke-fixtures-'));
    const fixturePath = path.join(tmpDir, 'fixtures.json');
    await fs.writeFile(
      fixturePath,
      JSON.stringify([
        {
          name: 'openclaw',
          target: '../openclaw',
          expectations: {
            minCycles: 1,
          },
        },
      ]),
      'utf8',
    );

    const fixtures = await loadSmokeFixtures(fixturePath);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0]).toMatchObject({
      name: 'openclaw',
      target: '../openclaw',
      expectations: {
        minCycles: 1,
      },
    });
  });

  it('loads smoke fixtures without expectations', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smoke-fixtures-'));
    const fixturePath = path.join(tmpDir, 'fixtures.json');
    await fs.writeFile(
      fixturePath,
      JSON.stringify([
        {
          name: 'jan',
          target: 'https://github.com/janhq/jan.git',
        },
      ]),
      'utf8',
    );

    const fixtures = await loadSmokeFixtures(fixturePath);
    expect(fixtures[0]).toMatchObject({
      name: 'jan',
      target: 'https://github.com/janhq/jan.git',
    });
    expect(fixtures[0].expectations).toBeUndefined();
  });

  it('rejects fixture files that are not arrays', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smoke-fixtures-'));
    const fixturePath = path.join(tmpDir, 'fixtures.json');
    await fs.writeFile(fixturePath, JSON.stringify({ name: 'invalid' }), 'utf8');

    await expect(loadSmokeFixtures(fixturePath)).rejects.toThrow('must contain an array');
  });

  it('rejects fixture entries that are not objects', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smoke-fixtures-'));
    const fixturePath = path.join(tmpDir, 'fixtures.json');
    await fs.writeFile(fixturePath, JSON.stringify([null]), 'utf8');

    await expect(loadSmokeFixtures(fixturePath)).rejects.toThrow('must be an object');
  });

  it('rejects fixture entries without name and target fields', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smoke-fixtures-'));
    const fixturePath = path.join(tmpDir, 'fixtures.json');
    await fs.writeFile(fixturePath, JSON.stringify([{ name: 'missing-target' }]), 'utf8');

    await expect(loadSmokeFixtures(fixturePath)).rejects.toThrow('must include string name and target fields');
  });

  it('rejects invalid expectation blocks', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smoke-fixtures-'));
    const fixturePath = path.join(tmpDir, 'fixtures.json');
    await fs.writeFile(
      fixturePath,
      JSON.stringify([
        {
          name: 'broken',
          target: '../broken',
          expectations: 42,
        },
      ]),
      'utf8',
    );

    await expect(loadSmokeFixtures(fixturePath)).rejects.toThrow('invalid expectations block');
  });

  it('rejects invalid minClassifications blocks', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smoke-fixtures-'));
    const fixturePath = path.join(tmpDir, 'fixtures.json');
    await fs.writeFile(
      fixturePath,
      JSON.stringify([
        {
          name: 'broken',
          target: '../broken',
          expectations: {
            minClassifications: 42,
          },
        },
      ]),
      'utf8',
    );

    await expect(loadSmokeFixtures(fixturePath)).rejects.toThrow('invalid minClassifications');
  });

  it('reports pass and expectation failure results', async () => {
    vi.mocked(scanRepository).mockResolvedValueOnce({
      scanId: 1,
      repoPath: '/tmp/repo-one',
      cyclesFound: 2,
    });
    vi.mocked(scanRepository).mockRejectedValueOnce(new Error('Validation failed: the original cycle is still present.'));

    mockMetrics(
      [{ id: 11 }, { id: 12 }],
      {
        11: [
          { id: 111, classification: 'autofix_extract_shared' },
          { id: 112, classification: 'unsupported' },
        ],
        12: [{ id: 121, classification: 'autofix_extract_shared' }],
      },
      {
        111: [{ id: 1 }],
      },
    );

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
      './worktrees/smoke',
    );

    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.results[0]).toMatchObject({
      name: 'repo-one',
      status: 'passed',
      cyclesFound: 2,
      candidateCount: 3,
      patchCount: 1,
    });
    expect(report.results[1]).toMatchObject({
      name: 'repo-two',
      status: 'failed',
      stage: 'validation',
      message: 'Validation failed: the original cycle is still present.',
    });
    expect(formatSmokeSuiteResult(report)).toContain('PASS repo-one');
  });

  it('passes fixtures without explicit expectations', async () => {
    vi.mocked(scanRepository).mockResolvedValueOnce({
      scanId: 1,
      repoPath: '/tmp/repo-three',
      cyclesFound: 1,
    });
    mockMetrics([{ id: 11 }], { 11: [{ id: 111, classification: 'unsupported' }] }, { 111: [] });

    const report = await runSmokeSuite([
      {
        name: 'repo-three',
        target: '../repo-three',
      },
    ]);

    expect(report.results[0]).toMatchObject({
      status: 'passed',
      scanId: 1,
      cyclesFound: 1,
      candidateCount: 1,
      patchCount: 0,
    });
  });

  it.each([
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
  ])('reports $name', async ({ expectations, cycles, candidatesByCycle, patchesByCandidate, messageFragment }) => {
    vi.mocked(scanRepository).mockResolvedValueOnce({
      scanId: 1,
      repoPath: '/tmp/repo-four',
      cyclesFound: cycles.length,
    });
    mockMetrics(cycles, candidatesByCycle, patchesByCandidate);

    const report = await runSmokeSuite([
      {
        name: 'repo-four',
        target: '../repo-four',
        expectations,
      },
    ]);

    expect(report.results[0]).toMatchObject({
      status: 'failed',
      stage: 'expectation',
    });
    expect(report.results[0].message).toContain(messageFragment);
  });

  it('classifies clone failures as clone stage failures', async () => {
    vi.mocked(scanRepository).mockRejectedValueOnce(new Error('Clone error'));

    const report = await runSmokeSuite([
      {
        name: 'dify',
        target: 'https://github.com/langgenius/dify.git',
      },
    ]);

    expect(report.results[0]).toMatchObject({
      status: 'failed',
      stage: 'clone',
      message: 'Clone error',
    });
  });

  it('classifies generic failures as scan-stage failures', async () => {
    vi.mocked(scanRepository).mockRejectedValueOnce(new Error('Something broke during scan'));

    const report = await runSmokeSuite([
      {
        name: 'repo-five',
        target: '../repo-five',
      },
    ]);

    expect(report.results[0]).toMatchObject({
      status: 'failed',
      stage: 'scan',
    });
    expect(report.results[0].message).toContain('Something broke during scan');
  });

  it('treats non-error scan failures as unknown smoke suite failures', async () => {
    vi.mocked(scanRepository).mockRejectedValueOnce({ code: 1 });

    const report = await runSmokeSuite([
      {
        name: 'repo-six',
        target: '../repo-six',
      },
    ]);

    expect(report.results[0]).toMatchObject({
      status: 'failed',
      stage: 'scan',
      message: 'Unknown smoke suite failure',
    });
  });

  it('formats passed results without classification counts', () => {
    const output = formatSmokeSuiteResult({
      passed: 1,
      failed: 0,
      results: [
        {
          name: 'repo-six',
          target: '../repo-six',
          status: 'passed',
          cyclesFound: 0,
          candidateCount: 0,
          patchCount: 0,
        },
      ],
    });

    expect(output).toContain('PASS repo-six: 0 cycles, 0 candidates, 0 patches');
    expect(output).not.toContain('(');
  });

  it('formats passed results with omitted counts as zero', () => {
    const output = formatSmokeSuiteResult({
      passed: 1,
      failed: 0,
      results: [
        {
          name: 'repo-seven',
          target: '../repo-seven',
          status: 'passed',
        } as SmokeFixtureResult,
      ],
    });

    expect(output).toContain('PASS repo-seven: 0 cycles, 0 candidates, 0 patches');
  });

  it('formats failed results without a stage as scan failures', () => {
    const output = formatSmokeSuiteResult({
      passed: 0,
      failed: 1,
      results: [
        {
          name: 'repo-eight',
          target: '../repo-eight',
          status: 'failed',
        } as SmokeFixtureResult,
      ],
    });

    expect(output).toContain('FAIL repo-eight [scan]: Unknown failure');
  });
});
