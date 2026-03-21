import fs from 'node:fs/promises';
import { getCyclesByScanId, getFixCandidatesByCycleId, getPatchesByFixCandidateId } from '../db/index.js';
import { scanRepository } from './scanner.js';

export interface SmokeFixtureExpectations {
  exactCycles?: number;
  minCycles?: number;
  maxCycles?: number;
  minClassifications?: Record<string, number>;
  minPatches?: number;
}

export interface SmokeFixture {
  name: string;
  target: string;
  expectations?: SmokeFixtureExpectations;
}

export type SmokeStage = 'clone' | 'scan' | 'validation' | 'expectation';

export interface SmokeFixtureResult {
  name: string;
  target: string;
  status: 'passed' | 'failed';
  stage?: SmokeStage;
  message?: string;
  scanId?: number;
  cyclesFound?: number;
  candidateCount?: number;
  patchCount?: number;
  classifications?: Record<string, number>;
}

export interface SmokeSuiteResult {
  results: SmokeFixtureResult[];
  passed: number;
  failed: number;
}

export interface SmokeSuiteOptions {
  worktreesDir?: string;
  dependencies?: SmokeSuiteDependencies;
}

export interface SmokeSuiteDependencies {
  scanRepository?: typeof scanRepository;
  getCyclesByScanId?: (scanId: number) => Array<{ id: number }>;
  getFixCandidatesByCycleId?: (cycleId: number) => Array<{ id: number; classification: string }>;
  getPatchesByFixCandidateId?: (candidateId: number) => Array<unknown>;
}

interface SmokeMetrics {
  cyclesFound: number;
  candidateCount: number;
  patchCount: number;
  classifications: Record<string, number>;
}

export async function loadSmokeFixtures(fixturesPath: string): Promise<SmokeFixture[]> {
  const contents = await fs.readFile(fixturesPath, 'utf8');
  const parsed = JSON.parse(contents) as unknown;

  if (!Array.isArray(parsed)) {
    throw new TypeError(`Smoke fixture file must contain an array: ${fixturesPath}`);
  }

  return parsed.map((item, index) => normalizeSmokeFixture(item, fixturesPath, index));
}

export async function runSmokeSuite(
  fixtures: SmokeFixture[],
  options: SmokeSuiteOptions = {},
): Promise<SmokeSuiteResult> {
  const worktreesDir = options.worktreesDir ?? './worktrees/smoke';
  const dependencies = options.dependencies;
  const results: SmokeFixtureResult[] = [];

  for (const fixture of fixtures) {
    results.push(await runSmokeFixture(fixture, worktreesDir, dependencies));
  }

  return {
    results,
    passed: results.filter((result) => result.status === 'passed').length,
    failed: results.filter((result) => result.status === 'failed').length,
  };
}

export function formatSmokeSuiteResult(result: SmokeSuiteResult): string {
  const lines = result.results.map((fixtureResult) => {
    if (fixtureResult.status === 'passed') {
      const summary = [
        `${fixtureResult.cyclesFound ?? 0} cycles`,
        `${fixtureResult.candidateCount ?? 0} candidates`,
        `${fixtureResult.patchCount ?? 0} patches`,
      ].join(', ');
      const classifications = formatClassificationCounts(fixtureResult.classifications);
      const classificationSuffix = classifications ? ` (${classifications})` : '';
      return `PASS ${fixtureResult.name}: ${summary}${classificationSuffix}`;
    }

    return `FAIL ${fixtureResult.name} [${fixtureResult.stage ?? 'scan'}]: ${fixtureResult.message ?? 'Unknown failure'}`;
  });

  lines.push(`Smoke suite complete: ${result.passed} passed, ${result.failed} failed.`);
  return lines.join('\n');
}

async function runSmokeFixture(
  fixture: SmokeFixture,
  worktreesDir: string,
  dependencies: SmokeSuiteDependencies | undefined,
): Promise<SmokeFixtureResult> {
  const runScan = dependencies?.scanRepository ?? scanRepository;

  try {
    const scanResult = await runScan(fixture.target, worktreesDir);
    const metrics = collectSmokeMetrics(scanResult.scanId, dependencies);
    const failureMessage = evaluateSmokeExpectations(fixture.expectations, metrics);

    if (failureMessage) {
      return {
        name: fixture.name,
        target: fixture.target,
        status: 'failed',
        stage: 'expectation',
        message: failureMessage,
        scanId: scanResult.scanId,
        ...metrics,
      };
    }

    return {
      name: fixture.name,
      target: fixture.target,
      status: 'passed',
      scanId: scanResult.scanId,
      ...metrics,
    };
  } catch (error) {
    return {
      name: fixture.name,
      target: fixture.target,
      status: 'failed',
      stage: inferFailureStage(error),
      message: getErrorMessage(error),
    };
  }
}

