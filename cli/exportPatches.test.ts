import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, createStatements, initSchema } from '../db/index.js';
import { exportApprovedPatches } from './exportPatches.js';

describe('exportApprovedPatches', () => {
  let db: ReturnType<typeof createDatabase>;
  let statements: ReturnType<typeof createStatements>;
  let outputDir: string;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    initSchema(db);
    statements = createStatements(db);
    outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'patch-export-'));
  });

  afterEach(async () => {
    db.close();
    await fs.rm(outputDir, { recursive: true, force: true });
  });

  it('exports validated approved and pr-candidate patches to deterministic paths', async () => {
    const repoInfo = statements.addRepository.run({
      owner: 'acme',
      name: 'widget',
      default_branch: null,
      local_path: null,
    });
    const scanInfo = statements.addScan.run({
      repository_id: repoInfo.lastInsertRowid,
      commit_sha: 'abc123',
      status: 'completed',
    });
    const cycleInfo = statements.addCycle.run({
      scan_id: scanInfo.lastInsertRowid,
      normalized_path: 'a.ts -> b.ts -> a.ts',
      participating_files: JSON.stringify(['a.ts', 'b.ts']),
      raw_payload: null,
    });

    const approvedCandidate = statements.addFixCandidate.run({
      cycle_id: cycleInfo.lastInsertRowid,
      classification: 'autofix_extract_shared',
      confidence: 0.98,
      reasons: JSON.stringify(['safe shared function']),
    });
    const approvedPatch = statements.addPatch.run({
      fix_candidate_id: approvedCandidate.lastInsertRowid,
      patch_text: '--- a.ts\n+++ b.ts\n',
      touched_files: JSON.stringify(['a.ts', 'b.ts']),
      validation_status: 'passed',
      validation_summary: 'Validation passed.',
    });
    statements.addReviewDecision.run({
      patch_id: approvedPatch.lastInsertRowid,
      decision: 'approved',
      notes: 'Ship it',
    });

    const prCandidate = statements.addFixCandidate.run({
      cycle_id: cycleInfo.lastInsertRowid,
      classification: 'autofix_import_type',
      confidence: 0.86,
      reasons: JSON.stringify(['type-only dependency']),
    });
    const prCandidatePatch = statements.addPatch.run({
      fix_candidate_id: prCandidate.lastInsertRowid,
      patch_text: '--- c.ts\n+++ c.ts\n',
      touched_files: JSON.stringify(['c.ts']),
      validation_status: 'passed',
      validation_summary: 'Validation passed.',
    });
    statements.addReviewDecision.run({
      patch_id: prCandidatePatch.lastInsertRowid,
      decision: 'pr_candidate',
      notes: null,
    });

    const rejectedCandidate = statements.addFixCandidate.run({
      cycle_id: cycleInfo.lastInsertRowid,
      classification: 'suggest_manual',
      confidence: 0.4,
      reasons: null,
    });
    const rejectedPatch = statements.addPatch.run({
      fix_candidate_id: rejectedCandidate.lastInsertRowid,
      patch_text: '--- rejected.ts\n+++ rejected.ts\n',
      touched_files: JSON.stringify(['rejected.ts']),
      validation_status: 'passed',
      validation_summary: 'Validation passed.',
    });
    statements.addReviewDecision.run({
      patch_id: rejectedPatch.lastInsertRowid,
      decision: 'rejected',
      notes: 'Needs more work',
    });

    const result = await exportApprovedPatches(outputDir, db);

    expect(result.exportedCount).toBe(2);
    expect(result.files).toHaveLength(2);

    const approvedPath = path.join(
      outputDir,
      'acme-widget',
      `scan-${scanInfo.lastInsertRowid}`,
      `cycle-${cycleInfo.lastInsertRowid}`,
      `fix-${approvedCandidate.lastInsertRowid}-patch-${approvedPatch.lastInsertRowid}-approved.patch`,
    );
    const prCandidatePath = path.join(
      outputDir,
      'acme-widget',
      `scan-${scanInfo.lastInsertRowid}`,
      `cycle-${cycleInfo.lastInsertRowid}`,
      `fix-${prCandidate.lastInsertRowid}-patch-${prCandidatePatch.lastInsertRowid}-pr_candidate.patch`,
    );
    const rejectedPath = path.join(
      outputDir,
      'acme-widget',
      `scan-${scanInfo.lastInsertRowid}`,
      `cycle-${cycleInfo.lastInsertRowid}`,
      `fix-${rejectedCandidate.lastInsertRowid}-patch-${rejectedPatch.lastInsertRowid}-rejected.patch`,
    );

    await expect(fs.readFile(approvedPath, 'utf8')).resolves.toBe('--- a.ts\n+++ b.ts\n');
    await expect(fs.readFile(prCandidatePath, 'utf8')).resolves.toBe('--- c.ts\n+++ c.ts\n');
    expect(result.files).not.toContain(rejectedPath);
  });
});
