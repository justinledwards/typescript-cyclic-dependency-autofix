import type { SimpleGit } from 'simple-git';
import { canonicalizeCyclePath, normalizeCyclePath } from '../../analyzer/cycleNormalization.js';
import type { GeneratedPatch } from '../../codemod/generatePatch.js';
import { generatePatchForCycle } from '../../codemod/generatePatch.js';
import type { RepositoryDTO } from '../../db/index.js';
import {
  addCycle,
  addFixCandidate,
  addPatch,
  addPatchReplay,
  addRepository,
  getDb,
  getRepositoryByOwnerName,
  updateRepositoryLocalPath,
} from '../../db/index.js';
import type { ValidationResult } from '../validation.js';
import { validateGeneratedPatch } from '../validation.js';
import type { PatchReplayBundle, ScannedCycle } from './types.js';

export async function getLatestCommitSha(gitRepo: Pick<SimpleGit, 'log'>): Promise<string> {
  try {
    const log = await gitRepo.log(['-1']);
    return log.latest?.hash ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function ensureRepository(owner: string, name: string, localPath: string | null): RepositoryDTO {
  const existingRepo = getRepositoryByOwnerName.get(owner, name) as RepositoryDTO | undefined;
  if (existingRepo) {
    if (localPath && existingRepo.local_path !== localPath) {
      updateRepositoryLocalPath.run({ id: existingRepo.id, local_path: localPath });
      return { ...existingRepo, local_path: localPath };
    }

    return existingRepo;
  }

  const info = addRepository.run({
    owner,
    name,
    default_branch: 'main',
    local_path: localPath,
  });

  const createdRepo = getRepositoryByOwnerName.get(owner, name) as RepositoryDTO | undefined;
  if (createdRepo) {
    return createdRepo;
  }

  return { id: info.lastInsertRowid as number, owner, name } as RepositoryDTO;
}

export function dedupeCycles(cycles: ScannedCycle[]): ScannedCycle[] {
  const dedupedCycles = new Map<string, ScannedCycle>();

  for (const cycle of cycles) {
    const canonicalPath = canonicalizeCyclePath(cycle.path);
    const normalizedPath = normalizeCyclePath(canonicalPath);
    if (dedupedCycles.has(normalizedPath)) {
      continue;
    }

    dedupedCycles.set(normalizedPath, {
      ...cycle,
      path: canonicalPath,
    });
  }

  return [...dedupedCycles.values()];
}

export async function persistCycle(
  scanId: number,
  repoPath: string,
  sourceTarget: string,
  commitSha: string,
  remoteUrl: string | null,
  repository: RepositoryDTO,
  cycle: ScannedCycle,
): Promise<void> {
  const canonicalPath = canonicalizeCyclePath(cycle.path);
  const persistedCycle = {
    ...cycle,
    path: canonicalPath,
  };

  const cycleInfo = addCycle.run({
    scan_id: scanId,
    normalized_path: normalizeCyclePath(canonicalPath),
    participating_files: JSON.stringify(canonicalPath),
    raw_payload: JSON.stringify(persistedCycle),
  });

  if (!persistedCycle.analysis) {
    return;
  }

  const fixCandidateInfo = addFixCandidate.run({
    cycle_id: cycleInfo.lastInsertRowid as number,
    classification: persistedCycle.analysis.classification,
    confidence: persistedCycle.analysis.confidence,
    reasons: JSON.stringify(persistedCycle.analysis.reasons),
  });

  const generatedPatch = await generatePatchForCycle(repoPath, persistedCycle, persistedCycle.analysis);
  if (!generatedPatch) {
    return;
  }

  const validation = await validateGeneratedPatch(repoPath, persistedCycle, generatedPatch);
  const patchPayload = {
    fix_candidate_id: fixCandidateInfo.lastInsertRowid as number,
    patch_text: generatedPatch.patchText,
    touched_files: JSON.stringify(generatedPatch.touchedFiles),
    validation_status: validation.status,
    validation_summary: validation.summary,
  };
  const replayBundle = buildPatchReplayBundle({
    scanId,
    sourceTarget,
    commitSha,
    remoteUrl,
    repository,
    cycle: persistedCycle,
    generatedPatch,
    validation,
  });

  getDb().transaction((patchRow: typeof patchPayload, replayBundleJson: string) => {
    const patchInfo = addPatch.run(patchRow);
    addPatchReplay.run({
      patch_id: patchInfo.lastInsertRowid as number,
      scan_id: scanId,
      source_target: sourceTarget,
      commit_sha: commitSha,
      replay_bundle: replayBundleJson,
    });
  })(patchPayload, JSON.stringify(replayBundle));
}

function buildPatchReplayBundle(args: {
  scanId: number;
  sourceTarget: string;
  commitSha: string;
  remoteUrl: string | null;
  repository: RepositoryDTO;
  cycle: ScannedCycle;
  generatedPatch: GeneratedPatch;
  validation: ValidationResult;
}): PatchReplayBundle {
  const canonicalPath = canonicalizeCyclePath(args.cycle.path);

  return {
    scan_id: args.scanId,
    source_target: args.sourceTarget,
    commit_sha: args.commitSha,
    repository: {
      owner: args.repository.owner,
      name: args.repository.name,
      default_branch: args.repository.default_branch ?? null,
      local_path: args.repository.local_path ?? null,
      remote_url: normalizeRemoteUrl(args.remoteUrl, args.repository.owner, args.repository.name),
    },
    cycle: {
      path: canonicalPath,
      normalized_path: normalizeCyclePath(canonicalPath),
      raw_payload: {
        ...args.cycle,
        path: canonicalPath,
      },
    },
    candidate: {
      classification: args.cycle.analysis?.classification ?? 'unsupported',
      confidence: args.cycle.analysis?.confidence ?? 0,
      reasons: args.cycle.analysis?.reasons ?? null,
    },
    validation: args.validation,
    file_snapshots: args.generatedPatch.fileSnapshots,
    patch_text: args.generatedPatch.patchText,
  };
}

function normalizeRemoteUrl(remoteUrl: string | null, owner: string, name: string): string | null {
  if (remoteUrl) {
    return remoteUrl;
  }

  if (owner === 'local') {
    return null;
  }

  return `https://github.com/${owner}/${name}.git`;
}
