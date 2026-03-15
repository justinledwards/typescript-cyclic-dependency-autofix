# Circular Dependency Autofix Bot

Scans JavaScript and TypeScript repositories for circular dependencies, classifies which cycles are safe to fix automatically, generates patch files, and provides a review UI for human triage before creating pull requests.

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
├── src/                 # TanStack Start frontend (React + file-based routing)
│   ├── routes/          # Page routes (repositories, cycle detail, about)
│   ├── components/      # Shared UI components
│   └── lib/             # API client and utilities
├── backend/             # Fastify API server
│   └── server.ts        # REST endpoints for repos, scans, cycles, reviews
├── analyzer/            # Dependency analysis engine
│   └── analyzer.ts      # dependency-cruiser integration
├── cli/                 # Commander CLI
│   └── index.ts         # scan, scan:all, retry:failed, export:patches
├── db/                  # SQLite schema + data access layer
│   └── index.ts         # Tables, DTOs, prepared statements
├── codemod/             # jscodeshift rewrite scripts (planned)
└── worktrees/           # Temp repo clones for patch generation (gitignored)
```

## CLI Commands

```bash
pnpm run scan <repo-url-or-path>   # Analyze a single repository
pnpm run scan:all                  # Scan all tracked repositories
pnpm run retry:failed              # Retry failed patch candidates
pnpm run export:patches            # Export approved patches for PR generation
```

## How It Works

1. **Clone/update** repository heads
2. **Detect** circular dependencies using `dependency-cruiser`
3. **Classify** each cycle: `autofix_extract_shared`, `autofix_direct_import`, `autofix_import_type`, `suggest_manual`, or `unsupported`
4. **Generate patches** for high-confidence cases using `jscodeshift` + `recast`
5. **Validate** with `tsc --noEmit` and re-run cycle detection
6. **Review** in the web UI — approve, reject, or request manual intervention

## Safe Auto-Fix Scope (v1)

Only cycles matching **all** of these are auto-fixed:

- Two-file cycle only
- Files are `.js`, `.jsx`, `.ts`, or `.tsx`
- Candidate symbol is a top-level named function, const, type alias, or interface
- No default export involved
- No class extraction
- No module-local mutable state captured
- No top-level side-effect dependency
- No namespace import or re-export trickery
- New shared file doesn't create another cycle
- Validation passes after rewrite

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 25 (via mise) |
| Package Manager | pnpm 10 (via mise) |
| Frontend | TanStack Start + React 19 + Tailwind CSS 4 |
| Backend | Fastify 5 |
| Database | SQLite (better-sqlite3) |
| Analysis | dependency-cruiser + ts-morph |
| Codemods | jscodeshift + recast |
| Testing | Vitest |

## License

MIT
