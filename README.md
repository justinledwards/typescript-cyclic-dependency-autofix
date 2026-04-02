# Circular Dependency Autofix Bot

This project is evolving from a conservative autofix bot into a data-first cycle analysis platform for JavaScript and TypeScript repositories.

The core goal is no longer just "find a few safe fixes." The goal is to collect high-quality evidence about real circular dependency problems, identify recurring fix patterns, and automate the patterns that repeatedly validate and survive review.

## Primary Goals

- Turn every scan into reusable training and evaluation data, including unsupported cases.
- Build a graph-aware planner that reasons about symbol dependencies instead of relying only on file-level heuristics.
- Rank candidates using historical evidence from benchmarks, validation failures, and human review outcomes.
- Keep correctness rule-driven and validation-driven, while using data and ML only to rank safe candidates.
- Grow from narrow, trusted fixes into broader automation only when repeated real-repo evidence supports it.

## Target Workflow

The target product workflow is:

`detect -> extract features -> rank against historical evidence -> generate candidates -> validate -> review -> learn`

Each stage has a distinct job:

1. `detect`
   - find normalized circular dependency issues in real repositories
2. `extract features`
   - compute cycle shape, repo profile, import/export structure, side-effect risk, and graph metadata
3. `rank against historical evidence`
   - compare candidate strategies against benchmark cases, validation history, and review outcomes
4. `generate candidates`
   - produce multiple possible rewrites instead of collapsing too early to one heuristic answer
5. `validate`
   - confirm the target cycle is gone, no new cycles were introduced, and repo-native validation or `tsc` passes
6. `review`
   - expose the evidence, patch, validation results, and ranking rationale to a human reviewer
7. `learn`
   - feed review outcomes, validation failures, and benchmark labels back into future ranking

## Data-First Direction

The project now treats data capture as a first-class product surface.

Every cycle should eventually produce reusable observations such as:

- canonical cycle identity
- participating files and normalized shape
- repo profile and validation environment
- extracted feature vectors
- strategy attempts, scores, and ranking
- generated patches and replay bundles
- validation outcomes and failure categories
- review decisions and acceptance labels

The long-term value of the system comes from this loop. Even unsupported cycles should become analyzable examples rather than dead ends.

## Strategy Roadmap

### Current strategy families

- `autofix_import_type`
- `autofix_direct_import`
- `autofix_extract_shared`
- `autofix_host_state_update`

### Next strategy families

- `state_setter_inline`
- `type_value_split`
- `slice_extract_shared_v2`
- `barrel_export_graph_rewrite_v2`
- `internal_entrypoint_pattern` as manual-only until benchmark evidence supports promotion

## Graph, Search, and ML Roadmap

The medium-term technical direction is explicit:

- build a reusable symbol-level dependency graph layer
- compute symbol-level SCCs, import/export edges, re-export resolution, and side-effect risk
- search over candidate graph edits instead of only applying fixed heuristics
- use weighted edge scoring, def-use slicing, and clustering to find the cheapest safe cycle-breaking rewrites
- export model-ready datasets and analyze them with DuckDB + Parquet before adding learned ranking

ML is not the correctness mechanism. Validation and structural safety checks remain the correctness boundary.

## Repository Layout

```text
├── src/                 # TanStack Start frontend and review UI
├── backend/             # Fastify API server
├── analyzer/            # Cycle detection, feature extraction, planner logic
├── codemod/             # Patch generation and rewrite logic
├── cli/                 # Scan, retry, export, and reporting commands
├── db/                  # SQLite schema and data access layer
├── worktrees/           # Local repo clones and isolated workspaces
├── PLAN.md              # Source-of-truth roadmap for the data-first platform
├── DEPS.md              # Dependency rationale and planned technical additions
└── AGENTS.md            # Implementation guidance for contributors and coding agents
```

## Quick Start

```bash
brew install mise
mise install
pnpm install
pnpm run dev
```

- Frontend: `http://localhost:3000`
- Backend API: `http://localhost:3001/api`

## Current CLI Surface

```bash
pnpm run benchmark:import <dataset-path> -- --dataset swe-bench-multilingual --format parquet
pnpm run scan <repo-url-or-path>
pnpm run scan:all
pnpm run retry:failed
pnpm run export:patches
pnpm run export:training-data -- --format parquet
pnpm run ml:prepare
pnpm run ml:cluster
pnpm run ml:train-ranker
pnpm run ml:evaluate
pnpm run ml:compare
pnpm run report:clusters
pnpm run report:ml-disagreements
pnpm run report:ranker-metrics
```

The runtime application still uses SQLite for scans, patches, and review state. Offline analytics should prefer DuckDB over exported Parquet datasets so ranking experiments and pattern mining stay fast without complicating the live app database.

Training export is intentionally JS/TS-only. Benchmark cases mined from git history are only kept when the matching commit touched JavaScript or TypeScript files, and the exporter excludes benchmark rows that are not explicitly marked as JS/TS training-eligible.

External dataset import follows the same rule. Imported benchmark rows are only stored when they touch JS/TS files, and by default they must also look cycle-related based on the benchmark search terms so the benchmark table stays useful for circular-dependency ranking instead of filling with unrelated bugfixes.

## Advisory ML Workflow

The ML layer is now real, but intentionally offline and advisory-only.

Use it in this order:

1. `pnpm run export:training-data -- --format parquet`
   - export the current SQLite-backed observation, candidate, and benchmark state
2. `pnpm run ml:prepare`
   - flatten the exported data into model-ready `cycle_patterns` and `candidate_ranking` datasets under `exports/ml/`
3. `pnpm run ml:cluster`
   - discover recurring cycle groups from cycle-level features
4. `pnpm run ml:train-ranker`
   - train baseline logistic-ranker artifacts under `artifacts/ml/`
5. `pnpm run ml:evaluate`
   - measure repo-holdout accuracy and top-1 acceptability against the heuristic baseline
6. `pnpm run ml:compare`
   - persist advisory candidate scores and report heuristic-vs-model disagreements

The ML pipeline never generates patches by itself and never overrides runtime safety checks. It is only used to:

- surface recurring cycle/fix clusters
- score already-safe candidates
- show where heuristic ranking likely needs new strategies or better evidence

## Engineering Principles

- Prefer explainable ranking over opaque automation.
- Keep detection, feature extraction, ranking, rewriting, validation, and review separated.
- Persist enough information to replay, rescore, and compare decisions later.
- Default to no patch when evidence is weak.
- Optimize for globally useful patterns, not repo-specific hacks.

## License

MIT
