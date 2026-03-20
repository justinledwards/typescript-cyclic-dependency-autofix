export type BenchmarkCorpusGroup = 'calibration' | 'stable-core' | 'watchlist';

const CALIBRATION_GROUP: BenchmarkCorpusGroup = 'calibration';
const STABLE_CORE_GROUP: BenchmarkCorpusGroup = 'stable-core';
const WATCHLIST_GROUP: BenchmarkCorpusGroup = 'watchlist';

export interface BenchmarkCorpusEntry {
  slug: string;
  groups: BenchmarkCorpusGroup[];
  description: string;
  patterns: string[];
}

export const BENCHMARK_REPO_CORPUS: BenchmarkCorpusEntry[] = [
  {
    slug: 'openclaw/openclaw',
    groups: [CALIBRATION_GROUP],
    description: 'Already gave us a real accepted-quality cycle fix candidate and an upstream PR path.',
    patterns: ['extract_shared', 'stateful_singleton_split', 'ui_feature_slice'],
  },
  {
    slug: 'microsoft/vscode',
    groups: [STABLE_CORE_GROUP],
    description:
      'Huge TypeScript app with workbench services, deep package boundaries, and likely barrel-heavy feature slices.',
    patterns: ['direct_import', 'barrel_reexport', 'stateful_singleton_split', 'public_api_reexport'],
  },
  {
    slug: 'microsoft/TypeScript',
    groups: [STABLE_CORE_GROUP],
    description: 'High-value compiler codebase with API layering and module init order risk.',
    patterns: ['module_init_order', 'import_type', 'public_api_reexport'],
  },
  {
    slug: 'angular/angular',
    groups: [STABLE_CORE_GROUP],
    description: 'Public API barrels and package-level re-exports are likely common.',
    patterns: ['direct_import', 'barrel_reexport', 'internal_entrypoint_pattern', 'public_api_reexport'],
  },
  {
    slug: 'elastic/kibana',
    groups: [STABLE_CORE_GROUP],
    description:
      'Massive UI plus plugin architecture with likely rich cross-feature cycles and stateful service splits.',
    patterns: ['stateful_singleton_split', 'direct_import', 'extract_shared'],
  },
  {
    slug: 'grafana/grafana',
    groups: [STABLE_CORE_GROUP],
    description: 'Large app with frontend feature modules and shared helpers.',
    patterns: ['extract_shared', 'direct_import', 'barrel_reexport'],
  },
  {
    slug: 'backstage/backstage',
    groups: [STABLE_CORE_GROUP],
    description:
      'Package-level APIs, plugin surfaces, and index re-exports make it useful for public API and barrel-cycle analysis.',
    patterns: ['direct_import', 'public_api_reexport', 'internal_entrypoint_pattern'],
  },
  {
    slug: 'storybookjs/storybook',
    groups: [STABLE_CORE_GROUP, WATCHLIST_GROUP],
    description: 'Popular, active TypeScript repo with package boundaries, builders, and UI runtime layers.',
    patterns: ['direct_import', 'import_type', 'public_api_reexport', 'barrel_reexport'],
  },
  {
    slug: 'yarnpkg/berry',
    groups: [STABLE_CORE_GROUP, WATCHLIST_GROUP],
    description: 'Dense package graph and strong module boundaries.',
    patterns: ['module_init_order', 'direct_import', 'public_api_reexport'],
  },
  {
    slug: 'appsmithorg/appsmith',
    groups: [STABLE_CORE_GROUP],
    description: 'Real product app with frontend state, pages, and shared logic.',
    patterns: ['extract_shared', 'stateful_singleton_split', 'direct_import'],
  },
  {
    slug: 'BabylonJS/Babylon.js',
    groups: [STABLE_CORE_GROUP],
    description: 'Class-heavy TypeScript codebase with runtime-initialization and inheritance-style cycle cases.',
    patterns: ['module_init_order', 'internal_entrypoint_pattern', 'public_api_reexport'],
  },
  {
    slug: 'typescript-eslint/typescript-eslint',
    groups: [STABLE_CORE_GROUP],
    description: 'Strong type/value separation, useful for testing how often import type truly solves real cycles.',
    patterns: ['import_type', 'public_api_reexport', 'direct_import'],
  },
  {
    slug: 'microsoft/fluentui',
    groups: [STABLE_CORE_GROUP],
    description:
      'Component package barrels and public surface re-exports make it useful for de-barrel and internal-entrypoint experiments.',
    patterns: ['direct_import', 'barrel_reexport', 'internal_entrypoint_pattern'],
  },
  {
    slug: 'anomalyco/opencode',
    groups: [WATCHLIST_GROUP],
    description: 'Large and fast-moving TypeScript app with modern agent-ui and workspace-service cycles.',
    patterns: ['stateful_singleton_split', 'direct_import', 'extract_shared'],
  },
  {
    slug: 'Open-Dev-Society/OpenStock',
    groups: [WATCHLIST_GROUP],
    description: 'Modern TS app with active development; useful for pattern diversity outside infra/tooling repos.',
    patterns: ['extract_shared', 'stateful_singleton_split'],
  },
  {
    slug: 'vas3k/TaxHacker',
    groups: [WATCHLIST_GROUP],
    description:
      'Smaller but modern and app-shaped, useful for seeing whether the same heuristics hold in more compact repos.',
    patterns: ['extract_shared', 'stateful_singleton_split'],
  },
];
