# AGENTS.md - Circular Dependency Autofix Bot

## Tech Stack
- **Runtime:** Node.js 25 (pinned via mise.toml)
- **Package Manager:** pnpm 10 (pinned via mise.toml)
- **UI Framework:** TanStack Start (Vite 7 + React 19 + file-based routing)
- **Language:** TypeScript (strict mode)
- **Backend API:** Fastify 5 (port 3001, serves `/api/*`)
- **Database:** SQLite via better-sqlite3
- **Dependency Analysis:** dependency-cruiser
- **AST & Semantic Analysis:** ts-morph (TypeScript Compiler API)
- **Codemod Engine:** jscodeshift + recast
- **Git Operations:** simple-git
- **Styling:** Tailwind CSS 4

## Project Structure
- `/src` — TanStack Start frontend (React, file-based routes in `/src/routes`)
- `/backend` — Fastify API server (port 3001, imports from `/db`)
- `/analyzer` — Core logic: dependency-cruiser cycle detection, ts-morph semantic analysis, classification
- `/codemod` — jscodeshift rewrite scripts for safe symbol extraction (not yet implemented)
- `/cli` — Commander-based CLI for scan, retry, and export commands
- `/db` — SQLite schema, DTOs, and prepared-statement data access layer
- `/worktrees` — Isolated, temporary local repository clones for safe patch generation (gitignored)

## Development
- `npm run dev` — Starts both Fastify backend (port 3001) and TanStack Start frontend (port 3000) via concurrently
- `npm run dev:frontend` — Frontend only
- `npm run dev:backend` — Backend only
- `npm run test` — Run vitest

## Coding Conventions
- **Conservative Autofix:** Auto-fix only narrow, safe cases (top-level named functions, consts, type aliases, interfaces). No classes, default exports, or modules with side-effects in v1.
- **Layered Architecture:** Keep detection, classification, rewrite, and validation strictly separated.
- **Deterministic Classification:** Every cycle must be classified clearly (`autofix_extract_shared`, `autofix_direct_import`, `autofix_import_type`, `suggest_manual`, or `unsupported`) with explainable reasons.
- **Formatting Preservation:** jscodeshift uses recast to minimize diff noise and preserve the target repository's formatting.
- **Strict Validation:** A patch is only valid if re-running dependency-cruiser shows no new cycles and `tsc --noEmit` succeeds.
- **Type Safety:** All TypeScript strict mode. Use DTOs from `/db/index.ts` for data shapes.

## Commands
- `pnpm run dev` — Start both Fastify backend and TanStack Start frontend
- `pnpm run scan <repo-url-or-path>` — Run the dependency analyzer and classifier on a target repository
- `pnpm run scan:all` — Scan all tracked repositories in the SQLite database
- `pnpm run retry:failed` — Retry failed patch candidates
- `pnpm run export:patches` — Export approved patch files for PR generation
