import type { SimpleGit } from 'simple-git';
import { canonicalizeCyclePath, normalizeCyclePath } from '../../analyzer/cycleNormalization.js';
import type { SemanticAnalysisResult, StrategyAttempt } from '../../analyzer/semantic.js';
import type { GeneratedPatch } from '../../codemod/generatePatch.js';
import { generatePatchForCycle } from '../../codemod/generatePatch.js';
import type { RepositoryDTO } from '../../db/index.js';
import {
  addCandidateObservation,
  addCycle,
  addCycleObservation,
  addFixCandidate,
  addPatch,
  addPatchReplay,
  addRepository,
  getDb,
  getLatestCycleObservationByCycleId,
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

interface CandidateOutcome {
  fixCandidateId: number;
  patchId: number | null;
  validationStatus: string | null;
  validationSummary: string | null;
  validationFailureCategory: string | null;
  promotionEligible: boolean;
}

interface ObservationAttempt {
  strategy: string | null;
  status: string;
  plannerRank: number;
  promotionEligible: boolean;
  summary: string | null;
  classification: string | null;
  confidence: number | null;
  upstreamabilityScore: number | null;
  reasons: string[] | null;
  scoreBreakdown: string[] | null;
  signals: Record<string, unknown> | null;
  plan: SemanticAnalysisResult['plan'];
  fixCandidateId: number | null;
  patchId: number | null;
  validationStatus: string | null;
  validationSummary: string | null;
  validationFailureCategory: string | null;
}

interface PersistCycleArtifactsArgs {
  cycleId: number;
  observationVersion: number;
  scanId: number;
  repoPath: string;
  sourceTarget: string;
  commitSha: string;
  remoteUrl: string | null;
  repository: RepositoryDTO;
  cycle: ScannedCycle;
  logger?: StructuredLogger;
  validationLimiter?: ConcurrencyLimiter;
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

  await persistCycleObservationVersion({
    cycleId: cycleInfo.lastInsertRowid as number,
    observationVersion: 1,
    scanId,
    repoPath,
    sourceTarget,
    commitSha,
    remoteUrl,
    repository,
    cycle: persistedCycle,
    logger: options.logger,
    validationLimiter: options.validationLimiter,
  });
}

export async function persistCycleObservationVersion(args: PersistCycleArtifactsArgs): Promise<number> {
  const {
    cycleId,
    observationVersion,
    scanId,
    repoPath,
    sourceTarget,
    commitSha,
    remoteUrl,
    repository,
    cycle,
    logger: providedLogger,
    validationLimiter,
  } = args;
  const logger = providedLogger ?? createNoopLogger();
  const canonicalPath = canonicalizeCyclePath(cycle.path);
  const persistedCycle = {
    ...cycle,
    path: canonicalPath,
  };
  const cycleLogger = logger.child({
    cycleId,
    normalizedPath: normalizeCyclePath(canonicalPath),
    observationVersion,
  });
  cycleLogger.info('cycle.persisted', {
    participatingFiles: canonicalPath.length,
  });

  const cycleObservationInfo = addCycleObservation.run(
    buildCycleObservationPayload({
      cycleId,
      scanId,
      repositoryId: repository.id,
      observationVersion,
      normalizedPath: normalizeCyclePath(canonicalPath),
      cyclePath: canonicalPath,
      analysis: persistedCycle.analysis,
    }),
  );
  const cycleObservationId = cycleObservationInfo.lastInsertRowid as number;

  if (!persistedCycle.analysis) {
    cycleLogger.warn('cycle.unclassified', {
      reason: 'No semantic analysis was attached to the cycle payload.',
    });
    return cycleObservationId;
  }

  const candidates = extractPersistedCandidates(persistedCycle.analysis);
  const candidateOutcomes = await persistCandidateArtifacts({
    candidates,
    analysis: persistedCycle.analysis,
    cycleId,
    cycle: persistedCycle,
    cycleLogger,
    repoPath,
    repository,
    scanId,
    sourceTarget,
    commitSha,
    remoteUrl,
    validationLimiter,
  });

  const observationAttempts = buildObservationAttempts(persistedCycle.analysis, candidateOutcomes);
  for (const attempt of observationAttempts) {
    addCandidateObservation.run({
      cycle_observation_id: cycleObservationId,
      observation_version: observationVersion,
      fix_candidate_id: attempt.fixCandidateId,
      patch_id: attempt.patchId,
      strategy: attempt.strategy,
      status: attempt.status,
      planner_rank: attempt.plannerRank,
      promotion_eligible: attempt.promotionEligible ? 1 : 0,
      summary: attempt.summary,
      classification: attempt.classification,
      confidence: attempt.confidence,
      upstreamability_score: attempt.upstreamabilityScore,
      reasons: attempt.reasons ? JSON.stringify(attempt.reasons) : null,
      score_breakdown: attempt.scoreBreakdown ? JSON.stringify(attempt.scoreBreakdown) : null,
      signals: attempt.signals ? JSON.stringify(attempt.signals) : null,
      plan: attempt.plan ? JSON.stringify(attempt.plan) : null,
      validation_status: attempt.validationStatus,
      validation_summary: attempt.validationSummary,
      validation_failure_category: attempt.validationFailureCategory,
    });
  }

  return cycleObservationId;
}

function buildCycleObservationPayload(args: {
  cycleId: number;
  scanId: number;
  repositoryId: number;
  observationVersion: number;
  normalizedPath: string;
  cyclePath: string[];
  analysis?: SemanticAnalysisResult;
}) {
  const { cycleId, scanId, repositoryId, observationVersion, normalizedPath, cyclePath, analysis } = args;

  return {
    cycle_id: cycleId,
    scan_id: scanId,
    repository_id: repositoryId,
    observation_version: observationVersion,
    normalized_path: normalizedPath,
    cycle_shape: analysis?.planner?.cycleShape ?? null,
    cycle_size: analysis?.planner?.cycleSize ?? cyclePath.length - 1,
    cycle_signals: analysis?.planner?.cycleSignals ? JSON.stringify(analysis.planner.cycleSignals) : null,
    feature_vector: analysis?.planner?.features ? JSON.stringify(analysis.planner.features) : null,
    graph_summary: analysis?.planner?.graphSummary ? JSON.stringify(analysis.planner.graphSummary) : null,
    repo_profile: buildObservationRepoProfile(analysis),
    planner_summary: analysis?.planner?.selectionSummary ?? null,
    planner_attempts: JSON.stringify(analysis?.planner?.attempts ?? []),
    selected_strategy:
      analysis?.planner?.selectedStrategy ?? (analysis ? classifyStrategy(analysis.classification) : null),
    selected_classification: analysis?.planner?.selectedClassification ?? analysis?.classification ?? null,
    selected_score: analysis?.planner?.selectedScore ?? analysis?.upstreamabilityScore ?? null,
    fallback_classification: analysis?.planner?.fallbackClassification ?? analysis?.classification ?? null,
    fallback_confidence: analysis?.planner?.fallbackConfidence ?? analysis?.confidence ?? null,
    fallback_reasons: JSON.stringify(analysis?.planner?.fallbackReasons ?? analysis?.reasons ?? []),
  };
}

async function persistCandidateArtifacts(args: {
  candidates: PersistedCandidate[];
  analysis: SemanticAnalysisResult;
  cycleId: number;
  cycle: ScannedCycle;
  cycleLogger: StructuredLogger;
  repoPath: string;
  repository: RepositoryDTO;
  scanId: number;
  sourceTarget: string;
  commitSha: string;
  remoteUrl: string | null;
  validationLimiter?: ConcurrencyLimiter;
}): Promise<Map<string, CandidateOutcome>> {
  const {
    candidates,
    analysis,
    cycleId,
    cycle,
    cycleLogger,
    repoPath,
    repository,
    scanId,
    sourceTarget,
    commitSha,
    remoteUrl,
    validationLimiter,
  } = args;
  const candidateOutcomes = new Map<string, CandidateOutcome>();

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

    const candidateOutcome = await persistCandidatePatch({
      analysis,
      candidate,
      fixCandidateId,
      cycle,
      candidateLogger,
      repoPath,
      repository,
      scanId,
      sourceTarget,
      commitSha,
      remoteUrl,
      validationLimiter,
    });
    candidateOutcomes.set(createCandidateKey(candidate.strategy, candidate.plannerRank), candidateOutcome);
  }

  return candidateOutcomes;
}

