# Dependencies

## Why This Stack Exists

This repository is now aimed at a data-first, graph-aware autofix platform. The dependency stack is chosen to support four responsibilities:

- detect real dependency cycles in JS and TS repositories
- extract graph, semantic, and validation features that can be stored as training data
- generate and validate candidate rewrites with low diff noise
- expose enough operational and review surface to learn which strategies actually work

## Runtime Tooling

All core tools are pinned via `mise.toml`:

```toml
[tools]
node = "25"
pnpm = "10"
```

## System Dependencies

### macOS

```bash
brew install mise
mise install
```

### Linux (Debian/Ubuntu)

```bash
sudo apt update
sudo apt install -y git curl jq unzip sqlite3 build-essential python3 ca-certificates
mise install
```

## Current Node Dependencies

### Cycle detection and semantic analysis

| Package | Role in the roadmap |
|---|---|
| `dependency-cruiser` | File-level dependency graph and circular dependency detection |
| `ts-morph` | AST inspection, import/export analysis, semantic feature extraction |

### Rewrite and patch generation

| Package | Role in the roadmap |
|---|---|
| `jscodeshift` | Rewrite engine for candidate fixes |
| `recast` | Low-noise patch printing and formatting preservation |

### Repository and workflow control

| Package | Role in the roadmap |
|---|---|
| `simple-git` | Clone, fetch, branch, and patch export workflows |
| `commander` | CLI surface for scan, retry, export, and future reporting commands |

### Data and API surface

| Package | Role in the roadmap |
|---|---|
| `better-sqlite3` | Local evidence store for scans, candidates, validations, reviews, and benchmarks |
| `fastify` | API surface for findings, cycle detail, review, and future reporting endpoints |
| `@fastify/cors` | Local frontend-backend development support |

### Review UI

| Package | Role in the roadmap |
|---|---|
| `@tanstack/react-start` | App shell for the review and benchmark UI |
| `@tanstack/react-router` | File-based routing |
| `@tanstack/react-query` | Data fetching and cache coordination |
| `react` / `react-dom` | UI layer |
| `tailwindcss` | Styling |
| `lucide-react` | Icons |

### Quality and development tools

| Package | Role in the roadmap |
|---|---|
| `typescript` | Type checking and compiler-backed validation |
| `vite` | Frontend build and dev workflow |
| `vitest` | Unit and integration testing |
| `tsx` | TypeScript execution for CLI and backend |
| `concurrently` | Local dev orchestration |
| `eslint` | Static analysis |
| `@biomejs/biome` | Formatting and additional checks |

## Dependency Direction by Project Goal

### 1. Data collection

The system must store not only successful patches, but also:

- unsupported cycles
- rejected strategies
- validation failures
- review outcomes
- benchmark labels

Current stack support:

- `better-sqlite3`
- `fastify`
- `commander`

### 2. Graph and search infrastructure

The current stack is sufficient to build the first reusable graph/search layer without committing to a separate graph library yet.

Current stack support:

- `dependency-cruiser` for file graph input
- `ts-morph` for symbol and AST data

Planned capability, not yet a fixed dependency:

- explicit symbol graph construction
- SCC decomposition
- weighted edge scoring
- def-use slicing
- cluster and partition search

### 3. Ranking and learning

The current codebase should export model-ready datasets before adding a dedicated ML dependency.

This means:

- keep heuristic scoring as the baseline
- store versioned features and outcomes
- add offline dataset export first
- only add model tooling when benchmark data is stable enough to justify it

No ML framework is a required dependency yet by design.

## Planned Additions

These are planned capability areas, not locked package choices:

- offline dataset export for ranking experiments
- reporting commands and API endpoints for failure clusters and strategy performance
- optional model training and inference tooling after the evidence pipeline is stable
- richer repo-profile and validation inference

## Quality Expectations

New dependencies should help one of these goals:

- improve cycle understanding
- improve candidate generation
- improve evidence capture
- improve ranking quality
- improve replay, validation, or reviewability

If a new dependency does not clearly strengthen one of those, it probably does not belong here.
