import type { SimpleGit } from 'simple-git';
import { canonicalizeCyclePath, normalizeCyclePath } from '../../analyzer/cycleNormalization.js';
import type { SemanticAnalysisResult, StrategyAttempt } from '../../analyzer/semantic.js';
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
import { type ConcurrencyLimiter, createNoopLogger, type StructuredLogger, serializeError } from '../observability.js';
import { shouldPromotePatchCandidate } from '../promotionPolicy.js';
import type { ValidationResult } from '../validation.js';
import { validateGeneratedPatch } from '../validation.js';
import type { PatchReplayBundle, ScannedCycle } from './types.js';

interface PersistedCandidate {
  strategy: string | null;
  plannerRank: number;
  classification: SemanticAnalysisResult['classification'];
  confidence: number;
  reasons: string[];
  plan: SemanticAnalysisResult['plan'];
  upstreamabilityScore: number | null;
  summary: string | null;
  scoreBreakdown: string[] | null;
  signals: Record<string, unknown> | null;
}

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
  options: {
    logger?: StructuredLogger;
    validationLimiter?: ConcurrencyLimiter;
  } = {},
): Promise<void> {
  const logger = options.logger ?? createNoopLogger();
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
  const cycleId = cycleInfo.lastInsertRowid as number;
  const cycleLogger = logger.child({
    cycleId,
    normalizedPath: normalizeCyclePath(canonicalPath),
  });
  cycleLogger.info('cycle.persisted', {
    participatingFiles: canonicalPath.length,
  });

  if (!persistedCycle.analysis) {
    cycleLogger.warn('cycle.unclassified', {
      reason: 'No semantic analysis was attached to the cycle payload.',
    });
    return;
  }

  const candidates = extractPersistedCandidates(persistedCycle.analysis);

  for (const candidate of candidates) {
    const fixCandidateInfo = addFixCandidate.run({
      cycle_id: cycleId,
      strategy: candidate.strategy,
      planner_rank: candidate.plannerRank,
      classification: candidate.classification,
      confidence: candidate.confidence,
      upstreamability_score: candidate.upstreamabilityScore,
      reasons: JSON.stringify(candidate.reasons),
      summary: candidate.summary,
      score_breakdown: candidate.scoreBreakdown ? JSON.stringify(candidate.scoreBreakdown) : null,
      signals: candidate.signals ? JSON.stringify(candidate.signals) : null,
    });
    const fixCandidateId = fixCandidateInfo.lastInsertRowid as number;
    const candidateLogger = cycleLogger.child({
      fixCandidateId,
      plannerRank: candidate.plannerRank,
      strategy: candidate.strategy,
      classification: candidate.classification,
    });
    candidateLogger.info('cycle.candidate.persisted', {
      confidence: candidate.confidence,
      upstreamabilityScore: candidate.upstreamabilityScore ?? null,
    });

    const candidateAnalysis = buildCandidateAnalysis(persistedCycle.analysis, candidate);

    if (!shouldGeneratePatch(candidateAnalysis)) {
      candidateLogger.info('patch.skipped', {
        reason: 'Candidate did not clear the promotion policy thresholds.',
        confidence: candidate.confidence,
        upstreamabilityScore: candidate.upstreamabilityScore ?? null,
      });
      continue;
    }

    candidateLogger.info('patch.generation.started', {
      repoPath,
    });

    let generatedPatch: GeneratedPatch | null;
    try {
      generatedPatch = await generatePatchForCycle(repoPath, persistedCycle, candidateAnalysis);
    } catch (error) {
      candidateLogger.error('patch.generation.failed', {
        ...serializeError(error),
      });
      throw error;
    }

    if (!generatedPatch) {
      candidateLogger.warn('patch.generation.skipped', {
        reason: 'No executable patch could be generated for the selected candidate plan.',
      });
      continue;
    }

    candidateLogger.info('patch.generated', {
      touchedFiles: generatedPatch.touchedFiles.length,
    });

    candidateLogger.info('validation.started', {
      queued: Boolean(options.validationLimiter),
    });
    const validationLogger = candidateLogger.child({
      touchedFiles: generatedPatch.touchedFiles.length,
    });
    const validation = options.validationLimiter
      ? await options.validationLimiter.run(async () =>
          validateGeneratedPatch(repoPath, persistedCycle, generatedPatch, {
            logger: validationLogger,
          }),
        )
      : await validateGeneratedPatch(repoPath, persistedCycle, generatedPatch, {
          logger: validationLogger,
        });
    candidateLogger.info('validation.completed', {
      status: validation.status,
      failureCategory: validation.failureCategory ?? null,
    });

    const patchPayload = {
      fix_candidate_id: fixCandidateId,
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
      candidate: candidateAnalysis,
      generatedPatch,
      validation,
    });

    getDb().transaction((patchRow: typeof patchPayload, replayBundleJson: string) => {
      const patchInfo = addPatch.run(patchRow);
      candidateLogger.info('patch.persisted', {
        patchId: patchInfo.lastInsertRowid as number,
        validationStatus: validation.status,
      });
      addPatchReplay.run({
        patch_id: patchInfo.lastInsertRowid as number,
        scan_id: scanId,
        source_target: sourceTarget,
        commit_sha: commitSha,
        replay_bundle: replayBundleJson,
      });
    })(patchPayload, JSON.stringify(replayBundle));
  }
}

