import { describe, expect, it } from 'vitest';
import { createDatabase, createStatements, initSchema } from '../db/index.js';
import { type GitAdapter, mineBenchmarkCasesFromRepo } from './benchmarkMiner.js';

function createFakeGit(): GitAdapter {
  const commits = [
    {
      sha: 'abc123',
      title: 'Fix circular dependency with import type',
      body: 'Break the barrel re-export and convert the runtime edge to type-only.',
    },
    {
      sha: 'def456',
      title: 'Extract shared helper from cycle',
      body: 'Move helper into a shared module and preserve the source API.',
    },
    {
      sha: 'ghi789',
      title: 'Unrelated chore',
      body: 'Refresh docs and formatting only.',
    },
  ];

  const logOutput = commits.map((commit) => `${commit.sha}\u001F${commit.title}\u001F${commit.body}\u001E`).join('');
  const outputs = new Map([
    ['remote get-url origin', 'git@github.com:acme/widget.git'],
    ['show --name-status --find-renames --format= abc123', 'M\tfile-a.ts\nA\tfile-b.ts\n'],
    ['show --numstat --find-renames --format= abc123', '4\t2\tfile-a.ts\n3\t0\tfile-b.ts\n'],
    ['show --name-status --find-renames --format= def456', 'M\tshared.ts\nR100\told.ts\tnew.ts\n'],
    ['show --numstat --find-renames --format= def456', '6\t1\tshared.ts\n2\t2\tnew.ts\n'],
  ]);

  return {
    raw: async (args: string[]) => {
      const key = args.join(' ');
      if (key === 'log --all --no-merges --max-count=1000 --pretty=format:%H%x1f%s%x1f%b%x1e') {
        return logOutput;
      }

      const output = outputs.get(key);
      if (output !== undefined) {
        return output;
      }

      throw new Error(`Unexpected git call: ${key}`);
    },
  };
}

describe('mineBenchmarkCasesFromRepo', () => {
  it('stores matched benchmark cases with strategy labels and diff features', async () => {
    const db = createDatabase(':memory:');
    initSchema(db);
    const git = createFakeGit();

    // eslint-disable-next-line sonarjs/publicly-writable-directories
    const result = await mineBenchmarkCasesFromRepo('/tmp/acme-widget', {
      database: db,
      git,
      maxMatches: 10,
    });

    const stmts = createStatements(db);
    const cases = stmts.getBenchmarkCasesByRepository.all('acme/widget') as Array<{
      repository: string;
      commit_sha: string;
      title: string;
      url: string | null;
      strategy_labels: string;
      validation_signals: string;
      diff_features: string;
      matched_terms: string;
      notes: string | null;
    }>;

    expect(result).toMatchObject({
      repository: 'acme/widget',
      scannedCommits: 3,
      matchedCommits: 2,
      insertedCases: 2,
    });
    expect(result.matchedTerms).toEqual(expect.arrayContaining(['circular dependency', 'import type', 'barrel']));
    expect(cases).toHaveLength(2);

    const importTypeCase = cases.find((entry) => entry.commit_sha === 'abc123');
    expect(importTypeCase).toBeDefined();
    expect(importTypeCase?.url).toBe('https://github.com/acme/widget/commit/abc123');
    expect(JSON.parse(importTypeCase?.strategy_labels ?? '[]')).toEqual(
      expect.arrayContaining(['import_type', 'type_runtime_split', 'barrel_reexport_cleanup', 'direct_import']),
    );
    expect(JSON.parse(importTypeCase?.matched_terms ?? '[]')).toEqual(
      expect.arrayContaining(['circular dependency', 'import type', 'barrel']),
    );
    expect(JSON.parse(importTypeCase?.diff_features ?? '{}')).toMatchObject({
      files_changed: 2,
      additions: 7,
      deletions: 2,
      new_files: 1,
      renamed_files: 0,
      modified_files: 1,
      binary_files: 0,
    });
    expect(JSON.parse(importTypeCase?.validation_signals ?? '{}')).toMatchObject({
      search_terms: expect.any(Number),
      matched_terms: expect.any(Array),
    });
    expect(importTypeCase?.notes).toContain('matched terms:');

    db.close();
  });

  it('respects the maxMatches limit', async () => {
    const db = createDatabase(':memory:');
    initSchema(db);

    const git: GitAdapter = {
      raw: async (args: string[]) => {
        const key = args.join(' ');
        if (key === 'remote get-url origin') {
          return 'git@github.com:acme/widget.git';
        }
        if (key === 'log --all --no-merges --max-count=1000 --pretty=format:%H%x1f%s%x1f%b%x1e') {
          return [
            'abc123\u001FFix circular dependency with import type\u001FBreak the barrel re-export and convert the runtime edge to type-only.\u001E',
            'def456\u001FExtract shared helper from cycle\u001FMove helper into a shared module and preserve the source API.\u001E',
          ].join('');
        }
        if (key === 'show --name-status --find-renames --format= abc123') {
          return 'M\tfile-a.ts\n';
        }
        if (key === 'show --numstat --find-renames --format= abc123') {
          return '4\t2\tfile-a.ts\n';
        }
        if (key === 'show --name-status --find-renames --format= def456') {
          return 'M\tshared.ts\n';
        }
        if (key === 'show --numstat --find-renames --format= def456') {
          return '6\t1\tshared.ts\n';
        }

        throw new Error(`Unexpected git call: ${key}`);
      },
    };

    // eslint-disable-next-line sonarjs/publicly-writable-directories
    const result = await mineBenchmarkCasesFromRepo('/tmp/acme-widget', {
      database: db,
      git,
      maxMatches: 1,
    });

    const cases = createStatements(db).getBenchmarkCasesByRepository.all('acme/widget') as Array<{
      commit_sha: string;
    }>;

    expect(result.insertedCases).toBe(1);
    expect(cases).toHaveLength(1);
    expect(cases[0].commit_sha).toBe('abc123');

    db.close();
  });

  it('records corpus context in benchmark signals when provided', async () => {
    const db = createDatabase(':memory:');
    initSchema(db);
    const git = createFakeGit();

    // eslint-disable-next-line sonarjs/publicly-writable-directories
    const result = await mineBenchmarkCasesFromRepo('/tmp/acme-widget', {
      database: db,
      git,
      maxMatches: 1,
      caseContext: {
        corpusRepository: 'openclaw/openclaw',
        corpusGroups: ['calibration'],
        corpusPatterns: ['extract_shared'],
        corpusDescription: 'Calibration repo',
      },
    });

    const [entry] = createStatements(db).getBenchmarkCasesByRepository.all('acme/widget') as Array<{
      validation_signals: string;
      notes: string | null;
    }>;

    expect(result.insertedCases).toBe(1);
    expect(JSON.parse(entry.validation_signals)).toMatchObject({
      corpus_repository: 'openclaw/openclaw',
      corpus_groups: ['calibration'],
      corpus_patterns: ['extract_shared'],
      corpus_description: 'Calibration repo',
    });
    expect(entry.notes).toContain('corpus repo: openclaw/openclaw');
    expect(entry.notes).toContain('corpus groups: calibration');

    db.close();
  });
});