function collectSmokeMetrics(scanId: number, dependencies: SmokeSuiteDependencies | undefined): SmokeMetrics {
  const listCycles =
    dependencies?.getCyclesByScanId ??
    ((currentScanId: number) => getCyclesByScanId.all(currentScanId) as Array<{ id: number }>);
  const listCandidates =
    dependencies?.getFixCandidatesByCycleId ??
    ((cycleId: number) => getFixCandidatesByCycleId.all(cycleId) as Array<{ id: number; classification: string }>);
  const listPatches =
    dependencies?.getPatchesByFixCandidateId ??
    ((candidateId: number) => getPatchesByFixCandidateId.all(candidateId) as Array<unknown>);

  const cycles = listCycles(scanId);
  const classifications: Record<string, number> = {};
  let candidateCount = 0;
  let patchCount = 0;

  for (const cycle of cycles) {
    const candidates = listCandidates(cycle.id);
    candidateCount += candidates.length;

    for (const candidate of candidates) {
      classifications[candidate.classification] = (classifications[candidate.classification] ?? 0) + 1;
      patchCount += listPatches(candidate.id).length;
    }
  }

  return {
    cyclesFound: cycles.length,
    candidateCount,
    patchCount,
    classifications,
  };
}

function evaluateSmokeExpectations(
  expectations: SmokeFixtureExpectations | undefined,
  metrics: SmokeMetrics,
): string | null {
  if (!expectations) {
    return null;
  }

  if (typeof expectations.exactCycles === 'number' && metrics.cyclesFound !== expectations.exactCycles) {
    return `Expected exactly ${expectations.exactCycles} cycles, found ${metrics.cyclesFound}.`;
  }

  if (typeof expectations.minCycles === 'number' && metrics.cyclesFound < expectations.minCycles) {
    return `Expected at least ${expectations.minCycles} cycles, found ${metrics.cyclesFound}.`;
  }

  if (typeof expectations.maxCycles === 'number' && metrics.cyclesFound > expectations.maxCycles) {
    return `Expected at most ${expectations.maxCycles} cycles, found ${metrics.cyclesFound}.`;
  }

  if (expectations.minClassifications) {
    for (const [classification, minimum] of Object.entries(expectations.minClassifications)) {
      const found = metrics.classifications[classification] ?? 0;
      if (found < minimum) {
        return `Expected at least ${minimum} ${classification} candidates, found ${found}.`;
      }
    }
  }

  if (typeof expectations.minPatches === 'number' && metrics.patchCount < expectations.minPatches) {
    return `Expected at least ${expectations.minPatches} generated patches, found ${metrics.patchCount}.`;
  }

  return null;
}

function inferFailureStage(error: unknown): SmokeStage {
  const message = getErrorMessage(error).toLowerCase();

  if (message.includes('validation') || message.includes('typescript') || message.includes('tsc')) {
    return 'validation';
  }

  if (message.includes('clone') || message.includes('fetch') || message.includes('download')) {
    return 'clone';
  }

  return 'scan';
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === 'string' ? error : 'Unknown smoke suite failure';
}

function normalizeSmokeFixture(item: unknown, fixturesPath: string, index: number): SmokeFixture {
  if (!item || typeof item !== 'object') {
    throw new TypeError(`Smoke fixture ${index + 1} in ${fixturesPath} must be an object.`);
  }

  const fixture = item as Record<string, unknown>;
  if (typeof fixture.name !== 'string' || typeof fixture.target !== 'string') {
    throw new TypeError(`Smoke fixture ${index + 1} in ${fixturesPath} must include string name and target fields.`);
  }

  return {
    name: fixture.name,
    target: fixture.target,
    expectations: normalizeExpectations(fixture.expectations, fixturesPath, index),
  };
}

function normalizeExpectations(
  value: unknown,
  fixturesPath: string,
  index: number,
): SmokeFixtureExpectations | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!value || typeof value !== 'object') {
    throw new TypeError(`Smoke fixture ${index + 1} in ${fixturesPath} has an invalid expectations block.`);
  }

  const expectations = value as Record<string, unknown>;
  const minClassifications = expectations.minClassifications;
  if (minClassifications !== undefined && (!minClassifications || typeof minClassifications !== 'object')) {
    throw new TypeError(`Smoke fixture ${index + 1} in ${fixturesPath} has invalid minClassifications.`);
  }

  return {
    exactCycles: asOptionalNumber(expectations.exactCycles),
    minCycles: asOptionalNumber(expectations.minCycles),
    maxCycles: asOptionalNumber(expectations.maxCycles),
    minClassifications: minClassifications as Record<string, number> | undefined,
    minPatches: asOptionalNumber(expectations.minPatches),
  };
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function formatClassificationCounts(classifications: Record<string, number> | undefined): string {
  if (!classifications || Object.keys(classifications).length === 0) {
    return '';
  }

  const sortedEntries: Array<[string, number]> = [];
  for (const entry of Object.entries(classifications)) {
    const insertionIndex = sortedEntries.findIndex(([existingClassification]) => {
      return entry[0].localeCompare(existingClassification) < 0;
    });

    if (insertionIndex === -1) {
      sortedEntries.push(entry);
      continue;
    }

    sortedEntries.splice(insertionIndex, 0, entry);
  }

  return sortedEntries.map(([classification, count]) => `${classification}:${count}`).join(', ');
}
