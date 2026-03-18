import fs from 'node:fs/promises';
import simpleGit from 'simple-git';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeRepository } from '../analyzer/analyzer.js';
import { generatePatchForCycle } from '../codemod/generatePatch.js';
import * as dbModule from '../db/index.js';
import { scanRepository } from './scanner.js';

vi.mock('node:fs/promises');
vi.mock('simple-git');
vi.mock('../analyzer/analyzer.js');
vi.mock('../codemod/generatePatch.js', () => ({
  generatePatchForCycle: vi.fn().mockResolvedValue(null),
}));
vi.mock('../db/index.js', async () => {
  const actual = await vi.importActual<typeof import('../db/index.js')>('../db/index.js');
  const db = actual.createDatabase(':memory:');
  actual.initSchema(db);
  const stmts = actual.createStatements(db);
  return {
    ...actual,
    getDb: () => db,
    addRepository: stmts.addRepository,
    getRepositoryByOwnerName: stmts.getRepositoryByOwnerName,
    updateRepositoryStatus: stmts.updateRepositoryStatus,
    addScan: stmts.addScan,
    updateScanStatus: stmts.updateScanStatus,
    addCycle: stmts.addCycle,
    getCyclesByScanId: stmts.getCyclesByScanId,
    getScan: stmts.getScan,
    addFixCandidate: stmts.addFixCandidate,
    getFixCandidatesByCycleId: stmts.getFixCandidatesByCycleId,
    addPatch: stmts.addPatch,
    getPatchesByFixCandidateId: stmts.getPatchesByFixCandidateId,
  };
});

