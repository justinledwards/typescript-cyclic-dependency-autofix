import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import simpleGit from 'simple-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, createStatements, initSchema } from '../db/index.js';
import { createPullRequestForPatch } from './createPullRequest.js';

vi.mock('simple-git');
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

describe('createPullRequestForPatch', () => {
  let db: ReturnType<typeof createDatabase>;
  let statements: ReturnType<typeof createStatements>;
  let repoPath: string;
  let checkoutRoot: string;
  let originalRepoPath: string;
  let rootGit: Record<string, ReturnType<typeof vi.fn>>;
  let repoGit: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    initSchema(db);
    statements = createStatements(db);
    repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'target-repo-'));
    checkoutRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-checkouts-'));
    originalRepoPath = path.join(process.cwd(), '.test-fixtures', 'original-widget');

    rootGit = {
      clone: vi.fn(async (_remoteUrl: string, targetPath: string) => {
        await fs.mkdir(path.join(targetPath, 'src'), { recursive: true });
        await fs.writeFile(path.join(targetPath, 'src', 'a.ts'), 'before', 'utf8');
      }),
    };

    repoGit = {
      status: vi.fn(),
      raw: vi.fn().mockResolvedValue(''),
      commit: vi.fn().mockResolvedValue({ commit: 'new-commit' }),
      push: vi.fn(async () => {}),
    };

    vi.mocked(simpleGit).mockImplementation(((workingPath?: string) =>
      workingPath ? repoGit : rootGit) as unknown as typeof simpleGit);
    vi.mocked(execFile).mockImplementation(((
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      callback(null, 'https://github.com/acme/widget/pull/123\n', '');
      return {} as never;
    }) as unknown as typeof execFile);
  });

  afterEach(async () => {
    db.close();
    await fs.rm(repoPath, { recursive: true, force: true });
    await fs.rm(checkoutRoot, { recursive: true, force: true });
  });

  it('creates a pull request from a reviewed validated patch using an explicit checkout', async () => {
    const patchId = insertPatchCandidate({
      reviewDecision: 'approved',
      validationStatus: 'passed',
      remoteUrl: 'git@github.com:acme/widget.git',
    });
    await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
    await fs.writeFile(path.join(repoPath, 'src', 'a.ts'), 'before', 'utf8');

    repoGit.status.mockResolvedValueOnce({ files: [] }).mockResolvedValueOnce({ files: [{ path: 'src/a.ts' }] });

    const result = await createPullRequestForPatch(patchId, {
      linkedIssueNumber: 42,
      repoPath,
      database: db,
    });

    expect(await fs.readFile(path.join(repoPath, 'src', 'a.ts'), 'utf8')).toBe('after');
    expect(repoGit.raw).toHaveBeenNthCalledWith(1, ['fetch', '--all', '--prune']);
    expect(repoGit.raw).toHaveBeenNthCalledWith(2, ['checkout', '-B', 'codex/issue-42-patch-1', 'abc123']);
    expect(repoGit.raw).toHaveBeenNthCalledWith(3, ['add', '--all']);
    expect(repoGit.commit).toHaveBeenCalledWith('Break circular dependency between a.ts and b.ts');
    expect(repoGit.push).toHaveBeenCalledWith(['-u', 'origin', 'codex/issue-42-patch-1']);
    expect(result.prUrl).toBe('https://github.com/acme/widget/pull/123');

    const ghArgs = vi.mocked(execFile).mock.calls[0]?.[1] as string[];
    expect(ghArgs).toContain('--repo');
    expect(ghArgs).toContain('acme/widget');
    expect(ghArgs).toContain('--base');
    expect(ghArgs).toContain('main');
    expect(ghArgs).toContain('--head');
    expect(ghArgs).toContain('codex/issue-42-patch-1');
    expect(ghArgs).toContain('--body');
    expect(ghArgs.at(-1)).toContain('Validation passed: original cycle removed.');
    expect(ghArgs.at(-1)).toContain('Closes #42');
  });

  it('clones a scratch checkout using the stored remote URL when repoPath is omitted', async () => {
    const patchId = insertPatchCandidate({
      reviewDecision: 'pr_candidate',
      validationStatus: 'passed',
      remoteUrl: 'git@github.com:acme/widget.git',
    });

    repoGit.status.mockResolvedValueOnce({ files: [{ path: 'src/a.ts' }] });

    const result = await createPullRequestForPatch(patchId, {
      linkedIssueNumber: 7,
      checkoutRoot,
      database: db,
    });

    expect(rootGit.clone).toHaveBeenCalledWith(
      'git@github.com:acme/widget.git',
      expect.stringContaining(path.join(checkoutRoot, 'acme-widget-patch-1-')),
    );
    expect(result.repoPath).toContain(path.join(checkoutRoot, 'acme-widget-patch-1-'));
    expect(repoGit.raw).toHaveBeenCalledWith(['checkout', '-B', 'codex/issue-7-patch-1', 'abc123']);
  });

  it('rejects PR creation when the patch is not in an approved publishable state', async () => {
    const patchId = insertPatchCandidate({
      reviewDecision: 'pending',
      validationStatus: 'passed',
      remoteUrl: 'git@github.com:acme/widget.git',
    });

    await expect(
      createPullRequestForPatch(patchId, {
        linkedIssueNumber: 99,
        repoPath,
        database: db,
      }),
    ).rejects.toThrow('must be marked approved or pr_candidate');
  });

  function insertPatchCandidate(args: {
    reviewDecision: 'approved' | 'pr_candidate' | 'pending';
    validationStatus: 'passed' | 'failed';
    remoteUrl: string | null;
  }): number {
    const repositoryInfo = statements.addRepository.run({
      owner: 'acme',
      name: 'widget',
      default_branch: 'main',
      local_path: originalRepoPath,
    });
    const scanInfo = statements.addScan.run({
      repository_id: repositoryInfo.lastInsertRowid,
      commit_sha: 'abc123',
      status: 'completed',
    });
    const cycleInfo = statements.addCycle.run({
      scan_id: scanInfo.lastInsertRowid,
      normalized_path: 'src/a.ts -> src/b.ts -> src/a.ts',
      participating_files: JSON.stringify(['src/a.ts', 'src/b.ts']),
      raw_payload: JSON.stringify({ type: 'circular' }),
    });
    const fixCandidateInfo = statements.addFixCandidate.run({
      cycle_id: cycleInfo.lastInsertRowid,
      classification: 'autofix_extract_shared',
      confidence: 0.91,
      reasons: JSON.stringify(['safe shared symbol']),
    });
    const patchInfo = statements.addPatch.run({
      fix_candidate_id: fixCandidateInfo.lastInsertRowid,
      patch_text: '--- a/src/a.ts\n+++ b/src/a.ts\n',
      touched_files: JSON.stringify(['src/a.ts', 'src/b.ts', 'src/a-b.shared.ts']),
      validation_status: args.validationStatus,
      validation_summary: 'Validation passed: original cycle removed.',
    });
    statements.addPatchReplay.run({
      patch_id: patchInfo.lastInsertRowid,
      scan_id: scanInfo.lastInsertRowid,
      source_target: 'https://github.com/acme/widget.git',
      commit_sha: 'abc123',
      replay_bundle: JSON.stringify({
        source_target: 'https://github.com/acme/widget.git',
        commit_sha: 'abc123',
        repository: {
          owner: 'acme',
          name: 'widget',
          default_branch: 'main',
          local_path: originalRepoPath,
          remote_url: args.remoteUrl,
        },
        cycle: {
          path: ['src/a.ts', 'src/b.ts'],
          normalized_path: 'src/a.ts -> src/b.ts -> src/a.ts',
        },
        candidate: {
          classification: 'autofix_extract_shared',
          confidence: 0.91,
          reasons: ['safe shared symbol'],
        },
        validation: {
          status: args.validationStatus,
          summary: 'Validation passed: original cycle removed.',
        },
        file_snapshots: [
          {
            path: 'src/a.ts',
            before: 'before',
            after: 'after',
          },
        ],
        patch_text: '--- a/src/a.ts\n+++ b/src/a.ts\n',
      }),
    });

    if (args.reviewDecision !== 'pending') {
      statements.addReviewDecision.run({
        patch_id: patchInfo.lastInsertRowid,
        decision: args.reviewDecision,
        notes: null,
      });
    }

    return patchInfo.lastInsertRowid as number;
  }
});
