import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SemanticAnalyzer } from './semantic.js';

vi.mock('node:fs', () => {
  return {
    default: {
      existsSync: vi.fn(),
    },
  };
});

describe('SemanticAnalyzer', () => {
  let analyzer: SemanticAnalyzer;

  beforeEach(() => {
    vi.resetAllMocks();
    analyzer = new SemanticAnalyzer('/dummy/repo');
  });

  it('rejects cycles with more than 2 unique files', () => {
    const result = analyzer.analyzeCycle(['a.ts', 'b.ts', 'c.ts', 'a.ts']);
    expect(result.classification).toBe('unsupported');
    expect(result.reasons[0]).toMatch(/Only two-file cycles/);
    expect(result.planner).toMatchObject({
      cycleShape: 'multi_file',
      selectedStrategy: undefined,
    });
    expect(result.planner?.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ strategy: 'import_type', status: 'not_applicable' }),
        expect.objectContaining({ strategy: 'direct_import', status: 'rejected' }),
        expect.objectContaining({ strategy: 'extract_shared', status: 'not_applicable' }),
      ]),
    );
  });

  it('rejects cycles where files cannot be read', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = analyzer.analyzeCycle(['a.ts', 'b.ts', 'a.ts']);
    expect(result.classification).toBe('unsupported');
    expect(result.reasons[0]).toMatch(/could not be read/);
    expect(result.planner).toMatchObject({
      cycleShape: 'two_file',
      selectedStrategy: undefined,
    });
    expect(result.planner?.cycleSignals.missingFiles).toBe(2);
  });

  it('detects type-only cycles', () => {
    analyzer.project.createSourceFile(
      '/dummy/repo/a.ts',
      `
      import { BType } from './b';
      export interface AType { a: string; }
      export const useB = (arg: BType) => console.log(arg);
    `,
    );
    analyzer.project.createSourceFile(
      '/dummy/repo/b.ts',
      `
      import { AType } from './a';
      export interface BType { b: string; a: AType; }
    `,
    );

    const result = analyzer.analyzeCycle(['a.ts', 'b.ts', 'a.ts']);
    expect(result.classification).toBe('autofix_import_type');
    expect(result.reasons[0]).toMatch(/converting concrete imports to type-only/);
    expect(result.upstreamabilityScore).toBe(0.94);
    expect(result.planner).toMatchObject({
      cycleShape: 'two_file',
      selectedStrategy: 'import_type',
      selectedClassification: 'autofix_import_type',
      selectedScore: 0.94,
      features: {
        cycleSize: 2,
        cycleShape: 'two_file',
        explicitImportEdges: 2,
        loadedFiles: 2,
        missingFiles: 0,
      },
    });
    expect(result.planner?.rankedCandidates[0]?.strategy).toBe('import_type');
    expect(result.planner?.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          strategy: 'import_type',
          status: 'candidate',
          signals: expect.objectContaining({
            importEdges: 2,
            introducesNewFile: false,
          }),
        }),
        expect.objectContaining({ strategy: 'direct_import', status: 'not_applicable' }),
      ]),
    );
    expect(result.plan).toEqual({
      kind: 'import_type',
      imports: [
        { sourceFile: 'a.ts', targetFile: 'b.ts' },
        { sourceFile: 'b.ts', targetFile: 'a.ts' },
      ],
    });
  });

  it('detects extract_shared for top-level functions', () => {
    analyzer.project.createSourceFile(
      '/dummy/repo/a.ts',
      `
      import { helperB } from './b';
      export const mainA = () => helperB();
    `,
    );
    analyzer.project.createSourceFile(
      '/dummy/repo/b.ts',
      `
      import { mainA } from './a';
      export const helperB = () => console.log("B");
      export const sideEffectB = () => mainA();
    `,
    );

    const result = analyzer.analyzeCycle(['a.ts', 'b.ts', 'a.ts']);
    expect(result.classification).toBe('autofix_extract_shared');
    expect(result.reasons[0]).toMatch(/helperB/);
    expect(result.reasons[0]).toMatch(/helperB\.shared\.ts/);
    expect(result.planner).toMatchObject({
      cycleShape: 'two_file',
      selectedStrategy: 'extract_shared',
      selectedClassification: 'autofix_extract_shared',
    });
    expect(result.planner?.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          strategy: 'extract_shared',
          status: 'candidate',
          signals: expect.objectContaining({
            introducesNewFile: true,
            preservesSourceExports: true,
            sharedFile: 'helperB.shared.ts',
          }),
        }),
      ]),
    );
    expect(result.plan).toEqual({
      kind: 'extract_shared',
      sourceFile: 'b.ts',
      targetFile: 'a.ts',
      symbols: ['helperB'],
      sharedFile: 'helperB.shared.ts',
      preserveSourceExports: true,
    });
  });

  it('avoids colliding with an existing shared module path', () => {
    analyzer.project.createSourceFile(
      '/dummy/repo/a.ts',
      `
      import { helperB } from './b';
      export const mainA = () => helperB();
    `,
    );
    analyzer.project.createSourceFile(
      '/dummy/repo/b.ts',
      `
      import { mainA } from './a';
      export const helperB = () => console.log("B");
      export const sideEffectB = () => mainA();
    `,
    );
    analyzer.project.createSourceFile('/dummy/repo/helperB.shared.ts', 'export const alreadyThere = true;');

    const result = analyzer.analyzeCycle(['a.ts', 'b.ts', 'a.ts']);

    expect(result.classification).toBe('autofix_extract_shared');
    expect(result.plan).toEqual({
      kind: 'extract_shared',
      sourceFile: 'b.ts',
      targetFile: 'a.ts',
      symbols: ['helperB'],
      sharedFile: 'b-a.shared.ts',
      preserveSourceExports: true,
    });
  });

  it('detects direct_import for safe barrel re-exports', () => {
    analyzer.project.createSourceFile(
      '/dummy/repo/app.ts',
      `
      import { Foo } from './index';
      export const appValue = Foo + 1;
    `,
    );
    analyzer.project.createSourceFile(
      '/dummy/repo/index.ts',
      `
      export { Foo } from './foo';
      export { Bar } from './bar';
    `,
    );
    analyzer.project.createSourceFile('/dummy/repo/foo.ts', 'export const Foo = 1;');
    analyzer.project.createSourceFile(
      '/dummy/repo/bar.ts',
      `
      import { appValue } from './app';
      export const Bar = appValue + 1;
    `,
    );

    const result = analyzer.analyzeCycle(['app.ts', 'index.ts', 'bar.ts', 'app.ts']);
    expect(result.classification).toBe('autofix_direct_import');
    expect(result.planner).toMatchObject({
      cycleShape: 'multi_file',
      selectedStrategy: 'direct_import',
      selectedClassification: 'autofix_direct_import',
      selectedScore: 0.9,
      graphSummary: {
        metrics: {
          barrelModuleCount: 1,
          exportEdgeCount: 2,
        },
      },
    });
    expect(result.plan).toEqual({
      kind: 'direct_import',
      imports: [
        {
          sourceFile: 'app.ts',
          barrelFile: 'index.ts',
          targetFile: 'foo.ts',
          symbols: ['Foo'],
        },
      ],
    });
  });

  it('detects direct_import for mixed public API seams that re-export a safe leaf symbol', () => {
    analyzer.project.createSourceFile(
      '/dummy/repo/app.ts',
      `
      import { Foo } from './api';
      export const appValue = Foo + 1;
    `,
    );
    analyzer.project.createSourceFile(
      '/dummy/repo/api.ts',
      `
      export { Foo } from './foo';
      export { Bar } from './bar';
      export const apiVersion = '1';
    `,
    );
    analyzer.project.createSourceFile('/dummy/repo/foo.ts', 'export const Foo = 1;');
    analyzer.project.createSourceFile(
      '/dummy/repo/bar.ts',
      `
      import { appValue } from './app';
      export const Bar = appValue + 1;
    `,
    );

    const result = analyzer.analyzeCycle(['app.ts', 'api.ts', 'bar.ts', 'app.ts']);

    expect(result.classification).toBe('autofix_direct_import');
    expect(result.planner?.selectedStrategy).toBe('direct_import');
    expect(result.planner?.rankedCandidates[0]?.signals).toMatchObject({
      bypassesBarrel: true,
      bypassesPublicSeam: true,
    });
    expect(result.plan).toEqual({
      kind: 'direct_import',
      imports: [
        {
          sourceFile: 'app.ts',
          barrelFile: 'api.ts',
          targetFile: 'foo.ts',
          symbols: ['Foo'],
        },
      ],
    });
  });

  it('adjusts candidate scoring with historical evidence and repository features', () => {
    analyzer = new SemanticAnalyzer('/dummy/repo', {
      repositoryProfile: {
        packageManager: 'pnpm',
        workspaceMode: 'workspace',
        validationCommandCount: 4,
      },
      historicalEvidence: {
        totalBenchmarkCases: 6,
        totalAcceptanceBenchmarkCases: 2,
        totalReviewedPatches: 4,
        totalValidatedPatches: 4,
        strategies: {
          import_type: {
            benchmarkMatches: 0,
            profileMatches: 0,
            approvedReviews: 0,
            rejectedReviews: 0,
            prCandidates: 0,
            ignoredReviews: 0,
            passedValidations: 0,
            failedValidations: 0,
            acceptedBenchmarks: 0,
            rejectedBenchmarks: 0,
            needsReviewBenchmarks: 0,
            acceptanceProfileMatches: 0,
            semanticWrongRejections: 0,
            repoConventionsMismatchRejections: 0,
            diffNoisyRejections: 0,
            validationWeakRejections: 0,
            otherRejections: 0,
            originalCyclePersistedFailures: 0,
            newCyclesIntroducedFailures: 0,
            repoValidationFailures: 0,
            typecheckFailures: 0,
          },
          direct_import: {
            benchmarkMatches: 4,
            profileMatches: 2,
            approvedReviews: 3,
            rejectedReviews: 0,
            prCandidates: 1,
            ignoredReviews: 0,
            passedValidations: 4,
            failedValidations: 0,
            acceptedBenchmarks: 2,
            rejectedBenchmarks: 0,
            needsReviewBenchmarks: 0,
            acceptanceProfileMatches: 2,
            semanticWrongRejections: 0,
            repoConventionsMismatchRejections: 0,
            diffNoisyRejections: 0,
            validationWeakRejections: 0,
            otherRejections: 0,
            originalCyclePersistedFailures: 0,
            newCyclesIntroducedFailures: 0,
            repoValidationFailures: 0,
            typecheckFailures: 0,
          },
          extract_shared: {
            benchmarkMatches: 0,
            profileMatches: 0,
            approvedReviews: 0,
            rejectedReviews: 0,
            prCandidates: 0,
            ignoredReviews: 0,
            passedValidations: 0,
            failedValidations: 0,
            acceptedBenchmarks: 0,
            rejectedBenchmarks: 0,
            needsReviewBenchmarks: 0,
            acceptanceProfileMatches: 0,
            semanticWrongRejections: 0,
            repoConventionsMismatchRejections: 0,
            diffNoisyRejections: 0,
            validationWeakRejections: 0,
            otherRejections: 0,
            originalCyclePersistedFailures: 0,
            newCyclesIntroducedFailures: 0,
            repoValidationFailures: 0,
            typecheckFailures: 0,
          },
          host_state_update: {
            benchmarkMatches: 0,
            profileMatches: 0,
            approvedReviews: 0,
            rejectedReviews: 0,
            prCandidates: 0,
            ignoredReviews: 0,
            passedValidations: 0,
            failedValidations: 0,
            acceptedBenchmarks: 0,
            rejectedBenchmarks: 0,
            needsReviewBenchmarks: 0,
            acceptanceProfileMatches: 0,
            semanticWrongRejections: 0,
            repoConventionsMismatchRejections: 0,
            diffNoisyRejections: 0,
            validationWeakRejections: 0,
            otherRejections: 0,
            originalCyclePersistedFailures: 0,
            newCyclesIntroducedFailures: 0,
            repoValidationFailures: 0,
            typecheckFailures: 0,
          },
        },
      },
    });

    analyzer.project.createSourceFile(
      '/dummy/repo/app.ts',
      `
      import { Foo } from './index';
      export const appValue = Foo + 1;
    `,
    );
    analyzer.project.createSourceFile(
      '/dummy/repo/index.ts',
      `
      export { Foo } from './foo';
      export { Bar } from './bar';
    `,
    );
    analyzer.project.createSourceFile('/dummy/repo/foo.ts', 'export const Foo = 1;');
    analyzer.project.createSourceFile(
      '/dummy/repo/bar.ts',
      `
      import { appValue } from './app';
      export const Bar = appValue + 1;
    `,
    );

    const result = analyzer.analyzeCycle(['app.ts', 'index.ts', 'bar.ts', 'app.ts']);

    expect(result.classification).toBe('autofix_direct_import');
    expect(result.upstreamabilityScore).toBeGreaterThan(0.89);
    expect(result.planner).toMatchObject({
      features: {
        hasBarrelFile: true,
        packageManager: 'pnpm',
        workspaceMode: 'workspace',
        validationCommandCount: 4,
      },
    });
    expect(result.planner?.rankedCandidates[0]?.signals).toMatchObject({
      historicalBenchmarkMatches: 4,
      historicalProfileMatches: 2,
      historicalAcceptanceBenchmarks: 2,
      historicalReviewedPatches: 4,
      historicalValidatedPatches: 4,
    });
    expect(result.planner?.rankedCandidates[0]?.scoreBreakdown).toEqual(
      expect.arrayContaining([
        expect.stringContaining('matching benchmark case'),
        expect.stringContaining('acceptance benchmark outcomes'),
        expect.stringContaining('review outcomes'),
        expect.stringContaining('validation history'),
      ]),
    );
  });

  it('penalizes extract_shared when acceptance and replay evidence show fragile outcomes', () => {
    analyzer = new SemanticAnalyzer('/dummy/repo', {
      repositoryProfile: {
        packageManager: 'pnpm',
        workspaceMode: 'workspace',
        validationCommandCount: 5,
      },
      historicalEvidence: {
        totalBenchmarkCases: 0,
        totalAcceptanceBenchmarkCases: 5,
        totalReviewedPatches: 2,
        totalValidatedPatches: 3,
        strategies: {
          import_type: {
            benchmarkMatches: 0,
            profileMatches: 0,
            approvedReviews: 0,
            rejectedReviews: 0,
            prCandidates: 0,
            ignoredReviews: 0,
            passedValidations: 0,
            failedValidations: 0,
          },
          direct_import: {
            benchmarkMatches: 0,
            profileMatches: 0,
            approvedReviews: 0,
            rejectedReviews: 0,
            prCandidates: 0,
            ignoredReviews: 0,
            passedValidations: 0,
            failedValidations: 0,
          },
          extract_shared: {
            benchmarkMatches: 0,
            profileMatches: 0,
            approvedReviews: 0,
            rejectedReviews: 2,
            prCandidates: 0,
            ignoredReviews: 0,
            passedValidations: 1,
            failedValidations: 2,
            rejectedBenchmarks: 3,
            acceptedBenchmarks: 0,
            needsReviewBenchmarks: 0,
            acceptanceProfileMatches: 2,
            diffNoisyRejections: 1,
            repoConventionsMismatchRejections: 1,
            semanticWrongRejections: 1,
            validationWeakRejections: 1,
            newCyclesIntroducedFailures: 1,
            repoValidationFailures: 1,
            originalCyclePersistedFailures: 0,
            typecheckFailures: 0,
            otherRejections: 0,
          },
          host_state_update: {
            benchmarkMatches: 0,
            profileMatches: 0,
            approvedReviews: 0,
            rejectedReviews: 0,
            prCandidates: 0,
            ignoredReviews: 0,
            passedValidations: 0,
            failedValidations: 0,
          },
        },
      },
    });

    analyzer.project.createSourceFile(
      '/dummy/repo/a.ts',
      `
      import { helperB } from './b';
      export const mainA = () => helperB();
    `,
    );
    analyzer.project.createSourceFile(
      '/dummy/repo/b.ts',
      `
      import { mainA } from './a';
      export const helperB = () => console.log("B");
      export const sideEffectB = () => mainA();
    `,
    );

    const result = analyzer.analyzeCycle(['a.ts', 'b.ts', 'a.ts']);

    expect(result.classification).toBe('autofix_extract_shared');
    expect(result.upstreamabilityScore).toBeLessThan(0.75);
    expect(result.planner?.rankedCandidates[0]?.scoreBreakdown).toEqual(
      expect.arrayContaining([
        expect.stringContaining('acceptance benchmark outcomes'),
        expect.stringContaining('semantically wrong'),
        expect.stringContaining('noisy diffs'),
        expect.stringContaining('preserved or introduced cycles'),
        expect.stringContaining('repo validation or typecheck failed'),
      ]),
    );
  });

  it('detects host_state_update for thin imported setters on caller-owned state', () => {
    analyzer.project.createSourceFile(
      '/dummy/repo/a.ts',
      `
      import { setLastActiveSessionKey } from './b';
      export const runA = (host: unknown) => setLastActiveSessionKey(host, ' next ');
    `,
    );
    analyzer.project.createSourceFile(
      '/dummy/repo/b.ts',
      `
      import { runA } from './a';
      import { saveSettings } from './storage';

      export function applySettings(host: { settings: { lastActiveSessionKey: string }; applySessionKey: string }, next: { lastActiveSessionKey: string }) {
        host.settings = next;
        saveSettings(next);
        host.applySessionKey = host.settings.lastActiveSessionKey;
      }

      export function setLastActiveSessionKey(host: { settings: { lastActiveSessionKey: string }; applySessionKey: string }, next: string) {
        const trimmed = next.trim();
        if (!trimmed) {
          return;
        }
        if (host.settings.lastActiveSessionKey === trimmed) {
          return;
        }
        applySettings(host, { ...host.settings, lastActiveSessionKey: trimmed });
      }

      export const runB = () => runA({ settings: { lastActiveSessionKey: 'main' }, applySessionKey: 'main' });
    `,
    );
    analyzer.project.createSourceFile('/dummy/repo/storage.ts', 'export function saveSettings(_next: unknown) {}\n');

    const result = analyzer.analyzeCycle(['a.ts', 'b.ts', 'a.ts']);

    expect(result.classification).toBe('autofix_host_state_update');
    expect(result.upstreamabilityScore).toBe(0.89);
    expect(result.planner).toMatchObject({
      cycleShape: 'two_file',
      selectedStrategy: 'host_state_update',
      selectedClassification: 'autofix_host_state_update',
      selectedScore: 0.89,
    });
    expect(result.plan).toEqual({
      kind: 'host_state_update',
      sourceFile: 'a.ts',
      targetFile: 'b.ts',
      importedFunction: 'setLastActiveSessionKey',
      persistenceModule: 'storage.ts',
      persistenceModuleKind: 'repo_file',
      persistenceFunction: 'saveSettings',
      stateObjectProperty: 'settings',
      updatedProperty: 'lastActiveSessionKey',
      mirrorHostProperty: 'applySessionKey',
      trimValue: true,
    });
  });

  it('prefers host_state_update over extract_shared when the setter helper has unrelated side effects', () => {
    analyzer.project.createSourceFile(
      '/dummy/repo/a.ts',
      `
      import { setLastActiveSessionKey } from './b';
      export const runA = (host: unknown) => setLastActiveSessionKey(host, ' next ');
    `,
    );
    analyzer.project.createSourceFile(
      '/dummy/repo/b.ts',
      `
      import { runA } from './a';
      import { saveSettings } from './storage';

      function applyResolvedTheme(_host: unknown, _theme: string) {}
      function applyBorderRadius(_radius: number) {}

      export function applySettings(
        host: {
          settings: { lastActiveSessionKey: string; sessionKey: string; theme: string; themeMode: string; borderRadius: number };
          applySessionKey: string;
          theme: string;
          themeMode: string;
        },
        next: { lastActiveSessionKey: string; sessionKey: string; theme: string; themeMode: string; borderRadius: number },
      ) {
        const normalized = {
          ...next,
          lastActiveSessionKey: next.lastActiveSessionKey?.trim() || next.sessionKey.trim() || 'main',
        };
        host.settings = normalized;
        saveSettings(normalized);
        if (next.theme !== host.theme || next.themeMode !== host.themeMode) {
          host.theme = next.theme;
          host.themeMode = next.themeMode;
          applyResolvedTheme(host, next.theme);
        }
        applyBorderRadius(next.borderRadius);
        host.applySessionKey = host.settings.lastActiveSessionKey;
      }

      export function setLastActiveSessionKey(
        host: {
          settings: { lastActiveSessionKey: string; sessionKey: string; theme: string; themeMode: string; borderRadius: number };
          applySessionKey: string;
          theme: string;
          themeMode: string;
        },
        next: string,
      ) {
        const trimmed = next.trim();
        if (!trimmed) {
          return;
        }
        if (host.settings.lastActiveSessionKey === trimmed) {
          return;
        }
        applySettings(host, { ...host.settings, lastActiveSessionKey: trimmed });
      }

      export const runB = () => runA({
        settings: { lastActiveSessionKey: 'main', sessionKey: 'main', theme: 'claw', themeMode: 'system', borderRadius: 50 },
        applySessionKey: 'main',
        theme: 'claw',
        themeMode: 'system',
      });
    `,
    );
    analyzer.project.createSourceFile('/dummy/repo/storage.ts', 'export function saveSettings(_next: unknown) {}\n');

    const result = analyzer.analyzeCycle(['a.ts', 'b.ts', 'a.ts']);

    expect(result.classification).toBe('autofix_host_state_update');
    expect(result.planner?.selectedStrategy).toBe('host_state_update');
    expect(result.planner?.rankedCandidates.map((attempt) => attempt.strategy)).toEqual(
      expect.arrayContaining(['host_state_update', 'extract_shared']),
    );
    expect(result.upstreamabilityScore).toBeGreaterThan(0.85);
    expect(result.plan).toMatchObject({
      kind: 'host_state_update',
      importedFunction: 'setLastActiveSessionKey',
      persistenceFunction: 'saveSettings',
      updatedProperty: 'lastActiveSessionKey',
      mirrorHostProperty: 'applySessionKey',
    });
  });

  it('detects host_state_update when setter helpers call imported presentation utilities', () => {
    analyzer.project.createSourceFile(
      '/dummy/repo/a.ts',
      `
      import { setLastActiveSessionKey } from './b';
      export const runA = (host: unknown) => setLastActiveSessionKey(host, ' next ');
    `,
    );
    analyzer.project.createSourceFile(
      '/dummy/repo/b.ts',
      `
      import { runA } from './a';
      import { applyBorderRadius } from './borderRadius';
      import { saveSettings } from './storage';
      import { applyResolvedTheme, resolveTheme } from './theme';

      export function applySettings(
        host: {
          settings: { lastActiveSessionKey: string; sessionKey: string; theme: string; themeMode: string; borderRadius: number };
          applySessionKey: string;
          theme: string;
          themeMode: string;
        },
        next: { lastActiveSessionKey: string; sessionKey: string; theme: string; themeMode: string; borderRadius: number },
      ) {
        const normalized = {
          ...next,
          lastActiveSessionKey: next.lastActiveSessionKey?.trim() || next.sessionKey.trim() || 'main',
        };
        host.settings = normalized;
        saveSettings(normalized);
        if (next.theme !== host.theme || next.themeMode !== host.themeMode) {
          host.theme = next.theme;
          host.themeMode = next.themeMode;
          applyResolvedTheme(host, resolveTheme(next.theme, next.themeMode));
        }
        applyBorderRadius(next.borderRadius);
        host.applySessionKey = host.settings.lastActiveSessionKey;
      }

      export function setLastActiveSessionKey(
        host: {
          settings: { lastActiveSessionKey: string; sessionKey: string; theme: string; themeMode: string; borderRadius: number };
          applySessionKey: string;
          theme: string;
          themeMode: string;
        },
        next: string,
      ) {
        const trimmed = next.trim();
        if (!trimmed) {
          return;
        }
        if (host.settings.lastActiveSessionKey === trimmed) {
          return;
        }
        applySettings(host, { ...host.settings, lastActiveSessionKey: trimmed });
      }

      export const runB = () => runA({
        settings: { lastActiveSessionKey: 'main', sessionKey: 'main', theme: 'claw', themeMode: 'system', borderRadius: 50 },
        applySessionKey: 'main',
        theme: 'claw',
        themeMode: 'system',
      });
    `,
    );
    analyzer.project.createSourceFile('/dummy/repo/storage.ts', 'export function saveSettings(_next: unknown) {}\n');
    analyzer.project.createSourceFile(
      '/dummy/repo/theme.ts',
      "export function applyResolvedTheme(_host: unknown, _resolved: string) {}\nexport function resolveTheme(theme: string, mode: string) { return theme + ':' + mode; }\n",
    );
    analyzer.project.createSourceFile(
      '/dummy/repo/borderRadius.ts',
      'export function applyBorderRadius(_value: number) {}\n',
    );

    const result = analyzer.analyzeCycle(['a.ts', 'b.ts', 'a.ts']);

    expect(result.classification).toBe('autofix_host_state_update');
    expect(result.planner?.selectedStrategy).toBe('host_state_update');
    expect(result.upstreamabilityScore).toBeGreaterThan(0.85);
    expect(result.plan).toMatchObject({
      kind: 'host_state_update',
      importedFunction: 'setLastActiveSessionKey',
      persistenceFunction: 'saveSettings',
      updatedProperty: 'lastActiveSessionKey',
      mirrorHostProperty: 'applySessionKey',
      trimValue: true,
    });
  });

  it('identifies suggest_manual for non-type cycles with unsupported declarations', () => {
    analyzer.project.createSourceFile(
      '/dummy/repo/a.ts',
      `
      import { ClassB } from './b';
      export const aVal = new ClassB();
    `,
    );
    analyzer.project.createSourceFile(
      '/dummy/repo/b.ts',
      `
      import { aVal } from './a';
      export class ClassB { prop = aVal; }
    `,
    );

    const result = analyzer.analyzeCycle(['a.ts', 'b.ts', 'a.ts']);
    expect(result.classification).toBe('suggest_manual');
  });

  it('falls back to suggest_manual for ambiguous barrel re-exports', () => {
    analyzer.project.createSourceFile(
      '/dummy/repo/app.ts',
      `
      import { Foo } from './index';
      export const appValue = Foo + 1;
    `,
    );
    analyzer.project.createSourceFile(
      '/dummy/repo/index.ts',
      `
      export * from './foo';
      export * from './bar';
    `,
    );
    analyzer.project.createSourceFile('/dummy/repo/foo.ts', 'export const Foo = 1;');
    analyzer.project.createSourceFile(
      '/dummy/repo/bar.ts',
      `
      import { appValue } from './app';
      export const Bar = appValue + 1;
    `,
    );

    const result = analyzer.analyzeCycle(['app.ts', 'index.ts', 'bar.ts', 'app.ts']);
    expect(result.classification).toBe('suggest_manual');
    expect(result.planner?.selectionSummary).toMatch(/falling back to suggest_manual/);
    expect(result.planner?.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          strategy: 'direct_import',
          status: 'rejected',
          reasons: expect.arrayContaining([expect.stringMatching(/ambiguous or side-effectful/)]),
        }),
      ]),
    );
  });

  it('suggests manual when imports are not found', () => {
    analyzer.project.createSourceFile('/dummy/repo/a.ts', 'console.log("a")');
    analyzer.project.createSourceFile('/dummy/repo/b.ts', 'console.log("b")');
    const result = analyzer.analyzeCycle(['a.ts', 'b.ts', 'a.ts']);
    expect(result.classification).toBe('suggest_manual');
    expect(result.reasons[0]).toMatch(/explicit imports/);
    expect(result.planner?.selectionSummary).toMatch(/falling back to suggest_manual/);
    expect(result.planner?.cycleSignals.explicitImportEdges).toBe(0);
  });

  it('rejects extraction if symbol is not exported', () => {
    analyzer.project.createSourceFile(
      '/dummy/repo/a.ts',
      `
      import { bVal } from './b';
      export const aVal = bVal;
    `,
    );
    analyzer.project.createSourceFile(
      '/dummy/repo/b.ts',
      `
      import { aVal } from './a';
      const bVal = 1; 
      export const mainB = () => aVal + bVal;
    `,
    );

    const result = analyzer.analyzeCycle(['a.ts', 'b.ts', 'a.ts']);
    expect(result.classification).toBe('suggest_manual');
  });

  it('rejects type-only if there are concrete usages on both sides', () => {
    analyzer.project.createSourceFile(
      '/dummy/repo/a.ts',
      `
      import BDefault from './b';
      export const aVal = BDefault.toString();
    `,
    );
    analyzer.project.createSourceFile(
      '/dummy/repo/b.ts',
      `
      import { aVal } from './a';
      export const bVal = aVal + 1;
    `,
    );

    const result = analyzer.analyzeCycle(['a.ts', 'b.ts', 'a.ts']);
    expect(result.classification).not.toBe('autofix_import_type');
  });

  it('rejects type-only if there is a namespace import used as value', () => {
    analyzer.project.createSourceFile(
      '/dummy/repo/a.ts',
      `
      import * as B from './b';
      export const useB = B.bVal;
    `,
    );
    analyzer.project.createSourceFile(
      '/dummy/repo/b.ts',
      `
      import { aVal } from './a';
      export const bVal = aVal;
    `,
    );

    const result = analyzer.analyzeCycle(['a.ts', 'b.ts', 'a.ts']);
    expect(result.classification).not.toBe('autofix_import_type');
  });

  it('handles external imports and absolute paths safely', () => {
    analyzer.project.createSourceFile(
      '/dummy/repo/a.ts',
      `
      import { bVal } from './b';
      import { external } from 'package';
      export const aVal = bVal + external;
    `,
    );
    analyzer.project.createSourceFile(
      '/dummy/repo/b.ts',
      `
      import { aVal } from '/dummy/repo/a.ts';
      export const bVal = 100; 
    `,
    );

    const result = analyzer.analyzeCycle(['a.ts', 'b.ts', 'a.ts']);
    expect(result.classification).toBe('autofix_extract_shared');
  });

  it('handles non-identifier named imports safely (unsupported case)', () => {
    analyzer.project.createSourceFile(
      '/dummy/repo/a.ts',
      `
      import { "b-val" as bVal } from './b';
      export const aVal = bVal;
    `,
    );
    analyzer.project.createSourceFile(
      '/dummy/repo/b.ts',
      `
      import { aVal } from './a';
      export const "b-val" = 1;
    `,
    );

    const result = analyzer.analyzeCycle(['a.ts', 'b.ts', 'a.ts']);
    expect(result.classification).not.toBe('autofix_import_type');
  });

  it('skips already type-only imports', () => {
    analyzer.project.createSourceFile(
      '/dummy/repo/a.ts',
      `
      import type { BType } from './b';
      export const aVal = 1;
    `,
    );
    analyzer.project.createSourceFile(
      '/dummy/repo/b.ts',
      `
      import { aVal } from './a';
      export interface BType { b: number }
    `,
    );
    const result = analyzer.analyzeCycle(['a.ts', 'b.ts', 'a.ts']);
    expect(result.classification).toBe('autofix_import_type');
  });
});
