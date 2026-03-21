import path from 'node:path';
import { cruise } from 'dependency-cruiser';
import { profileRepository } from '../cli/repoProfile.js';
import { canonicalizeCyclePath } from './cycleNormalization.js';
import { loadHistoricalEvidence } from './semantic/evidence.js';
import type { PlannerRepositoryProfile } from './semantic.js';
import { type SemanticAnalysisResult, SemanticAnalyzer } from './semantic.js';

export interface CircularDependency {
  type: 'circular';
  path: string[];
  analysis?: SemanticAnalysisResult;
}

export async function analyzeRepository(repoPath: string): Promise<CircularDependency[]> {
  const resolvedRepoPath = path.resolve(repoPath);
  const repositoryProfile = await safePlannerRepositoryProfile(resolvedRepoPath);
  const historicalEvidence = loadHistoricalEvidence(repositoryProfile);

  try {
    const result = await cruise([resolvedRepoPath], {
      exclude: {
        path: ['node_modules', 'dist', 'coverage', 'build', String.raw`\.git`, String.raw`\.next`, String.raw`\.cache`],
      },
      includeOnly: {
        path: [String.raw`\.(js|jsx|ts|tsx)$`],
      },
      validate: true,
      ruleSet: {
        forbidden: [
          {
            name: 'no-circular',
            severity: 'warn',
            from: {},
            to: { circular: true },
          },
        ],
      },
    });

    const circularDependencies: CircularDependency[] = [];
    const semanticAnalyzer = new SemanticAnalyzer(resolvedRepoPath, {
      repositoryProfile,
      historicalEvidence,
    });

    const output = result.output;
    if (typeof output === 'string') {
      return circularDependencies;
    }

    if (output.summary.violations) {
      for (const violation of output.summary.violations) {
        if (violation.rule.name === 'no-circular') {
          const cyclePath: string[] = [];
          const violationWithCycle = violation as { cycle?: Array<{ name: string }> } & typeof violation;
          if (violation.type === 'cycle' && violationWithCycle.cycle) {
            cyclePath.push(
              normalizeModulePath(resolvedRepoPath, violation.from),
              ...violationWithCycle.cycle.map((c) => normalizeModulePath(resolvedRepoPath, c.name)),
            );
          } else {
            cyclePath.push(
              normalizeModulePath(resolvedRepoPath, violation.from),
              normalizeModulePath(resolvedRepoPath, violation.to),
            );
          }

          const canonicalCyclePath = canonicalizeCyclePath(cyclePath);

          circularDependencies.push({
            type: 'circular',
            path: canonicalCyclePath,
            analysis: semanticAnalyzer.analyzeCycle(canonicalCyclePath),
          });
        }
      }
    }

    return circularDependencies;
  } catch (error) {
    console.error('Error analyzing repository:', error);
    throw error;
  }
}

async function safePlannerRepositoryProfile(repoPath: string): Promise<PlannerRepositoryProfile | undefined> {
  try {
    const profile = await profileRepository(repoPath);
    return {
      packageManager: profile.packageManager,
      workspaceMode: profile.workspaceMode,
      validationCommandCount: profile.validationCommands.length,
    };
  } catch {
    return void 0;
  }
}

function normalizeModulePath(repoPath: string, modulePath: string): string {
  const normalizedModulePath = modulePath.split(path.sep).join('/');
  if (path.isAbsolute(modulePath)) {
    return path.relative(repoPath, modulePath).split(path.sep).join('/');
  }

  const repoRelativeCandidate = path.resolve(repoPath, modulePath);
  if (isWithinRepo(repoPath, repoRelativeCandidate)) {
    return path.relative(repoPath, repoRelativeCandidate).split(path.sep).join('/');
  }

  const cwdRelativeCandidate = path.resolve(process.cwd(), modulePath);
  if (isWithinRepo(repoPath, cwdRelativeCandidate)) {
    return path.relative(repoPath, cwdRelativeCandidate).split(path.sep).join('/');
  }

  return normalizedModulePath;
}

function isWithinRepo(repoPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(repoPath, candidatePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}
