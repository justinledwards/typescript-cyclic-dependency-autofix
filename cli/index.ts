import { Command } from 'commander';
import { analyzeRepository } from '../analyzer/analyzer.js';
import {
  getPatternReport,
  getStrategyPerformanceReport,
  getUnsupportedClustersReport,
} from '../db/observationReports.js';
import {
  annotateAcceptanceBenchmarkCase,
  getAcceptanceBenchmarkReport,
  runAcceptanceBenchmark,
} from './acceptanceBenchmark.js';
import { mineBenchmarkCasesFromCorpus } from './benchmarkCorpus.js';
import { mineBenchmarkCasesFromRepo } from './benchmarkMiner.js';
import { createPullRequestForPatch } from './createPullRequest.js';
import { exportApprovedPatches } from './exportPatches.js';
import { exportTrainingData, type TrainingDataFormat } from './exportTrainingData.js';
import { type BenchmarkDatasetFormat, importBenchmarkDataset } from './importBenchmarkDataset.js';
import { getOperationalMetrics } from './metrics.js';
import {
  createConcurrencyLimiter,
  createStructuredLogger,
  resolveConcurrencySetting,
  type StructuredLogger,
} from './observability.js';
import { profileRepository } from './repoProfile.js';
import { rescoreStoredCycles, retryFailedPatchCandidates } from './rescore.js';
import { scanAllTrackedRepositories } from './scanAll.js';
import { scanRepository } from './scanner.js';
import { formatSmokeSuiteResult, loadSmokeFixtures, runSmokeSuite } from './smoke.js';

const WORKTREES_DIR_OPTION_DESCRIPTION = 'Directory to use for repository worktrees';
const SCAN_WORKTREES_DIR_OPTION_DESCRIPTION = 'Directory to use for scan worktrees';
const VALIDATION_CONCURRENCY_OPTION_DESCRIPTION = 'Maximum concurrent validation jobs';
const LIMIT_OPTION_DESCRIPTION = 'Limit how many corpus repositories are processed';
const WORKTREES_DIR_OPTION = '--worktrees-dir <path>';
const VALIDATION_CONCURRENCY_OPTION = '--validation-concurrency <count>';
const LIMIT_OPTION = '--limit <count>';