function shouldGeneratePatch(analysis: SemanticAnalysisResult): boolean {
  return shouldPromotePatchCandidate({
    classification: analysis.classification,
    confidence: analysis.confidence,
    upstreamabilityScore: analysis.upstreamabilityScore,
    hasPlan: Boolean(analysis.plan),
  });
}

function extractPersistedCandidates(analysis: SemanticAnalysisResult): PersistedCandidate[] {
  const rankedCandidates = analysis.planner?.rankedCandidates ?? [];
  if (rankedCandidates.length > 0) {
    return rankedCandidates.map((candidate, index) => toPersistedCandidate(candidate, index + 1, analysis));
  }

  return [
    {
      strategy: analysis.planner?.selectedStrategy ?? classifyStrategy(analysis.classification),
      plannerRank: 1,
      classification: analysis.classification,
      confidence: analysis.confidence,
      reasons: analysis.reasons,
      plan: analysis.plan,
      upstreamabilityScore: analysis.upstreamabilityScore ?? null,
      summary: analysis.planner?.selectionSummary ?? null,
      scoreBreakdown: null,
      signals: null,
    },
  ];
}

function toPersistedCandidate(
  attempt: StrategyAttempt,
  plannerRank: number,
  analysis: SemanticAnalysisResult,
): PersistedCandidate {
  return {
    strategy: attempt.strategy,
    plannerRank,
    classification: attempt.classification ?? analysis.classification,
    confidence: attempt.confidence ?? analysis.confidence,
    reasons: attempt.reasons,
    plan: attempt.plan,
    upstreamabilityScore: attempt.score ?? null,
    summary: attempt.summary,
    scoreBreakdown: attempt.scoreBreakdown ?? null,
    signals: attempt.signals,
  };
}

function buildCandidateAnalysis(
  analysis: SemanticAnalysisResult,
  candidate: PersistedCandidate,
): SemanticAnalysisResult {
  return {
    classification: candidate.classification,
    confidence: candidate.confidence,
    reasons: candidate.reasons,
    plan: candidate.plan,
    upstreamabilityScore: candidate.upstreamabilityScore ?? undefined,
    planner: analysis.planner,
  };
}

function classifyStrategy(classification: SemanticAnalysisResult['classification']): string | null {
  switch (classification) {
    case 'autofix_import_type': {
      return 'import_type';
    }
    case 'autofix_direct_import': {
      return 'direct_import';
    }
    case 'autofix_extract_shared': {
      return 'extract_shared';
    }
    case 'autofix_host_state_update': {
      return 'host_state_update';
    }
    default: {
      return null;
    }
  }
}

function buildPatchReplayBundle(args: {
  scanId: number;
  sourceTarget: string;
  commitSha: string;
  remoteUrl: string | null;
  repository: RepositoryDTO;
  cycle: ScannedCycle;
  candidate: SemanticAnalysisResult;
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
      classification: args.candidate.classification,
      confidence: args.candidate.confidence,
      upstreamabilityScore: args.candidate.upstreamabilityScore,
      reasons: args.candidate.reasons ?? null,
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
