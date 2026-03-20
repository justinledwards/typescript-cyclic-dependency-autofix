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

## Calibration Repo

| Repo | Why it belongs | Patterns to watch |
| --- | --- | --- |
| `openclaw/openclaw` | Already gave us a real accepted-quality cycle fix candidate and an upstream PR path. Use it as the control repo for regression checks. | `extract_shared`, `stateful_singleton_split`, `ui_feature_slice` |

## Stable Core Corpus

| Repo | Category | Why it belongs | Patterns to watch |
| --- | --- | --- | --- |
| `microsoft/vscode` | IDE / application monorepo | Huge TypeScript app with workbench services, deep package boundaries, and likely barrel-heavy feature slices. Good stress test for real app cycles. | `direct_import`, `barrel_reexport`, `stateful_singleton_split`, `public_api_reexport` |
| `microsoft/TypeScript` | compiler / tooling | High-value compiler codebase with API layering and module init order risk. Important for inheritance and initialization-order cases. | `module_init_order`, `import_type`, `public_api_reexport` |
| `angular/angular` | framework monorepo | Public API barrels and package-level re-exports are likely common. Good target for folder-internal entrypoint patterns. | `direct_import`, `barrel_reexport`, `internal_entrypoint_pattern`, `public_api_reexport` |
| `elastic/kibana` | platform / dashboard monorepo | Massive UI plus plugin architecture. Likely rich in cross-feature cycles and stateful service splits. | `stateful_singleton_split`, `direct_import`, `extract_shared` |
| `grafana/grafana` | dashboard / application | Large app with frontend feature modules and shared helpers. Strong candidate for repeated `extract_shared` and de-barrel patterns. | `extract_shared`, `direct_import`, `barrel_reexport` |
| `backstage/backstage` | plugin platform monorepo | Package-level APIs, plugin surfaces, and index re-exports make it useful for public API and barrel-cycle analysis. | `direct_import`, `public_api_reexport`, `internal_entrypoint_pattern` |
| `storybookjs/storybook` | tooling / UI monorepo | Popular, active TypeScript repo with package boundaries, builders, and UI runtime layers. Good for cross-package cycle classification. | `direct_import`, `import_type`, `public_api_reexport` |
| `yarnpkg/berry` | tooling / package manager | Dense package graph and strong module boundaries. Useful for non-UI TypeScript cycle patterns. | `module_init_order`, `direct_import`, `public_api_reexport` |
| `appsmithorg/appsmith` | low-code / application | Real product app with frontend state, pages, and shared logic. Useful for "extract leaf helper from feature slice" cases. | `extract_shared`, `stateful_singleton_split`, `direct_import` |
| `BabylonJS/Babylon.js` | rendering engine / library | Class-heavy TypeScript codebase. Good target for the runtime-initialization and inheritance-style cycle cases from the Michel Weststrate article. | `module_init_order`, `internal_entrypoint_pattern`, `public_api_reexport` |
| `typescript-eslint/typescript-eslint` | tooling / multi-package | Strong type/value separation, useful for testing how often `import_type` truly solves real cycles. | `import_type`, `public_api_reexport`, `direct_import` |
| `microsoft/fluentui` | component library | Component package barrels and public surface re-exports make it useful for de-barrel and internal-entrypoint experiments. | `direct_import`, `barrel_reexport`, `internal_entrypoint_pattern` |

## High-Velocity Watchlist

These are newer or currently fast-moving repos worth checking because they may expose modern TypeScript patterns that older corpora miss.

| Repo | Category | Why it belongs | Patterns to watch |
| --- | --- | --- | --- |
| `anomalyco/opencode` | AI / coding agent app | Very large and fast-moving TypeScript app. Likely to expose modern agent-ui and workspace-service cycles. | `stateful_singleton_split`, `direct_import`, `extract_shared` |
| `yarnpkg/berry` | package manager | Also trending now, which makes it useful both as stable corpus and active watchlist. | `module_init_order`, `direct_import` |
| `storybookjs/storybook` | UI tooling | Still active enough to remain a high-value watchlist repo for modern TS package boundaries. | `barrel_reexport`, `public_api_reexport` |
| `Open-Dev-Society/OpenStock` | application | Modern TS app with active development; useful for pattern diversity outside infra/tooling repos. | `extract_shared`, `stateful_singleton_split` |
| `vas3k/TaxHacker` | application | Smaller than the core corpus but modern and app-shaped, useful for seeing whether the same heuristics hold in more compact repos. | `extract_shared`, `stateful_singleton_split` |

## Pattern Hypotheses To Validate

1. `import_type` likely overperforms in tooling and AST-heavy repos such as `typescript-eslint` and `TypeScript`.
2. `direct_import` likely overperforms in framework and component-library repos with heavy barrel usage such as `angular`, `fluentui`, and `storybook`.
3. `extract_shared` likely works best in application repos with feature-slice helper functions such as `grafana`, `appsmith`, `openclaw`, and `OpenStock`.
4. The Michel Weststrate-style `internal.js` / `index.js` pattern should become a new strategy family for class-heavy or initialization-order failures, especially in `Babylon.js` and `TypeScript`.
5. Large app monorepos probably need a fourth conservative rewrite family beyond today's v1 set: splitting stateful singletons or session/config helpers away from UI modules without changing the public API.

## Next Slice

To make this corpus actionable, the next implementation work should:
- add a machine-readable seed file or script input derived from this list
- persist per-repo counts by classification and selected strategy
- tag rejected attempts with a normalized reason taxonomy
- compare acceptance-quality patches by repo category rather than only globally