describe('Scanner Worker', () => {
  let mockGit: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.resetAllMocks();

    mockGit = {
      clone: vi.fn(),
      fetch: vi.fn(),
      log: vi.fn().mockResolvedValue({ latest: { hash: 'mock-sha' } }),
    };

    vi.mocked(simpleGit).mockReturnValue(mockGit as unknown as ReturnType<typeof simpleGit>);
    vi.mocked(analyzeRepository).mockResolvedValue([{ type: 'circular', path: ['a.ts', 'b.ts', 'a.ts'] }]);
    vi.mocked(generatePatchForCycle).mockResolvedValue(null);

    dbModule.getDb().prepare('DELETE FROM patches').run();
    dbModule.getDb().prepare('DELETE FROM fix_candidates').run();
    dbModule.getDb().prepare('DELETE FROM cycles').run();
    dbModule.getDb().prepare('DELETE FROM scans').run();
    dbModule.getDb().prepare('DELETE FROM repositories').run();
  });

  it('clones and scans a new github repo', async () => {
    vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT'));

    const result = await scanRepository('justin/repo');

    expect(result.cyclesFound).toBe(1);
    expect(mockGit.clone).toHaveBeenCalledWith('https://github.com/justin/repo.git', expect.any(String));

    const scan = dbModule.getScan.get(result.scanId) as { commit_sha: string };
    expect(scan).toBeDefined();
    expect(scan.commit_sha).toBe('mock-sha');

    const cycles = dbModule.getCyclesByScanId.all(result.scanId) as { normalized_path: string }[];
    expect(cycles).toHaveLength(1);
    expect(cycles[0].normalized_path).toBe('a.ts -> b.ts -> a.ts');
  });

  it('fetches existing repo instead of cloning', async () => {
    vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => true } as never);

    await scanRepository('https://github.com/org/project.git');

    expect(mockGit.fetch).toHaveBeenCalled();
    expect(mockGit.clone).not.toHaveBeenCalled();
  });

  it('updates target status on clone failure', async () => {
    vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT'));
    mockGit.clone.mockRejectedValue(new Error('Clone error'));

    await expect(scanRepository('foo/bar')).rejects.toThrow('Clone error');

    const repo = dbModule.getRepositoryByOwnerName.get('foo', 'bar') as { status: string };
    expect(repo.status).toBe('clone_failed');
  });

  it('updates scan and target status on analyzer failure', async () => {
    vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(analyzeRepository).mockRejectedValue(new Error('Analyzer error'));

    await expect(scanRepository('org/err')).rejects.toThrow('Analyzer error');

    const repo = dbModule.getRepositoryByOwnerName.get('org', 'err') as { status: string };
    expect(repo.status).toBe('validation_failed');
  });

  it('handles github.com url without slash safely', async () => {
    vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT'));
    await scanRepository('https://github.com/just-one-part');
    const repo = dbModule.getRepositoryByOwnerName.get('just-one-part', 'unknown-repo') as { status: string };
    expect(repo).toBeDefined();
  });

  it('handles bare github.com url', async () => {
    vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT'));
    await scanRepository('github.com');
    const repo = dbModule.getRepositoryByOwnerName.get('unknown', 'github.com') as { status: string };
    expect(repo).toBeDefined();
  });

  it('handles organization with trailing slash', async () => {
    vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT'));
    await scanRepository('justin/');
    const repo = dbModule.getRepositoryByOwnerName.get('justin', 'unknown-repo') as { status: string };
    expect(repo).toBeDefined();
  });

  it('reuses existing repo from database', async () => {
    vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT'));

    // add repo first
    dbModule.addRepository.run({
      owner: 'find',
      name: 'existing',
      default_branch: 'main',
      local_path: null,
    });

    await scanRepository('find/existing');
    const result = await scanRepository('find/existing');
    expect(result.scanId).toBeDefined();
  });

  it('handles regular github url parsing', async () => {
    vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT'));
    await scanRepository('https://github.com/solid/repo.git');
    const repo = dbModule.getRepositoryByOwnerName.get('solid', 'repo') as { status: string };
    expect(repo).toBeDefined();
  });

  it('handles bare names', async () => {
    vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT'));
    await scanRepository('bare-name-no-slashes');
    const repo = dbModule.getRepositoryByOwnerName.get('unknown', 'bare-name-no-slashes') as { status: string };
    expect(repo).toBeDefined();
  });

  it('persists fix candidates when analysis is present', async () => {
    vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(analyzeRepository).mockResolvedValue([
      {
        type: 'circular',
        path: ['a.ts', 'b.ts', 'a.ts'],
        analysis: {
          classification: 'autofix_import_type',
          confidence: 0.9,
          reasons: ['mock reason'],
        },
      },
    ]);

    const result = await scanRepository('org/fix');

    const cycles = dbModule.getCyclesByScanId.all(result.scanId) as Array<{ id: number }>;
    expect(cycles).toHaveLength(1);

    const candidates = dbModule.getFixCandidatesByCycleId.all(cycles[0].id) as Array<{
      classification: string;
      confidence: number;
    }>;
    expect(candidates).toHaveLength(1);
    expect(candidates[0].classification).toBe('autofix_import_type');
    expect(candidates[0].confidence).toBe(0.9);
  });

  it('persists generated patches for executable fix plans', async () => {
    vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(analyzeRepository).mockResolvedValue([
      {
        type: 'circular',
        path: ['a.ts', 'b.ts', 'a.ts'],
        analysis: {
          classification: 'autofix_import_type',
          confidence: 0.9,
          reasons: ['mock reason'],
          plan: {
            kind: 'import_type',
            imports: [{ sourceFile: 'a.ts', targetFile: 'b.ts' }],
          },
        },
      },
    ]);
    vi.mocked(generatePatchForCycle).mockResolvedValue({
      patchText: '--- a/a.ts\n+++ b/a.ts',
      touchedFiles: ['a.ts'],
      validationStatus: 'pending',
      validationSummary: 'Generated import-type patch candidate. Validation has not run yet.',
    });

    const result = await scanRepository('org/patch');
    const cycles = dbModule.getCyclesByScanId.all(result.scanId) as Array<{ id: number }>;
    const candidates = dbModule.getFixCandidatesByCycleId.all(cycles[0].id) as Array<{ id: number }>;
    const patches = dbModule.getPatchesByFixCandidateId.all(candidates[0].id) as Array<{ patch_text: string }>;

    expect(patches).toHaveLength(1);
    expect(patches[0].patch_text).toContain('--- a/a.ts');
  });
});
