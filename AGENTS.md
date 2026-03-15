# AGENTS.md - Circular Dependency Autofix Bot

## Tech Stack
- **UI Framework:** TanStack Start, React
- **Language:** TypeScript
- **Backend API:** Fastify
- **Database:** SQLite
- **Dependency Analysis:** dependency-cruiser
- **AST & Semantic Analysis:** ts-morph
- **Codemod Engine:** jscodeshift

## Project Structure
- `/frontend` - React application built with TanStack Start for reviewing cycles and patch candidates.
- `/backend` - Fastify API for storing repo metadata, findings, and patch files in SQLite.
- `/analyzer` - Core logic running `dependency-cruiser` and `ts-morph` for cycle detection, semantic analysis, and deterministic classification.
- `/codemod` - `jscodeshift` rewrite scripts to extract shared symbols safely.
- `/db` - SQLite database schema and data access layer.
- `/worktrees` - Isolated, temporary local repository clones for safe patch generation.

## Coding Conventions
- **Conservative Autofix:** Auto-fix only narrow, safe cases (e.g., top-level named functions, consts, type aliases, and interfaces). Do not extract classes, default exports, or modules with side-effects in v1.
- **Layered Architecture:** Keep detection, classification, rewrite, and validation strictly separated.
- **Deterministic Classification:** Every cycle must be classified clearly (`autofix_extract_shared`, `autofix_direct_import`, `autofix_import_type`, `suggest_manual`, or `unsupported`) with explainable reasons.
- **Formatting Preservation:** Ensure `jscodeshift` uses `recast` to minimize diff noise and preserve the target repository's formatting.
- **Strict Validation:** A patch is only valid if re-running `dependency-cruiser` shows no new cycles and `tsc --noEmit` succeeds.

## Commands
- `npm run dev` - Start both the Fastify backend and the TanStack Start frontend.
- `npm run scan <repo-url-or-path>` - Run the dependency analyzer and classifier on a target repository.
- `npm run scan:all` - Scan all tracked repositories in the SQLite database.
- `npm run retry:failed` - Retry failed patch candidates.
- `npm run export:patches` - Export approved patch files for PR generation.
