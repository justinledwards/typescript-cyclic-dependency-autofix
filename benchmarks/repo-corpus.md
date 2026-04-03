# Benchmark Repo Corpus

Seed corpus for real-repo cycle analysis and autofix pattern mining.

Selection date: 2026-03-20

Source buckets:
- Large, active TypeScript monorepos from [repo-stats TypeScript monorepos](https://stacey-gammon.github.io/repo-stats/TypeScript.html)
- Current high-velocity repos from [GitHub Trending: TypeScript](https://github.com/trending/typescript)
- One calibration repo we have already exercised end to end

The goal is not to find "all" TypeScript repos. The goal is to build a corpus that is broad enough to expose repeatable patterns:
- `import_type`
- `direct_import`
- `extract_shared`
- `barrel_reexport`
- `module_init_order`
- `internal_entrypoint_pattern`
- `stateful_singleton_split`
- `public_api_reexport`

Operational usage:
- `scan-head`: shallow clone the current repo state and run the detector/planner against the latest code
- `mine-history`: clone with enough history to search commit messages and inspect before/after diffs for circular-dependency fixes
- `both`: worth doing both, because the current head is useful and the history is likely to contain explicit cycle-fix commits

Default commit-message starters for history mining:
- `circular`
- `cyclic`
- `cycle`
- `break cycle`
- `import cycle`
- `reexport cycle`
- `dependency cycle`

## Calibration Repo

| Repo | Usage | Why it belongs | Patterns to watch |
| --- | --- | --- |
| `openclaw/openclaw` | `both` | Already gave us a real accepted-quality cycle fix candidate and an upstream PR path. Use it as the control repo for regression checks and historical fix replay. | `extract_shared`, `stateful_singleton_split`, `ownership_localization`, `ui_feature_slice` |

## Stable Core Corpus

| Repo | Usage | Category | Why it belongs | Patterns to watch |
| --- | --- | --- | --- |
| `microsoft/vscode` | `scan-head` | IDE / application monorepo | Huge TypeScript app with workbench services, deep package boundaries, and likely barrel-heavy feature slices. Good stress test for real app cycles. | `direct_import`, `barrel_reexport`, `stateful_singleton_split`, `public_api_reexport` |
| `microsoft/TypeScript` | `both` | compiler / tooling | High-value compiler codebase with API layering and module init order risk. Important for inheritance and initialization-order cases. | `module_init_order`, `import_type`, `public_api_reexport` |
| `angular/angular` | `both` | framework monorepo | Public API barrels and package-level re-exports are likely common. Good target for folder-internal entrypoint patterns. | `direct_import`, `barrel_reexport`, `internal_entrypoint_pattern`, `public_api_reexport` |
| `elastic/kibana` | `scan-head` | platform / dashboard monorepo | Massive UI plus plugin architecture. Likely rich in cross-feature cycles and stateful service splits. | `stateful_singleton_split`, `direct_import`, `extract_shared` |
| `grafana/grafana` | `both` | dashboard / application | Large app with frontend feature modules and shared helpers. Strong candidate for repeated `extract_shared` and de-barrel patterns. | `extract_shared`, `direct_import`, `barrel_reexport` |
| `backstage/backstage` | `both` | plugin platform monorepo | Package-level APIs, plugin surfaces, and index re-exports make it useful for public API and barrel-cycle analysis. | `direct_import`, `public_api_reexport`, `internal_entrypoint_pattern` |
| `storybookjs/storybook` | `both` | tooling / UI monorepo | Popular, active TypeScript repo with package boundaries, builders, and UI runtime layers. Good for cross-package cycle classification. | `direct_import`, `import_type`, `public_api_reexport`, `barrel_reexport` |
| `yarnpkg/berry` | `scan-head` | tooling / package manager | Dense package graph and strong module boundaries. Useful for non-UI TypeScript cycle patterns. | `module_init_order`, `direct_import`, `public_api_reexport` |
| `appsmithorg/appsmith` | `scan-head` | low-code / application | Real product app with frontend state, pages, and shared logic. Useful for "extract leaf helper from feature slice" cases. | `extract_shared`, `stateful_singleton_split`, `direct_import` |
| `BabylonJS/Babylon.js` | `both` | rendering engine / library | Class-heavy TypeScript codebase. Good target for the runtime-initialization and inheritance-style cycle cases from the Michel Weststrate article. | `module_init_order`, `internal_entrypoint_pattern`, `public_api_reexport` |
| `typescript-eslint/typescript-eslint` | `both` | tooling / multi-package | Strong type/value separation, useful for testing how often `import_type` truly solves real cycles. | `import_type`, `public_api_reexport`, `direct_import` |
| `microsoft/fluentui` | `both` | component library | Component package barrels and public surface re-exports make it useful for de-barrel and internal-entrypoint experiments. | `direct_import`, `barrel_reexport`, `internal_entrypoint_pattern` |
| `mobxjs/mobx` | `both` | state-management library | Historical source for internal-entrypoint and circular-dependency refactors cited by Michel Weststrate. | `internal_entrypoint_pattern`, `module_init_order`, `public_api_reexport` |
| `mobxjs/mobx-state-tree` | `both` | state-management library | Another Michel Weststrate repo with known circular-dependency refactors and strong model/type layering. | `internal_entrypoint_pattern`, `module_init_order`, `public_api_reexport` |
| `langgenius/dify` | `both` | agent / workflow application | We already saw real cycles here, so it is useful both for live scanning and mining historical fix language. | `extract_shared`, `direct_import`, `public_seam_bypass` |

## High-Velocity Watchlist

These are newer or currently fast-moving repos worth checking because they may expose modern TypeScript patterns that older corpora miss.

| Repo | Usage | Category | Why it belongs | Patterns to watch |
| --- | --- | --- | --- |
| `anomalyco/opencode` | `scan-head` | AI / coding agent app | Very large and fast-moving TypeScript app. Likely to expose modern agent-ui and workspace-service cycles. | `stateful_singleton_split`, `direct_import`, `extract_shared` |
| `janhq/jan` | `scan-head` | desktop / AI application | A repo we have already exercised once; useful for rechecking whether new strategies start finding candidates. | `stateful_singleton_split`, `direct_import`, `extract_shared` |
| `n8n-io/n8n` | `scan-head` | workflow platform | Large active workflow app with editor/runtime/plugin seams that should surface modern app-shaped cycles. | `public_api_reexport`, `stateful_singleton_split`, `direct_import` |
| `supabase/supabase` | `scan-head` | platform monorepo | Good current target for package-boundary and public-surface cycle discovery. | `public_api_reexport`, `direct_import`, `internal_entrypoint_pattern` |
| `ant-design/ant-design` | `both` | component library | Barrel-heavy package surfaces and internal module boundaries make it a good scan target and commit-history mining target. | `barrel_reexport`, `direct_import`, `internal_entrypoint_pattern` |
| `excalidraw/excalidraw` | `scan-head` | interactive application | Useful for UI/state-oriented cycle patterns without monorepo overhead. | `stateful_singleton_split`, `extract_shared`, `ownership_localization` |
| `immich-app/immich` | `scan-head` | product application | Modern app repo with frontend and package boundaries that can expose real application dependency cycles. | `extract_shared`, `direct_import`, `public_api_reexport` |
| `Open-Dev-Society/OpenStock` | `scan-head` | application | Modern TS app with active development; useful for pattern diversity outside infra/tooling repos. | `extract_shared`, `stateful_singleton_split` |
| `vas3k/TaxHacker` | `scan-head` | application | Smaller than the core corpus but modern and app-shaped, useful for seeing whether the same heuristics hold in more compact repos. | `extract_shared`, `stateful_singleton_split` |

## History-Mining Priorities

These are the repos most worth cloning with full history when the goal is to find human-written circular-dependency fixes from commit messages and diffs.

| Repo | Why it is high-value for history mining | Suggested search terms |
| --- | --- | --- |
| `openclaw/openclaw` | Already contains multiple confirmed cycle-fix commits that match our current and planned strategy families. | `break cycle`, `import cycle`, `reexport cycle`, `circular` |
| `mobxjs/mobx` | Specifically cited as a repo where the internal-entrypoint pattern solved circular-dependency problems. | `circular`, `cycle`, `internal`, `reexport` |
| `mobxjs/mobx-state-tree` | Same author and same family of fixes, with a strong chance of reusable internal-surface patterns. | `circular`, `cycle`, `internal`, `reexport` |
| `microsoft/fluentui` | Good source for barrel and public-surface fixes in a component-library setting. | `circular`, `cycle`, `barrel`, `reexport` |
| `angular/angular` | Good source for re-export and package-surface changes in a framework monorepo. | `circular`, `cycle`, `re-export`, `barrel` |
| `backstage/backstage` | Good source for plugin/public-API seam fixes. | `circular`, `cycle`, `plugin`, `api` |
| `typescript-eslint/typescript-eslint` | Strong target for `import type` and type/value separation fixes. | `import type`, `circular`, `cycle` |
| `langgenius/dify` | Worth mining because it already surfaced real cycles for us, and the history may reveal cleaner app-level fixes than our current planner finds. | `circular`, `cycle`, `dependency` |

## Pattern Hypotheses To Validate

1. `import_type` likely overperforms in tooling and AST-heavy repos such as `typescript-eslint` and `TypeScript`.
2. `direct_import` likely overperforms in framework and component-library repos with heavy barrel usage such as `angular`, `fluentui`, and `storybook`.
3. `extract_shared` likely works best in application repos with feature-slice helper functions such as `grafana`, `appsmith`, `openclaw`, `dify`, and `OpenStock`.
4. `ownership_localization` should show up repeatedly in app-shaped repos where a caller already owns the state being mutated, especially `openclaw`, `excalidraw`, and `immich`.
5. `public_seam_bypass` and `export_graph_rewrite` should show up in plugin/API-heavy repos such as `backstage`, `fluentui`, `dify`, and `n8n`.
6. The Michel Weststrate-style `internal.js` / `index.js` pattern should become a new strategy family for class-heavy or initialization-order failures, especially in `mobx`, `mobx-state-tree`, `Babylon.js`, and `TypeScript`.
7. Large app monorepos probably need a conservative rewrite family beyond today's v1 set: splitting stateful singletons or session/config helpers away from UI modules without changing the public API.

## Next Slice

To make this corpus actionable, the next implementation work should:
- add a machine-readable seed file or script input derived from this list
- add `usage` and `historyKeywords` to the machine-readable corpus entries so clone depth and mining behavior can be chosen automatically
- persist per-repo counts by classification and selected strategy
- tag rejected attempts with a normalized reason taxonomy
- compare acceptance-quality patches by repo category rather than only globally
- add a small history-mining helper that runs the default search terms against `usage: both` and `usage: mine-history` targets
