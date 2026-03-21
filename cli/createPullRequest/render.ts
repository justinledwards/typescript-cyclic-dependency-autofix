import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { PullRequestCandidate } from './types.js';
import { hasErrorCode } from './utils.js';

const execFileAsync = promisify(execFile);

export function buildPullRequestTitle(candidate: PullRequestCandidate): string {
  const basenames = [...new Set(candidate.cyclePath.map((filePath) => path.basename(filePath)))];
  if (basenames.length >= 2) {
    return `Break circular dependency between ${basenames[0]} and ${basenames[1]}`;
  }

  return `Break circular dependency for patch ${candidate.patchId}`;
}

export function buildPullRequestBody(candidate: PullRequestCandidate, linkedIssueNumber: number): string {
  const touchedFiles =
    candidate.touchedFiles.length > 0
      ? candidate.touchedFiles
      : candidate.replay.file_snapshots.map((snapshot) => snapshot.path);
  const reasons = candidate.reasons.length > 0 ? candidate.reasons : (candidate.replay.candidate.reasons ?? []);
  const confidence = `${Math.round(candidate.confidence * 100)}%`;

  return [
    `Closes #${linkedIssueNumber}`,
    '',
    '## Summary',
    `- Classification: \`${candidate.classification}\``,
    `- Confidence: ${confidence}`,
    `- Cycle: \`${candidate.normalizedPath}\``,
    `- Source target: \`${candidate.replay.source_target}\``,
    `- Source commit: \`${candidate.commitSha}\``,
    `- Patch ID: ${candidate.patchId}`,
    `- Scan ID: ${candidate.scanId}`,
    '',
    '## Touched Files',
    ...touchedFiles.map((filePath) => `- \`${filePath}\``),
    '',
    '## Reasons',
    ...(reasons.length > 0 ? reasons.map((reason) => `- ${reason}`) : ['- No explicit reasons were stored.']),
    '',
    '## Validation',
    candidate.validationSummary,
  ].join('\n');
}

export async function createGithubPullRequest(args: {
  owner: string;
  name: string;
  baseBranch: string;
  branchName: string;
  title: string;
  body: string;
  cwd: string;
}): Promise<string> {
  try {
    const result = await execFileAsync(
      'gh',
      [
        'pr',
        'create',
        '--repo',
        `${args.owner}/${args.name}`,
        '--base',
        args.baseBranch,
        '--head',
        args.branchName,
        '--title',
        args.title,
        '--body',
        args.body,
      ],
      { cwd: args.cwd },
    );

    const stdout = typeof result === 'string' ? result : result.stdout;
    return stdout.trim();
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      throw new Error('GitHub CLI `gh` is required to create pull requests automatically.', { cause: error });
    }

    throw error;
  }
}
