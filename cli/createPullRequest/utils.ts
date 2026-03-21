export function hasErrorCode(error: unknown, code: string): boolean {
  return (
    !!error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && error.code === code
  );
}

export function buildGitHubCloneUrl(owner: string, name: string): string {
  return `https://github.com/${owner}/${name}.git`;
}

export function parseJsonArray(value: string | null): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function sanitizeSegment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]+/g, '-');
}
