export const DEFAULT_MIN_PATCH_CONFIDENCE = 0.8;
export const DEFAULT_MIN_UPSTREAMABILITY_SCORE = 0.78;
const MIN_SCORE_ENV_VAR = 'AUTOFIX_MIN_PR_SCORE';

export interface PromotionPolicyCandidate {
  classification: string;
  confidence: number;
  upstreamabilityScore?: number;
  hasPlan?: boolean;
}

export function shouldPromotePatchCandidate(candidate: PromotionPolicyCandidate): boolean {
  if (!candidate.hasPlan) {
    return false;
  }

  if (!candidate.classification.startsWith('autofix_')) {
    return false;
  }

  return (
    candidate.confidence >= DEFAULT_MIN_PATCH_CONFIDENCE &&
    (candidate.upstreamabilityScore ?? 0) >= DEFAULT_MIN_UPSTREAMABILITY_SCORE
  );
}

export function resolveMinimumUpstreamabilityScore(explicitValue?: number): number {
  if (explicitValue !== undefined) {
    return validateScore(explicitValue, 'explicit minimum upstreamability score');
  }

  const envValue = process.env[MIN_SCORE_ENV_VAR];
  if (!envValue) {
    return DEFAULT_MIN_UPSTREAMABILITY_SCORE;
  }

  return validateScore(Number(envValue), `environment variable ${MIN_SCORE_ENV_VAR}`);
}

function validateScore(value: number, source: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Expected ${source} to be a number between 0 and 1. Received: ${value}`);
  }

  return Number(value.toFixed(2));
}
