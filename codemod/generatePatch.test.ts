import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CircularDependency } from '../analyzer/analyzer.js';
import type { SemanticAnalysisResult } from '../analyzer/semantic.js';
import { generatePatchForCycle } from './generatePatch.js';

const tempDirs: string[] = [];

async function createRepo(files: Record<string, string>) {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cycle-autofix-'));
  tempDirs.push(repoPath);

  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(repoPath, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, 'utf8');
  }

  return repoPath;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('generatePatchForCycle', () => {
  it('creates an import-type patch when a type-only plan is provided', async () => {
    const repoPath = await createRepo({
      'a.ts': "import { BType } from './b';\nexport const aValue = 1 as BType;\n",
      'b.ts': 'export interface BType { value: number }\n',
    });

    const cycle: CircularDependency = {
      type: 'circular',
      path: ['a.ts', 'b.ts', 'a.ts'],
    };
    const analysis: SemanticAnalysisResult = {
      classification: 'autofix_import_type',
      confidence: 0.9,
      reasons: ['safe type-only import'],
      plan: {
        kind: 'import_type',
        imports: [{ sourceFile: 'a.ts', targetFile: 'b.ts' }],
      },
    };

    const patch = await generatePatchForCycle(repoPath, cycle, analysis);

    expect(patch).not.toBeNull();
    expect(patch?.patchText).toContain('import type { BType }');
    expect(patch?.patchText).not.toContain('-export const aValue = 1 as BType;');
    expect(patch?.patchText).not.toContain('+export const aValue = 1 as BType;');
    expect(patch?.touchedFiles).toEqual(['a.ts']);
  });

  it('creates a shared-file extraction patch for a narrow safe symbol', async () => {
    const repoPath = await createRepo({
      'a.ts': "import { helperB } from './b';\nexport const mainA = () => helperB();\n",
      'b.ts': "import { mainA } from './a';\nexport const helperB = () => 'ok';\nexport const runB = () => mainA();\n",
    });

    const cycle: CircularDependency = {
      type: 'circular',
      path: ['a.ts', 'b.ts', 'a.ts'],
    };
    const analysis: SemanticAnalysisResult = {
      classification: 'autofix_extract_shared',
      confidence: 0.8,
      reasons: ['extract helperB'],
      plan: {
        kind: 'extract_shared',
        sourceFile: 'b.ts',
        targetFile: 'a.ts',
        symbols: ['helperB'],
        sharedFile: 'helperB.shared.ts',
        preserveSourceExports: true,
      },
    };

    const patch = await generatePatchForCycle(repoPath, cycle, analysis);

    expect(patch).not.toBeNull();
    expect(patch?.patchText).toContain('helperB.shared');
    expect(patch?.patchText).toContain("export const helperB = () => 'ok';");
    expect(patch?.patchText).not.toContain('-export const mainA = () => helperB();');
    expect(patch?.patchText).not.toContain('+export const mainA = () => helperB();');
    expect(patch?.touchedFiles).toEqual(['b.ts', 'a.ts', 'helperB.shared.ts']);
    const sourceSnapshot = patch?.fileSnapshots.find((snapshot) => snapshot.path === 'b.ts');
    expect(sourceSnapshot?.after).toMatch(/export \{ helperB \} from ['"]\.\/helperB\.shared['"];/);
    expect(sourceSnapshot?.after).not.toMatch(/import \{ helperB \} from ['"]\.\/helperB\.shared['"];/);
  });

  it('creates a direct-import patch when a safe leaf is reachable through a barrel', async () => {
    const repoPath = await createRepo({
      'app.ts': "import { Foo } from './index';\nexport const appValue = Foo + 1;\n",
      'index.ts': "export { Foo } from './foo';\nexport { Bar } from './bar';\n",
      'foo.ts': 'export const Foo = 1;\n',
      'bar.ts': "import { appValue } from './app';\nexport const Bar = appValue + 1;\n",
    });

    const cycle: CircularDependency = {
      type: 'circular',
      path: ['app.ts', 'index.ts', 'bar.ts', 'app.ts'],
    };
    const analysis: SemanticAnalysisResult = {
      classification: 'autofix_direct_import',
      confidence: 0.85,
      reasons: ['rewrite barrel import to leaf module'],
      plan: {
        kind: 'direct_import',
        imports: [
          {
            sourceFile: 'app.ts',
            barrelFile: 'index.ts',
            targetFile: 'foo.ts',
            symbols: ['Foo'],
          },
        ],
      },
    };

    const patch = await generatePatchForCycle(repoPath, cycle, analysis);

    expect(patch).not.toBeNull();
    expect(patch?.patchText).toContain("+import { Foo } from './foo';");
    expect(patch?.patchText).not.toContain('-export const appValue = Foo + 1;');
    expect(patch?.patchText).not.toContain('+export const appValue = Foo + 1;');
    expect(patch?.touchedFiles).toEqual(['app.ts']);
  });

  it('creates a localized host-state update patch without introducing a new file', async () => {
    const repoPath = await createRepo({
      'a.ts': [
        "import { setLastActiveSessionKey } from './b';",
        '',
        "export const runA = (host: unknown) => setLastActiveSessionKey(host, ' next ');",
        '',
      ].join('\n'),
      'b.ts': [
        "import { runA } from './a';",
        "import { saveSettings } from './storage';",
        '',
        'export function applySettings(',
        '  host: { settings: { lastActiveSessionKey: string }; applySessionKey: string },',
        '  next: { lastActiveSessionKey: string },',
        ') {',
        '  host.settings = next;',
        '  saveSettings(next);',
        '  host.applySessionKey = host.settings.lastActiveSessionKey;',
        '}',
        '',
        'export function setLastActiveSessionKey(',
        '  host: { settings: { lastActiveSessionKey: string }; applySessionKey: string },',
        '  next: string,',
        ') {',
        '  const trimmed = next.trim();',
        '  if (!trimmed) {',
        '    return;',
        '  }',
        '  if (host.settings.lastActiveSessionKey === trimmed) {',
        '    return;',
        '  }',
        '  applySettings(host, { ...host.settings, lastActiveSessionKey: trimmed });',
        '}',
        '',
        "export const runB = () => runA({ settings: { lastActiveSessionKey: 'main' }, applySessionKey: 'main' });",
        '',
      ].join('\n'),
      'storage.ts': 'export function saveSettings(_next: unknown) {}\n',
    });

    const cycle: CircularDependency = {
      type: 'circular',
      path: ['a.ts', 'b.ts', 'a.ts'],
    };
    const analysis: SemanticAnalysisResult = {
      classification: 'autofix_host_state_update',
      confidence: 0.84,
      reasons: ['localize thin imported setter into caller-owned host state'],
      plan: {
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
      },
    };

    const patch = await generatePatchForCycle(repoPath, cycle, analysis);

    expect(patch).not.toBeNull();
    expect(patch?.touchedFiles).toEqual(['a.ts']);

    const sourceSnapshot = patch?.fileSnapshots.find((snapshot) => snapshot.path === 'a.ts');
    expect(sourceSnapshot?.after).not.toContain("import { setLastActiveSessionKey } from './b';");
    expect(sourceSnapshot?.after).toMatch(/import \{ saveSettings \} from ['"]\.\/storage['"];/);
    expect(sourceSnapshot?.after).toContain('function setLastActiveSessionKey(host: unknown, next: string) {');
    expect(sourceSnapshot?.after).not.toContain('Parameters<typeof saveSettings>[0]');
    expect(sourceSnapshot?.after).toContain('const trimmed = next.trim();');
    expect(sourceSnapshot?.after).toContain(
      'const settings: { lastActiveSessionKey: string } & Record<string, unknown> = {',
    );
    expect(sourceSnapshot?.after).toContain('settingsHost.settings = settings;');
    expect(sourceSnapshot?.after).toContain('settingsHost.applySessionKey = String(settings.lastActiveSessionKey);');
    expect(sourceSnapshot?.after).toContain('saveSettings(settings);');
    expect(patch?.patchText).not.toContain('+++ b/set-last-active-session-key.shared.ts');
  });

  it('returns null when no executable plan is present', async () => {
    const repoPath = await createRepo({
      'a.ts': 'export const a = 1;\n',
      'b.ts': 'export const b = 2;\n',
    });

    const patch = await generatePatchForCycle(
      repoPath,
      { type: 'circular', path: ['a.ts', 'b.ts', 'a.ts'] },
      {
        classification: 'suggest_manual',
        confidence: 0.5,
        reasons: ['manual'],
      },
    );

    expect(patch).toBeNull();
  });
});
