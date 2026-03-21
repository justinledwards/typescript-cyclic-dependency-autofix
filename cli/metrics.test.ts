import { beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, createStatements, initSchema } from '../db/index.js';
import { getOperationalMetrics } from './metrics.js';

describe('getOperationalMetrics', () => {
  const fixtureRoot = `${process.cwd()}/.test-fixtures`;
  let db: ReturnType<typeof createDatabase>;
  let statements: ReturnType<typeof createStatements>;

  beforeEach(() => {
    db = createDatabase(':memory:');
    initSchema(db);
    statements = createStatements(db);
  });

  it('aggregates repository, scan, candidate, patch, and review metrics', () => {
    const repositoryOne = statements.addRepository.run({
      owner: 'acme',
      name: 'widget',
      default_branch: 'main',
      local_path: null,
    });
    const repositoryTwo = statements.addRepository.run({
      owner: 'acme',
      name: 'gadget',
      default_branch: 'main',
      local_path: `${fixtureRoot}/gadget`,
    });

    statements.updateRepositoryStatus.run({ id: repositoryOne.lastInsertRowid, status: 'analyzed' });
    statements.updateRepositoryStatus.run({ id: repositoryTwo.lastInsertRowid, status: 'clone_failed' });

    const completedScan = statements.addScan.run({
      repository_id: repositoryOne.lastInsertRowid,
      commit_sha: 'abc123',
      status: 'completed',
    });
    statements.addScan.run({
      repository_id: repositoryTwo.lastInsertRowid,
      commit_sha: 'def456',
      status: 'failed',
    });

    const cycle = statements.addCycle.run({
      scan_id: completedScan.lastInsertRowid,
      normalized_path: 'a.ts -> b.ts -> a.ts',
      participating_files: JSON.stringify(['a.ts', 'b.ts', 'a.ts']),
      raw_payload: null,
    });

    const importTypeCandidate = statements.addFixCandidate.run({
      cycle_id: cycle.lastInsertRowid,
      classification: 'autofix_import_type',
      confidence: 0.91,
      reasons: JSON.stringify(['type-only edge']),
    });
    const manualCandidate = statements.addFixCandidate.run({
      cycle_id: cycle.lastInsertRowid,
      classification: 'suggest_manual',
      confidence: 0.52,
      reasons: JSON.stringify(['stateful cycle']),
    });

    const passedPatch = statements.addPatch.run({
      fix_candidate_id: importTypeCandidate.lastInsertRowid,
      patch_text: '--- a.ts\n+++ a.ts',
      touched_files: JSON.stringify(['a.ts']),
      validation_status: 'passed',
      validation_summary: 'Validation passed.',
    });
    const failedPatch = statements.addPatch.run({
      fix_candidate_id: manualCandidate.lastInsertRowid,
      patch_text: '--- b.ts\n+++ b.ts',
      touched_files: JSON.stringify(['b.ts']),
      validation_status: 'failed',
      validation_summary: 'Validation failed.',
    });
    statements.addPatch.run({
      fix_candidate_id: manualCandidate.lastInsertRowid,
      patch_text: '--- c.ts\n+++ c.ts',
      touched_files: JSON.stringify(['c.ts']),
      validation_status: null,
      validation_summary: null,
    });

    statements.addReviewDecision.run({
      patch_id: passedPatch.lastInsertRowid,
      decision: 'approved',
      notes: null,
    });
    statements.addReviewDecision.run({
      patch_id: failedPatch.lastInsertRowid,
      decision: 'rejected',
      notes: 'Needs follow-up',
    });

    const metrics = getOperationalMetrics(db);

    expect(metrics).toEqual({
      repositories: {
        total: 2,
        byStatus: {
          analyzed: 1,
          clone_failed: 1,
        },
      },
      scans: {
        total: 2,
        completed: 1,
        failed: 1,
        byStatus: {
          completed: 1,
          failed: 1,
        },
      },
      cycles: {
        total: 1,
      },
      fixCandidates: {
        total: 2,
        highConfidence: 1,
        byClassification: {
          autofix_import_type: 1,
          suggest_manual: 1,
        },
      },
      patches: {
        total: 3,
        passed: 1,
        failed: 1,
        pending: 1,
        validationPassRate: 0.5,
      },
      reviews: {
        total: 2,
        approved: 1,
        prCandidate: 0,
        rejected: 1,
        ignored: 0,
        approvalRate: 0.5,
      },
    });
  });
});
