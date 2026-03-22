const DEFAULT_SEARCH_TERMS = [
  'circular dependency',
  'cyclic dependency',
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
  return searchTerms.filter((term) => lowerText.includes(term));
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