export function createProgram(): Command {
  const program = new Command();

  program.name('autofix-bot').description('Circular Dependency Autofix Bot CLI').version('1.0.0');

  program
    .command('scan <repo>')
    .description('Run the dependency analyzer and classifier on a target repository')
    .option(WORKTREES_DIR_OPTION, SCAN_WORKTREES_DIR_OPTION_DESCRIPTION)
    .option(VALIDATION_CONCURRENCY_OPTION, VALIDATION_CONCURRENCY_OPTION_DESCRIPTION, parseInteger)
    .action(async (repo: string, options: { worktreesDir?: string; validationConcurrency?: number }) => {
      console.log(`Scanning repository: ${repo}`);
      try {
        const result = await scanRepository(repo, options.worktreesDir, {
          logger: createCliLogger(),
          validationLimiter: createConcurrencyLimiter(
            resolveConcurrencySetting(options.validationConcurrency, 'AUTOFIX_VALIDATION_CONCURRENCY', 1),
          ),
        });
        console.log(`Scan completed successfully (Scan ID: ${result.scanId}). Found ${result.cyclesFound} cycles.`);
      } catch (error) {
        console.error(`Failed to scan repository ${repo}:`, error);
        process.exit(1);
      }
    });

  program
    .command('smoke [fixturesPath]')
    .description('Run the real-repo smoke suite from a fixture list')
    .option(WORKTREES_DIR_OPTION, 'Directory to use for smoke suite worktrees')
    .action(async (fixturesPath = 'smoke.fixtures.json', options: { worktreesDir?: string }) => {
      try {
        const fixtures = await loadSmokeFixtures(fixturesPath);
        const result = await runSmokeSuite(fixtures, {
          worktreesDir: options.worktreesDir,
        });
        console.log(formatSmokeSuiteResult(result));

        if (result.failed > 0) {
          process.exit(1);
        }
      } catch (error) {
        console.error(`Failed to run smoke suite from ${fixturesPath}:`, error);
        process.exit(1);
      }
    });

  program
    .command('benchmark:acceptance')
    .description('Scan the benchmark corpus and snapshot acceptance-ready cycle candidates')
    .option(
      '--only <slug>',
      'Restrict benchmarking to a specific corpus repository slug or repo name',
      collectString,
      [],
    )
    .option('--search-root <path>', 'Additional root path to search for local repository checkouts', collectString, [])
    .option('--workspace <path>', 'Directory to clone missing repositories into before benchmarking')
    .option('--clone-missing', 'Clone missing repositories into the workspace before benchmarking')
    .option(LIMIT_OPTION, LIMIT_OPTION_DESCRIPTION, parseInteger)
    .option('--scan-worktrees-dir <path>', 'Directory to use for temporary scan worktrees')
    .action(
      async (options: {
        only: string[];
        searchRoot: string[];
        workspace?: string;
        cloneMissing?: boolean;
        limit?: number;
        scanWorktreesDir?: string;
      }) => {
        try {
          const result = await runAcceptanceBenchmark({
            onlyRepositories: options.only,
            searchRoots: options.searchRoot,
            workspaceDir: options.workspace,
            cloneMissing: options.cloneMissing,
            limit: options.limit,
            scanWorktreesDir: options.scanWorktreesDir,
          });
          console.log(JSON.stringify(result, null, 2));
        } catch (error) {
          console.error('Failed to build the acceptance benchmark:', error);
          process.exit(1);
        }
      },
    );

  program
    .command('benchmark:acceptance:report')
    .description('Print the stored acceptance benchmark cases and summary report')
    .action(() => {
      try {
        const result = getAcceptanceBenchmarkReport();
        console.log(JSON.stringify(result, null, 2));
      } catch (error) {
        console.error('Failed to load the acceptance benchmark report:', error);
        process.exit(1);
      }
    });

  program
    .command('benchmark:acceptance:annotate <caseId>')
    .description('Annotate an acceptance benchmark case with a review outcome')
    .requiredOption('--acceptability <decision>', 'accepted, needs_review, or rejected')
    .option(
      '--rejection-reason <reason>',
      'diff_noisy, validation_weak, semantic_wrong, repo_conventions_mismatch, or other',
    )
    .option('--note <note>', 'Optional note describing the review outcome')
    .action(
      async (
        caseId: string,
        options: {
          acceptability: string;
          rejectionReason?: string;
          note?: string;
        },
      ) => {
        const numericCaseId = Number(caseId);
        if (!Number.isInteger(numericCaseId) || numericCaseId <= 0) {
          console.error(`Invalid acceptance benchmark case ID: ${caseId}`);
          process.exit(1);
        }

        try {
          const result = annotateAcceptanceBenchmarkCase(numericCaseId, {
            acceptability: parseAcceptanceDecision(options.acceptability),
            rejectionReason: parseAcceptanceRejectionReason(options.rejectionReason),
            note: options.note,
          });
          console.log(JSON.stringify(result, null, 2));
        } catch (error) {
          console.error(`Failed to annotate acceptance benchmark case ${caseId}:`, error);
          process.exit(1);
        }
      },
    );

  program
    .command('benchmark:import <inputPath>')
    .description('Import external benchmark dataset rows into the benchmark database')
    .option('--dataset <name>', 'Dataset label to persist alongside imported rows')
    .option('--source <source>', 'Override the stored benchmark source label')
    .option('--format <format>', 'Import format: json, jsonl, or parquet', parseBenchmarkDatasetFormat)
    .option('--max-rows <count>', 'Limit how many dataset rows are processed', parseInteger)
    .option('--search-term <term>', 'Additional cycle-related search term to match', collectString, [])
    .option('--allow-unrelated', 'Import JS/TS rows even when they do not match cycle-related terms')
    .action(
      async (
        inputPath: string,
        options: {
          dataset?: string;
          source?: string;
          format?: BenchmarkDatasetFormat;
          maxRows?: number;
          searchTerm: string[];
          allowUnrelated?: boolean;
        },
      ) => {
        try {
          const result = await importBenchmarkDataset(inputPath, {
            datasetName: options.dataset,
            source: options.source,
            format: options.format,
            maxRows: options.maxRows,
            searchTerms: options.searchTerm.length > 0 ? options.searchTerm : undefined,
            relatedOnly: !options.allowUnrelated,
          });
          console.log(JSON.stringify(result, null, 2));
        } catch (error) {
          console.error(`Failed to import benchmark dataset ${inputPath}:`, error);
          process.exit(1);
        }
      },
    );

  program
    .command('mine:corpus')
    .description('Mine benchmark cases across the curated TypeScript repository corpus')
    .option('--only <slug>', 'Restrict mining to a specific corpus repository slug or repo name', collectString, [])
    .option('--search-root <path>', 'Additional root path to search for local repository checkouts', collectString, [])
    .option('--workspace <path>', 'Directory to clone missing repositories into before mining')
    .option('--clone-missing', 'Clone missing repositories into the workspace before mining')
    .option(LIMIT_OPTION, LIMIT_OPTION_DESCRIPTION, parseInteger)
    .option('--max-commits <count>', 'Limit how many commits are scanned per repository', parseInteger)
    .option('--max-matches <count>', 'Limit how many benchmark cases are stored per repository', parseInteger)
    .action(
      async (options: {
        only: string[];
        searchRoot: string[];
        workspace?: string;
        cloneMissing?: boolean;
        limit?: number;
        maxCommits?: number;
        maxMatches?: number;
      }) => {
        try {
          const result = await mineBenchmarkCasesFromCorpus({
            onlyRepositories: options.only,
            searchRoots: options.searchRoot,
            workspaceDir: options.workspace,
            cloneMissing: options.cloneMissing,
            limit: options.limit,
            maxCommits: options.maxCommits,
            maxMatches: options.maxMatches,
          });
          console.log(JSON.stringify(result, null, 2));
        } catch (error) {
          console.error('Failed to mine the benchmark corpus:', error);
          process.exit(1);
        }
      },
    );

  program
    .command('mine:repo-history <repo>')
    .description('Mine commit messages from a local git repository into the benchmark database')
    .option('--label <label>', 'Override the repository label stored in the benchmark database')
    .option('--max-commits <count>', 'Limit how many commits are scanned', parseInteger)
    .option('--max-matches <count>', 'Limit how many benchmark cases are stored', parseInteger)
    .action(async (repo: string, options: { label?: string; maxCommits?: number; maxMatches?: number }) => {
      console.log(`Mining benchmark cases from repository: ${repo}`);
      try {
        const result = await mineBenchmarkCasesFromRepo(repo, {
          repositoryLabel: options.label,
          maxCommits: options.maxCommits,
          maxMatches: options.maxMatches,
        });
        console.log(
          `Mined ${result.insertedCases} benchmark case(s) from ${result.matchedCommits} matching commit(s) in ${result.repository}.`,
        );
      } catch (error) {
        console.error(`Failed to mine benchmark cases from repository ${repo}:`, error);
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
    .command('profile:repo <repo>')
    .description('Profile a repository checkout and infer validation commands')
    .action(async (repo: string) => {
      try {
        const profile = await profileRepository(repo);
        console.log(JSON.stringify(profile, null, 2));
      } catch (error) {
        console.error(`Failed to profile repository ${repo}:`, error);
        process.exit(1);
      }
    });

  program
    .command('scan:all')
    .description('Scan all tracked repositories in the database')
    .option(WORKTREES_DIR_OPTION, SCAN_WORKTREES_DIR_OPTION_DESCRIPTION)
    .option('--concurrency <count>', 'Maximum concurrent repository scans', parseInteger)
    .option(VALIDATION_CONCURRENCY_OPTION, VALIDATION_CONCURRENCY_OPTION_DESCRIPTION, parseInteger)
    .action(async (options: { worktreesDir?: string; concurrency?: number; validationConcurrency?: number }) => {
      try {
        const result = await scanAllTrackedRepositories({
          worktreesDir: options.worktreesDir,
          scanConcurrency: options.concurrency,
          validationConcurrency: options.validationConcurrency,
          logger: createCliLogger(),
        });
        console.log(JSON.stringify(result, null, 2));

        if (result.failed > 0) {
          process.exit(1);
        }
      } catch (error) {
        console.error('Failed to scan tracked repositories:', error);
        process.exit(1);
      }
    });
  program
    .command('metrics:report')
    .description('Print aggregated operational scan and review metrics')
    .action(() => {
      try {
        console.log(JSON.stringify(getOperationalMetrics(), null, 2));
      } catch (error) {
        console.error('Failed to load operational metrics:', error);
        process.exit(1);
      }
    });

  program
    .command('report:patterns')
    .description('Print recurring cycle-shape, failure-cluster, and unsupported-cluster summaries')
    .action(() => {
      try {
        console.log(JSON.stringify(getPatternReport(), null, 2));
      } catch (error) {
        console.error('Failed to build the pattern report:', error);
        process.exit(1);
      }
    });

  program
    .command('report:strategy-performance')
    .description('Print strategy performance grouped by repository profile and acceptance history')
    .action(() => {
      try {
        console.log(JSON.stringify(getStrategyPerformanceReport(), null, 2));
      } catch (error) {
        console.error('Failed to build the strategy performance report:', error);
        process.exit(1);
      }
    });

  program
    .command('report:unsupported-clusters')
    .description('Print the most recurrent unsupported or manual-review cycle clusters')
    .action(() => {
      try {
        console.log(JSON.stringify(getUnsupportedClustersReport(), null, 2));
      } catch (error) {
        console.error('Failed to build the unsupported cluster report:', error);
        process.exit(1);
      }
    });

  program
    .command('rescore')
    .description('Recompute planner rankings for stored cycles and append new observation versions')
    .option('--cycle-id <id>', 'Restrict rescoring to a specific stored cycle ID', collectInteger, [])
    .option(LIMIT_OPTION, 'Limit how many stored cycles are rescored', parseInteger)
    .option(WORKTREES_DIR_OPTION, WORKTREES_DIR_OPTION_DESCRIPTION)
    .option(VALIDATION_CONCURRENCY_OPTION, VALIDATION_CONCURRENCY_OPTION_DESCRIPTION, parseInteger)
    .option('--only-failed', 'Only rescore cycles whose latest candidate observations failed validation')
    .action(
      async (options: {
        cycleId: number[];
        limit?: number;
        worktreesDir?: string;
        validationConcurrency?: number;
        onlyFailed?: boolean;
      }) => {
        try {
          const result = await rescoreStoredCycles({
            cycleIds: options.cycleId,
            limit: options.limit,
            worktreesDir: options.worktreesDir,
            onlyFailed: options.onlyFailed,
            logger: createCliLogger(),
            validationLimiter: createConcurrencyLimiter(
              resolveConcurrencySetting(options.validationConcurrency, 'AUTOFIX_VALIDATION_CONCURRENCY', 1),
            ),
          });
          console.log(JSON.stringify(result, null, 2));
        } catch (error) {
          console.error('Failed to rescore stored cycles:', error);
          process.exit(1);
        }
      },
    );

  program
    .command('retry:failed')
    .description('Retry failed patch candidates')
    .option(LIMIT_OPTION, 'Limit how many failed cycles are retried', parseInteger)
    .option(WORKTREES_DIR_OPTION, WORKTREES_DIR_OPTION_DESCRIPTION)
    .option(VALIDATION_CONCURRENCY_OPTION, VALIDATION_CONCURRENCY_OPTION_DESCRIPTION, parseInteger)
    .action(async (options: { limit?: number; worktreesDir?: string; validationConcurrency?: number }) => {
      try {
        const result = await retryFailedPatchCandidates({
          limit: options.limit,
          worktreesDir: options.worktreesDir,
          logger: createCliLogger(),
          validationLimiter: createConcurrencyLimiter(
            resolveConcurrencySetting(options.validationConcurrency, 'AUTOFIX_VALIDATION_CONCURRENCY', 1),
          ),
        });
        console.log(JSON.stringify(result, null, 2));
      } catch (error) {
        console.error('Failed to retry failed patch candidates:', error);
        process.exit(1);
      }
    });

  program
    .command('create:pr <patchId>')
    .requiredOption('--issue <number>', 'Linked issue number to close in the target repository')
    .option('--title <title>', 'Pull request title override')
    .option('--branch <branchName>', 'Branch name override')
    .option('--base <branchName>', 'Base branch override')
    .option('--repo-path <path>', 'Use an existing clean checkout instead of a scratch clone')
    .option('--min-score <score>', 'Minimum upstreamability score required before opening a PR', parseScore)
    .option('--allow-below-threshold', 'Allow PR creation even when the stored upstreamability score is too low')
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
          minScore?: number;
          allowBelowThreshold?: boolean;
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
            minimumUpstreamabilityScore: options.minScore,
            allowBelowThreshold: options.allowBelowThreshold,
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
      const result = await exportApprovedPatches(outputDir, undefined, createCliLogger());
      console.log(`Exported ${result.exportedCount} patch file(s) to ${result.outputDir}`);
    });

  program
    .command('export:training-data')
    .argument('[outputPath]', 'Path to write the exported training dataset to')
    .option('--format <format>', 'Export format: jsonl, json, or parquet', parseTrainingDataFormat, 'jsonl')
    .description('Export model-ready training data from observations, benchmarks, and reviews')
    .action(async (outputPath: string | undefined, options: { format: TrainingDataFormat }) => {
      try {
        const result = await exportTrainingData(outputPath, {
          format: options.format,
        });
        console.log(JSON.stringify(result, null, 2));
      } catch (error) {
        console.error('Failed to export training data:', error);
        process.exit(1);
      }
    });

  return program;
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative integer. Received: ${value}`);
  }

  return parsed;
}

function parseScore(value: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`Expected a score between 0 and 1. Received: ${value}`);
  }

  return parsed;
}

function collectString(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function collectInteger(value: string, previous: number[]): number[] {
  return [...previous, parseInteger(value)];
}

function createCliLogger(): StructuredLogger {
  return createStructuredLogger((line) => {
    console.error(line);
  });
}

function parseAcceptanceDecision(value: string): 'accepted' | 'needs_review' | 'rejected' {
  if (value === 'accepted' || value === 'needs_review' || value === 'rejected') {
    return value;
  }

  throw new Error(`Expected an acceptance decision of accepted, needs_review, or rejected. Received: ${value}`);
}

function parseAcceptanceRejectionReason(
  value?: string,
): 'diff_noisy' | 'other' | 'repo_conventions_mismatch' | 'semantic_wrong' | 'validation_weak' | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (
    value === 'diff_noisy' ||
    value === 'other' ||
    value === 'repo_conventions_mismatch' ||
    value === 'semantic_wrong' ||
    value === 'validation_weak'
  ) {
    return value;
  }

  throw new Error(
    `Expected a rejection reason of diff_noisy, validation_weak, semantic_wrong, repo_conventions_mismatch, or other. Received: ${value}`,
  );
}

function parseTrainingDataFormat(value: string): TrainingDataFormat {
  if (value === 'json' || value === 'jsonl' || value === 'parquet') {
    return value;
  }

  throw new Error(`Expected a training-data export format of json, jsonl, or parquet. Received: ${value}`);
}

function parseBenchmarkDatasetFormat(value: string): BenchmarkDatasetFormat {
  if (value === 'json' || value === 'jsonl' || value === 'parquet') {
    return value;
  }

  throw new Error(`Expected a benchmark dataset format of json, jsonl, or parquet. Received: ${value}`);
}

// Run when executed directly
/* v8 ignore start */
const isMainModule = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js');
if (isMainModule) {
  await createProgram().parseAsync(process.argv);
}
/* v8 ignore stop */
