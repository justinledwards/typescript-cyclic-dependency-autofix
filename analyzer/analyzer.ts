import { cruise } from 'dependency-cruiser';
import { type SemanticAnalysisResult, SemanticAnalyzer } from './semantic.js';

export interface CircularDependency {
  type: 'circular';
  path: string[];
  analysis?: SemanticAnalysisResult;
}

export async function analyzeRepository(repoPath: string): Promise<CircularDependency[]> {
  try {
    const result = await cruise([repoPath], {
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
    const semanticAnalyzer = new SemanticAnalyzer(repoPath);

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
            cyclePath.push(violation.from, ...violationWithCycle.cycle.map((c) => c.name));
          } else {
            cyclePath.push(violation.from, violation.to);
          }

          circularDependencies.push({
            type: 'circular',
            path: cyclePath,
            analysis: semanticAnalyzer.analyzeCycle(cyclePath),
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