async function persistCandidatePatch(args: {
  analysis: SemanticAnalysisResult;
  candidate: PersistedCandidate;
  fixCandidateId: number;
  cycle: ScannedCycle;
  candidateLogger: StructuredLogger;
  repoPath: string;
  repository: RepositoryDTO;
  scanId: number;
  sourceTarget: string;
  commitSha: string;
  remoteUrl: string | null;
  validationLimiter?: ConcurrencyLimiter;
}): Promise<CandidateOutcome> {
  const {
    analysis,
    candidate,
    fixCandidateId,
    cycle,
    candidateLogger,
    repoPath,
    repository,
    scanId,
    sourceTarget,
    commitSha,
    remoteUrl,
    validationLimiter,
  } = args;
  const candidateAnalysis = buildCandidateAnalysis(analysis, candidate);
  const promotionEligible = shouldGeneratePatch(candidateAnalysis);
  const candidateOutcome: CandidateOutcome = {
    fixCandidateId,
    patchId: null,
    validationStatus: null,
    validationSummary: null,
    validationFailureCategory: null,
    promotionEligible,
  };

  if (!promotionEligible) {
    candidateLogger.info('patch.skipped', {
      reason: 'Candidate did not clear the promotion policy thresholds.',
      confidence: candidate.confidence,
      upstreamabilityScore: candidate.upstreamabilityScore ?? null,
    });
    return candidateOutcome;
  }

  candidateLogger.info('patch.generation.started', {
    repoPath,
  });

  let generatedPatch: GeneratedPatch | null;
  try {
    generatedPatch = await generatePatchForCycle(repoPath, cycle, candidateAnalysis);
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
    return candidateOutcome;
  }

  candidateLogger.info('patch.generated', {
    touchedFiles: generatedPatch.touchedFiles.length,
  });

  const validation = await validateCandidatePatch({
    candidateLogger,
    cycle,
    generatedPatch,
    repoPath,
    validationLimiter,
  });

  const replayBundle = buildPatchReplayBundle({
    scanId,
    sourceTarget,
    commitSha,
    remoteUrl,
    repository,
    cycle,
    candidate: candidateAnalysis,
    generatedPatch,
    validation,
  });

  persistPatchArtifacts({
    candidateOutcome,
    candidateLogger,
    commitSha,
    fixCandidateId,
    replayBundle,
    scanId,
    sourceTarget,
    validation,
    generatedPatch,
  });

  return candidateOutcome;
}

