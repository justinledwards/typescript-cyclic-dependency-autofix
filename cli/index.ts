import { Command } from 'commander';
import { exportApprovedPatches } from './exportPatches.js';
import { scanRepository } from './scanner.js';
import { formatSmokeSuiteResult, loadSmokeFixtures, runSmokeSuite } from './smoke.js';

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
    .command('export:patches')
    .argument('[outputDir]', 'Directory to write exported patch files to')
    .description('Export approved or PR-candidate patch files for PR generation')
    .action(async (outputDir?: string) => {
      const result = await exportApprovedPatches(outputDir);
      console.log(`Exported ${result.exportedCount} patch file(s) to ${result.outputDir}`);
    });

  program
    .command('smoke [fixturesFile]')
    .description('Run the smoke suite against a fixture list of real repositories')
    .action(async (fixturesFile = './smoke.fixtures.json') => {
      console.log(`Running smoke suite from ${fixturesFile}`);
      try {
        const fixtures = await loadSmokeFixtures(fixturesFile);
        const result = await runSmokeSuite(fixtures);
        console.log(formatSmokeSuiteResult(result));

        if (result.failed > 0) {
          process.exit(1);
        }
      } catch (error) {
        console.error(`Failed to run smoke suite from ${fixturesFile}:`, error);
        process.exit(1);
      }
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
