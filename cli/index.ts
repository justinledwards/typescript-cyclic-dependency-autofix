import { Command } from 'commander';
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
    .description('Export approved patch files for PR generation')
    .action(() => {
      console.log('Exporting approved patch files...');
    });

  return program;
}

// Run when executed directly
/* v8 ignore start */
const isMainModule = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js');
if (isMainModule) {
  createProgram().parse(process.argv);
}
/* v8 ignore stop */