async function validateCandidatePatch(args: {
  candidateLogger: StructuredLogger;
  cycle: ScannedCycle;
  generatedPatch: GeneratedPatch;
  repoPath: string;
  validationLimiter?: ConcurrencyLimiter;
}): Promise<ValidationResult> {
  const { candidateLogger, cycle, generatedPatch, repoPath, validationLimiter } = args;

  candidateLogger.info('validation.started', {
    queued: Boolean(validationLimiter),
  });
  const validationLogger = candidateLogger.child({
    touchedFiles: generatedPatch.touchedFiles.length,
  });
  const validation = validationLimiter
    ? await validationLimiter.run(async () =>
        validateGeneratedPatch(repoPath, cycle, generatedPatch, {
          logger: validationLogger,
        }),
      )
    : await validateGeneratedPatch(repoPath, cycle, generatedPatch, {
        logger: validationLogger,
      });
  candidateLogger.info('validation.completed', {
    status: validation.status,
    failureCategory: validation.failureCategory ?? null,
  });

  return validation;
}

function persistPatchArtifacts(args: {
  candidateOutcome: CandidateOutcome;
  candidateLogger: StructuredLogger;
  commitSha: string;
  fixCandidateId: number;
  replayBundle: PatchReplayBundle;
  scanId: number;
  sourceTarget: string;
  validation: ValidationResult;
  generatedPatch: GeneratedPatch;
}): void {
  const {
    candidateOutcome,
    candidateLogger,
    commitSha,
    fixCandidateId,
    replayBundle,
    scanId,
    sourceTarget,
    validation,
    generatedPatch,
  } = args;

  const patchPayload = {
    fix_candidate_id: fixCandidateId,
    patch_text: generatedPatch.patchText,
    touched_files: JSON.stringify(generatedPatch.touchedFiles),
    validation_status: validation.status,
    validation_summary: validation.summary,
  };

  getDb().transaction((patchRow: typeof patchPayload, replayBundleJson: string) => {
    const patchInfo = addPatch.run(patchRow);
    candidateOutcome.patchId = patchInfo.lastInsertRowid as number;
    candidateOutcome.validationStatus = validation.status;
    candidateOutcome.validationSummary = validation.summary;
    candidateOutcome.validationFailureCategory = validation.failureCategory ?? null;
    candidateLogger.info('patch.persisted', {
      patchId: candidateOutcome.patchId,
      validationStatus: validation.status,
    });
    addPatchReplay.run({
      patch_id: candidateOutcome.patchId,
      scan_id: scanId,
      source_target: sourceTarget,
      commit_sha: commitSha,
      replay_bundle: replayBundleJson,
    });
  })(patchPayload, JSON.stringify(replayBundle));
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

function buildObservationAttempts(
  analysis: SemanticAnalysisResult,
  candidateOutcomes: Map<string, CandidateOutcome>,
): ObservationAttempt[] {
  const planner = analysis.planner;
  if (planner) {
    const sourceAttempts = planner.attempts.length > 0 ? planner.attempts : planner.rankedCandidates;
    const rankedStrategyMap = new Map(planner.rankedCandidates.map((attempt, index) => [attempt.strategy, index + 1]));

    return sourceAttempts.map((attempt) => {
      const plannerRank = attempt.status === 'candidate' ? (rankedStrategyMap.get(attempt.strategy) ?? 0) : 0;
      const candidateKey = createCandidateKey(attempt.strategy, plannerRank);
      const outcome = candidateOutcomes.get(candidateKey);

      return {
        strategy: attempt.strategy,
        status: attempt.status,
        plannerRank,
        promotionEligible: outcome?.promotionEligible ?? false,
        summary: attempt.summary,
        classification: attempt.classification ?? null,
        confidence: attempt.confidence ?? null,
        upstreamabilityScore: attempt.score ?? null,
        reasons: attempt.reasons,
        scoreBreakdown: attempt.scoreBreakdown ?? null,
        signals: attempt.signals,
        plan: attempt.plan,
        fixCandidateId: outcome?.fixCandidateId ?? null,
        patchId: outcome?.patchId ?? null,
        validationStatus: outcome?.validationStatus ?? null,
        validationSummary: outcome?.validationSummary ?? null,
        validationFailureCategory: outcome?.validationFailureCategory ?? null,
      };
    });
  }

  const fallbackKey = createCandidateKey(classifyStrategy(analysis.classification), 1);
  const fallbackOutcome = candidateOutcomes.get(fallbackKey);
  return [
    {
      strategy: classifyStrategy(analysis.classification),
      status: analysis.classification.startsWith('autofix_') ? 'candidate' : 'rejected',
      plannerRank: 1,
      promotionEligible: fallbackOutcome?.promotionEligible ?? false,
      summary: analysis.reasons[0] ?? 'Fallback semantic analysis result.',
      classification: analysis.classification,
      confidence: analysis.confidence,
      upstreamabilityScore: analysis.upstreamabilityScore ?? null,
      reasons: analysis.reasons,
      scoreBreakdown: null,
      signals: null,
      plan: analysis.plan,
      fixCandidateId: fallbackOutcome?.fixCandidateId ?? null,
      patchId: fallbackOutcome?.patchId ?? null,
      validationStatus: fallbackOutcome?.validationStatus ?? null,
      validationSummary: fallbackOutcome?.validationSummary ?? null,
      validationFailureCategory: fallbackOutcome?.validationFailureCategory ?? null,
    },
  ];
}

function buildObservationRepoProfile(analysis?: SemanticAnalysisResult): string | null {
  const features = analysis?.planner?.features;
  if (!features) {
    return null;
  }

  return JSON.stringify({
    packageManager: features.packageManager,
    workspaceMode: features.workspaceMode,
    validationCommandCount: features.validationCommandCount,
  });
}

export function getNextCycleObservationVersion(cycleId: number): number {
  const latestObservation = getLatestCycleObservationByCycleId.get(cycleId) as
    | {
        observation_version: number;
      }
    | undefined;

  return (latestObservation?.observation_version ?? 0) + 1;
}

function createCandidateKey(strategy: string | null, plannerRank: number): string {
  return `${strategy ?? 'fallback'}::${plannerRank}`;
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
