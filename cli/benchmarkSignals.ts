const DEFAULT_SEARCH_TERMS = [
  'circular dependency',
  'cyclic dependency',
  'circular import',
  'import type',
  'type-only',
  'barrel',
  're-export',
  'reexport',
  'index.ts',
  'index.js',
  'extract shared',
  'move helper',
  'break cycle',
  'internal.ts',
  'internal.js',
];

export function getDefaultBenchmarkSearchTerms(): string[] {
  return [...DEFAULT_SEARCH_TERMS];
}

export function normalizeSearchTerms(terms: string[]): string[] {
  return [...new Set(terms.map((term) => term.trim().toLowerCase()).filter(Boolean))];
}

export function findMatchedTerms(text: string, searchTerms: string[]): string[] {
  const lowerText = text.toLowerCase();
  const matchedTerms = new Set(searchTerms.filter((term) => lowerText.includes(term)));

  if (containsWholeWord(lowerText, 'circular')) {
    matchedTerms.add('circular');
  }
  if (containsWholeWord(lowerText, 'cyclic')) {
    matchedTerms.add('cyclic');
  }
  if (containsCycleContext(lowerText, ['import'])) {
    matchedTerms.add('import cycle');
  }
  if (containsCycleContext(lowerText, ['export', 're-export', 'reexport'])) {
    matchedTerms.add('export cycle');
  }
  if (containsCycleContext(lowerText, ['barrel'])) {
    matchedTerms.add('barrel cycle');
  }
  if (containsCycleContext(lowerText, ['dependency', 'dependencies'])) {
    matchedTerms.add('dependency cycle');
  }
  if (containsCycleContext(lowerText, ['break'])) {
    matchedTerms.add('break cycle');
  }

  return [...matchedTerms];
}

function containsWholeWord(text: string, word: string): boolean {
  return new RegExp(String.raw`\b${escapeForRegex(word)}\b`, 'i').test(text);
}

function containsCycleContext(text: string, keywords: string[]): boolean {
  return text.split('\n').some((segment) => {
    if (!/\bcycles?\b/i.test(segment)) {
      return false;
    }

    return keywords.some((keyword) => segment.includes(keyword));
  });
}

function escapeForRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

export function classifyStrategyLabels(commitText: string): string[] {
  const lowerText = commitText.toLowerCase();
  const labels = new Set<string>();

  if (/import\s+type|type-only|type only/.test(lowerText)) {
    labels.add('import_type');
    labels.add('type_runtime_split');
  }

  if (/barrel|re-?export|index\.(ts|tsx|js|jsx)/.test(lowerText)) {
    labels.add('barrel_reexport_cleanup');
    labels.add('direct_import');
  }

  if (/extract shared|shared module|shared file|move helper|split helper|leaf-like/.test(lowerText)) {
    labels.add('extract_shared');
    labels.add('leaf_cluster_extraction');
  }

  if (/setter|state update|host-owned|stateful singleton|dependency inversion/.test(lowerText)) {
    labels.add('host_owned_state_update');
    labels.add('stateful_singleton_split');
  }

  if (/internal\.(ts|js)|module loading order|internal entrypoint/.test(lowerText)) {
    labels.add('internal_entrypoint_pattern');
  }

  if (labels.size === 0) {
    labels.add('unclassified');
  }

  return [...labels];
}
