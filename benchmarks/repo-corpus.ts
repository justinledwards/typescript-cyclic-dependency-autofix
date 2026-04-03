export type BenchmarkCorpusGroup = 'calibration' | 'stable-core' | 'watchlist';
export type BenchmarkCorpusUsage = 'scan-head' | 'mine-history' | 'both';

const CALIBRATION_GROUP: BenchmarkCorpusGroup = 'calibration';
const STABLE_CORE_GROUP: BenchmarkCorpusGroup = 'stable-core';
const WATCHLIST_GROUP: BenchmarkCorpusGroup = 'watchlist';

export interface BenchmarkCorpusEntry {
  slug: string;
  groups: BenchmarkCorpusGroup[];
  description: string;
  patterns: string[];
  usage?: BenchmarkCorpusUsage;
  historyKeywords?: string[];
}

export const BENCHMARK_REPO_CORPUS: BenchmarkCorpusEntry[] = [
  {
    slug: 'openclaw/openclaw',
    groups: [CALIBRATION_GROUP],
    description: 'Already gave us a real accepted-quality cycle fix candidate and an upstream PR path.',
    patterns: ['extract_shared', 'stateful_singleton_split', 'ui_feature_slice', 'ownership_localization'],
    usage: 'both',
    historyKeywords: ['break cycle', 'import cycle', 'reexport cycle', 'circular'],
  },
  {
    slug: 'microsoft/vscode',
    groups: [STABLE_CORE_GROUP],
    description:
      'Huge TypeScript app with workbench services, deep package boundaries, and likely barrel-heavy feature slices.',
    patterns: ['direct_import', 'barrel_reexport', 'stateful_singleton_split', 'public_api_reexport'],
    usage: 'scan-head',
  },
  {
    slug: 'microsoft/TypeScript',
    groups: [STABLE_CORE_GROUP],
    description: 'High-value compiler codebase with API layering and module init order risk.',
    patterns: ['module_init_order', 'import_type', 'public_api_reexport'],
    usage: 'both',
    historyKeywords: ['circular', 'cycle', 'import type'],
  },
  {
    slug: 'angular/angular',
    groups: [STABLE_CORE_GROUP],
    description: 'Public API barrels and package-level re-exports are likely common.',
    patterns: ['direct_import', 'barrel_reexport', 'internal_entrypoint_pattern', 'public_api_reexport'],
    usage: 'both',
    historyKeywords: ['circular', 'cycle', 're-export', 'barrel'],
  },
  {
    slug: 'elastic/kibana',
    groups: [STABLE_CORE_GROUP],
    description:
      'Massive UI plus plugin architecture with likely rich cross-feature cycles and stateful service splits.',
    patterns: ['stateful_singleton_split', 'direct_import', 'extract_shared'],
    usage: 'scan-head',
  },
  {
    slug: 'grafana/grafana',
    groups: [STABLE_CORE_GROUP],
    description: 'Large app with frontend feature modules and shared helpers.',
    patterns: ['extract_shared', 'direct_import', 'barrel_reexport'],
    usage: 'both',
    historyKeywords: ['circular', 'cycle', 'dependency'],
  },
  {
    slug: 'backstage/backstage',
    groups: [STABLE_CORE_GROUP],
    description:
      'Package-level APIs, plugin surfaces, and index re-exports make it useful for public API and barrel-cycle analysis.',
    patterns: ['direct_import', 'public_api_reexport', 'internal_entrypoint_pattern'],
    usage: 'both',
    historyKeywords: ['circular', 'cycle', 'barrel', 'api'],
  },
  {
    slug: 'storybookjs/storybook',
    groups: [STABLE_CORE_GROUP, WATCHLIST_GROUP],
    description: 'Popular, active TypeScript repo with package boundaries, builders, and UI runtime layers.',
    patterns: ['direct_import', 'import_type', 'public_api_reexport', 'barrel_reexport'],
    usage: 'both',
    historyKeywords: ['circular', 'cycle', 'reexport', 'barrel'],
  },
  {
    slug: 'yarnpkg/berry',
    groups: [STABLE_CORE_GROUP, WATCHLIST_GROUP],
    description: 'Dense package graph and strong module boundaries.',
    patterns: ['module_init_order', 'direct_import', 'public_api_reexport'],
    usage: 'scan-head',
  },
  {
    slug: 'appsmithorg/appsmith',
    groups: [STABLE_CORE_GROUP],
    description: 'Real product app with frontend state, pages, and shared logic.',
    patterns: ['extract_shared', 'stateful_singleton_split', 'direct_import'],
    usage: 'scan-head',
  },
  {
    slug: 'BabylonJS/Babylon.js',
    groups: [STABLE_CORE_GROUP],
    description: 'Class-heavy TypeScript codebase with runtime-initialization and inheritance-style cycle cases.',
    patterns: ['module_init_order', 'internal_entrypoint_pattern', 'public_api_reexport'],
    usage: 'both',
    historyKeywords: ['circular', 'cycle', 'dependency'],
  },
  {
    slug: 'typescript-eslint/typescript-eslint',
    groups: [STABLE_CORE_GROUP],
    description: 'Strong type/value separation, useful for testing how often import type truly solves real cycles.',
    patterns: ['import_type', 'public_api_reexport', 'direct_import'],
    usage: 'both',
    historyKeywords: ['import type', 'circular', 'cycle'],
  },
  {
    slug: 'microsoft/fluentui',
    groups: [STABLE_CORE_GROUP],
    description:
      'Component package barrels and public surface re-exports make it useful for de-barrel and internal-entrypoint experiments.',
    patterns: ['direct_import', 'barrel_reexport', 'internal_entrypoint_pattern'],
    usage: 'both',
    historyKeywords: ['circular', 'cycle', 'barrel', 'reexport'],
  },
  {
    slug: 'mobxjs/mobx',
    groups: [STABLE_CORE_GROUP],
    description:
      'Directly relevant historical source for internal-entrypoint and circular-dependency fixes cited by Michel Weststrate.',
    patterns: ['internal_entrypoint_pattern', 'module_init_order', 'public_api_reexport'],
    usage: 'both',
    historyKeywords: ['circular', 'cycle', 'internal', 'reexport'],
  },
  {
    slug: 'mobxjs/mobx-state-tree',
    groups: [STABLE_CORE_GROUP],
    description:
      'Another Michel Weststrate repo with known circular-dependency refactors and strong model/type layering.',
    patterns: ['internal_entrypoint_pattern', 'module_init_order', 'public_api_reexport'],
    usage: 'both',
    historyKeywords: ['circular', 'cycle', 'internal', 'reexport'],
  },
  {
    slug: 'langgenius/dify',
    groups: [STABLE_CORE_GROUP, WATCHLIST_GROUP],
    description: 'Large modern agent/workflow app that already produced real cycles in our live scans.',
    patterns: ['extract_shared', 'direct_import', 'public_seam_bypass'],
    usage: 'both',
    historyKeywords: ['circular', 'cycle', 'dependency'],
  },
  {
    slug: 'janhq/jan',
    groups: [WATCHLIST_GROUP],
    description: 'Active desktop/agent-style TypeScript app that we have already used as a live scan target.',
    patterns: ['stateful_singleton_split', 'direct_import', 'extract_shared'],
    usage: 'scan-head',
  },
  {
    slug: 'anomalyco/opencode',
    groups: [WATCHLIST_GROUP],
    description: 'Large and fast-moving TypeScript app with modern agent-ui and workspace-service cycles.',
    patterns: ['stateful_singleton_split', 'direct_import', 'extract_shared'],
    usage: 'scan-head',
  },
  {
    slug: 'n8n-io/n8n',
    groups: [WATCHLIST_GROUP],
    description:
      'Large active workflow app with editor/runtime/plugin seams that should surface modern app-shaped cycles.',
    patterns: ['public_api_reexport', 'stateful_singleton_split', 'direct_import'],
    usage: 'scan-head',
  },
  {
    slug: 'supabase/supabase',
    groups: [WATCHLIST_GROUP],
    description: 'Active platform monorepo that is useful for package-boundary and public-surface cycle discovery.',
    patterns: ['public_api_reexport', 'direct_import', 'internal_entrypoint_pattern'],
    usage: 'scan-head',
  },
  {
    slug: 'ant-design/ant-design',
    groups: [WATCHLIST_GROUP],
    description: 'Component-library repo with barrel-heavy package surfaces and internal module boundaries.',
    patterns: ['barrel_reexport', 'direct_import', 'internal_entrypoint_pattern'],
    usage: 'both',
    historyKeywords: ['circular', 'cycle', 'barrel', 'dependency'],
  },
  {
    slug: 'excalidraw/excalidraw',
    groups: [WATCHLIST_GROUP],
    description:
      'Large interactive TS app that is useful for UI/state-oriented cycle patterns without monorepo overhead.',
    patterns: ['stateful_singleton_split', 'extract_shared', 'ownership_localization'],
    usage: 'scan-head',
  },
  {
    slug: 'immich-app/immich',
    groups: [WATCHLIST_GROUP],
    description:
      'Modern product repo with frontend and package boundaries that can expose real application dependency cycles.',
    patterns: ['extract_shared', 'direct_import', 'public_api_reexport'],
    usage: 'scan-head',
  },
  {
    slug: 'Open-Dev-Society/OpenStock',
    groups: [WATCHLIST_GROUP],
    description: 'Modern TS app with active development; useful for pattern diversity outside infra/tooling repos.',
    patterns: ['extract_shared', 'stateful_singleton_split'],
    usage: 'scan-head',
  },
  {
    slug: 'vas3k/TaxHacker',
    groups: [WATCHLIST_GROUP],
    description:
      'Smaller but modern and app-shaped, useful for seeing whether the same heuristics hold in more compact repos.',
    patterns: ['extract_shared', 'stateful_singleton_split'],
    usage: 'scan-head',
  },
];
