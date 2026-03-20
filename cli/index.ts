import { Command } from 'commander';
import { analyzeRepository } from '../analyzer/analyzer.js';
import { createPullRequestForPatch } from './createPullRequest.js';
import { exportApprovedPatches } from './exportPatches.js';
import { scanRepository } from './scanner.js';

export function createProgram(): Command {
  const program = new Command();

  program.name('autofix-bot').description('Circular Dependency Autofix Bot CLI').version('1.0.0');

  program
    .command('scan <repo>')
    .description('Run the dependency analyzer and classifier on a target repository')
    .action(async (repo: string) => {
      console.log(`Scanning repository: ${repo}`);
      try {
        const result = await scanRepository(repo);
        console.log(`Scan completed successfully (Scan ID: ${result.scanId}). Found ${result.cyclesFound} cycles.`);
      } catch (error) {
        console.error(`Failed to scan repository ${repo}:`, error);
        process.exit(1);
      }
    });

  program
    .command('explain <repo>')
    .description('Explain the planner output for each detected cycle in a target repository')
    .action(async (repo: string) => {
      try {
        const cycles = await analyzeRepository(repo);
        console.log(
          JSON.stringify(
            {
              repo,
              cycleCount: cycles.length,
              cycles: cycles.map((cycle, index) => ({
                id: index + 1,
                path: cycle.path,
                analysis: cycle.analysis
                  ? {
                      classification: cycle.analysis.classification,
                      confidence: cycle.analysis.confidence,
                      reasons: cycle.analysis.reasons,
                      plan: cycle.analysis.plan,
                      upstreamabilityScore: cycle.analysis.upstreamabilityScore,
                      planner: cycle.analysis.planner,
                    }
                  : undefined,
              })),
            },
            null,
            2,
          ),
        );
      } catch (error) {
        console.error(`Failed to explain repository ${repo}:`, error);
        process.exit(1);
      }
    });

  program
    .command('scan:all')
    .description('Scan all tracked repositories in the database')
    .action(() => {
      console.log('Scanning all tracked repositories...');
    });

  program
    .command('retry:failed')
    .description('Retry failed patch candidates')
    .action(() => {
      console.log('Retrying failed patch candidates...');
    });

  program
    .command('create:pr <patchId>')
    .requiredOption('--issue <number>', 'Linked issue number to close in the target repository')
    .option('--title <title>', 'Pull request title override')
    .option('--branch <branchName>', 'Branch name override')
    .option('--base <branchName>', 'Base branch override')
    .option('--repo-path <path>', 'Use an existing clean checkout instead of a scratch clone')
    .description('Create a branch and GitHub pull request from a stored validated patch')
    .action(
      async (
        patchId: string,
        options: {
          issue: string;
          title?: string;
          branch?: string;
          base?: string;
          repoPath?: string;
        },
      ) => {
        const numericPatchId = Number(patchId);
        if (!Number.isInteger(numericPatchId) || numericPatchId <= 0) {
          console.error(`Invalid patch ID: ${patchId}`);
          process.exit(1);
        }

        const linkedIssueNumber = Number(options.issue);
        if (!Number.isInteger(linkedIssueNumber) || linkedIssueNumber <= 0) {
          console.error(`Invalid issue number: ${options.issue}`);
          process.exit(1);
        }

        try {
          const result = await createPullRequestForPatch(numericPatchId, {
            linkedIssueNumber,
            title: options.title,
            branchName: options.branch,
            baseBranch: options.base,
            repoPath: options.repoPath,
          });
          console.log(`Created PR ${result.prUrl} from branch ${result.branchName}`);
        } catch (error) {
          console.error(`Failed to create PR for patch ${patchId}:`, error);
          process.exit(1);
        }
      },
    );

  program
    .command('export:patches')
    .argument('[outputDir]', 'Directory to write exported patch files to')
    .description('Export approved or PR-candidate patch files for PR generation')
    .action(async (outputDir?: string) => {
      const result = await exportApprovedPatches(outputDir);
      console.log(`Exported ${result.exportedCount} patch file(s) to ${result.outputDir}`);
    });

  return program;
}

// Run when executed directly
/* v8 ignore start */
const isMainModule = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js');
if (isMainModule) {
  await createProgram().parseAsync(process.argv);
}
/* v8 ignore stop */
