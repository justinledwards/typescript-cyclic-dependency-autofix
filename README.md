# Circular Dependency Autofix Bot

Scans JavaScript and TypeScript repositories for circular dependencies, extracts planner features, ranks safe rewrite strategies, generates candidate patches, validates them, and provides a review/PR workflow for the cases worth sending upstream.

## Quick Start

```bash
# Install mise (if not already installed)
brew install mise   # macOS
# or see https://mise.jdx.dev/getting-started.html

# Install pinned tools
mise install

# Install dependencies
pnpm install

# Start dev servers (frontend + backend)
pnpm run dev
```

- **Frontend:** http://localhost:3000 (TanStack Start)
- **Backend API:** http://localhost:3001/api (Fastify)

## Architecture

```
├── src/                         # TanStack Start frontend and review UI
│   ├── routes/                  # Repository, cycle, findings, and about routes
│   ├── components/              # Shared UI shell
│   ├── lib/                     # API client helpers
│   └── routeTree.gen.ts         # Generated route tree
├── backend/                     # Fastify API server
│   └── server.ts                # REST endpoints for scans, cycles, patches, and reviews
├── analyzer/                    # Detection, normalization, feature extraction, and strategy ranking
│   ├── analyzer.ts              # dependency-cruiser entrypoint and repo/evidence wiring
│   ├── cycleNormalization.ts    # Canonical cycle identity helpers
│   └── semantic/                # Feature extraction, evidence scoring, planner output
├── cli/                         # CLI orchestration, validation, benchmarking, and PR automation
│   ├── scanner/                 # Target resolution, persistence, and replay bundle generation
│   ├── createPullRequest/       # Scratch checkout, snapshot replay, and PR rendering
│   ├── acceptanceBenchmark.ts   # Acceptance benchmark snapshotting and annotations
│   ├── benchmarkCorpus.ts       # Corpus batch mining
│   ├── benchmarkMiner.ts        # Local git-history miner
│   ├── repoProfile.ts           # Repo-native validation command inference
│   ├── smoke.ts                 # Fixture-driven real-repo smoke suite
│   ├── validation.ts            # Graph + repo-native validation
│   └── index.ts                 # CLI entrypoint
├── codemod/                     # Patch generation and file snapshot export
│   └── generatePatch.ts
├── db/                          # SQLite schema, DTOs, prepared statements, and metrics inputs
│   └── index.ts
├── benchmarks/                  # Real-repo corpus definitions and notes
├── smoke.fixtures.json          # Default smoke suite fixture list
└── worktrees/                   # Temp clones / scratch checkouts (gitignored)
```

## CLI Commands

```bash
pnpm run scan <repo-url-or-path>                 # Scan a repository and persist cycles/candidates
pnpm run explain <repo-url-or-path>              # Print planner output for each detected cycle
pnpm run profile:repo <repo-path>                # Infer repo-native validation commands
pnpm run smoke [fixturesPath]                    # Run the real-repo smoke suite
pnpm run benchmark:acceptance                    # Snapshot acceptance benchmark cases from corpus scans
pnpm run mine:corpus                             # Mine historical benchmark cases from the repo corpus
pnpm run mine:repo-history <repo-path>           # Mine benchmark cases from one local checkout
pnpm run create:pr <patchId> --issue <number>   # Replay a stored patch and open a PR
pnpm run export:patches [outputDir]              # Export approved or PR-candidate patch files
```

`scan:all` and `retry:failed` are still placeholders; the main operational paths are the commands above.

## How It Works

1. **Resolve a target** from a local path or remote repository URL and capture repository metadata.
2. **Detect cycles** with `dependency-cruiser`, then normalize rotated equivalents into a canonical cycle identity.
3. **Extract planner features** for each cycle and evaluate supported strategies:
   - `autofix_import_type`
   - `autofix_direct_import`
   - `autofix_extract_shared`
   - `autofix_host_state_update`
4. **Rank candidates** with planner heuristics plus historical evidence from benchmark cases, validation failures, and review outcomes.
5. **Generate patches** for promoted candidates, including replayable file snapshots for deterministic PR creation.
6. **Validate rewrites** by replaying the patch in a scratch checkout, re-running analysis, failing on persisted or newly introduced cycles, and running repo-native validation commands plus `tsc --noEmit` when available.
7. **Review or benchmark** results through the UI, acceptance benchmark workflow, or smoke suite.
8. **Create PRs** only for candidates that clear the upstreamability threshold.

## Safe Auto-Fix Scope (v1)

The tool is still intentionally conservative. It targets narrow cycle shapes where the rewrite can be explained and validated mechanically:

- Primarily two-file cycles, with a narrow barrel/direct-import exception
- Files are `.js`, `.jsx`, `.ts`, or `.tsx`
- Candidate declarations are simple top-level functions, consts, type aliases, or interfaces
- No default exports or class extraction
- No unsafe module-scope side effects
- No extraction that would recreate the cycle in the shared file
- No PR creation unless the candidate clears promotion and validation thresholds

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 25 (via mise) |
| Package Manager | pnpm 10 (via mise) |
| Frontend | TanStack Start + React 19 + Tailwind CSS 4 |
| Backend | Fastify 5 |
| Database | SQLite (better-sqlite3) |
| Analysis | dependency-cruiser + ts-morph |
| Codemods | ts-morph + recast-friendly patch export |
| Testing | Vitest |

## License

MIT
