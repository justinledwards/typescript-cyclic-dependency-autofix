# AGENTS.md - Circular Dependency Autofix Bot

## Project Goal

This repository is building a data-first cycle analysis and autofix platform for JavaScript and TypeScript repositories.

The target workflow is:

`detect -> extract features -> rank against historical evidence -> generate candidates -> validate -> review -> learn`

The project should keep moving toward:

- reusable observations for every cycle, including unsupported cases
- graph-aware planning instead of only file-level heuristics
- ranking informed by benchmark, validation, and review history
- automation of patterns that repeatedly validate and survive human review

## Tech Stack

- **Runtime:** Node.js 25
- **Package Manager:** pnpm 10
- **Frontend:** TanStack Start, React 19, Tailwind CSS 4
- **Backend API:** Fastify 5
- **Database:** SQLite via better-sqlite3
- **Cycle Detection:** dependency-cruiser
- **Semantic Analysis:** ts-morph
- **Codemods:** jscodeshift + recast
- **Git Operations:** simple-git
- **Testing:** Vitest

## Project Structure

- `/src` — review UI and application routes
- `/backend` — Fastify API surface
- `/analyzer` — cycle detection, feature extraction, planner logic
- `/codemod` — candidate rewrite and patch generation
- `/cli` — scan, retry, export, and future report/rescore commands
- `/db` — SQLite schema and data access layer
- `/worktrees` — isolated repository clones and temp workspaces

## Development Commands

- `pnpm run dev`
- `pnpm run dev:frontend`
- `pnpm run dev:backend`
- `pnpm run test`
- `pnpm run scan <repo-url-or-path>`
- `pnpm run scan:all`
- `pnpm run retry:failed`
- `pnpm run export:patches`

## Engineering Rules

### 1. Data capture is a product feature

Every new feature should improve the evidence loop, not bypass it.

Prefer designs that persist:

- cycle identity
- feature vectors
- strategy attempts
- ranking signals
- validation outcomes
- review outcomes
- benchmark labels

Unsupported cases are still useful data.

### 2. Correctness and ranking are separate

- Safety and correctness come from structural analysis and validation.
- Ranking decides which already-safe candidates are most promising.
- ML, if added later, is only a ranking aid and must not replace correctness checks.

### 3. Prefer reusable graph/search layers over one-off heuristics

When adding new strategies:

- prefer shared graph features over strategy-local AST hacks
- prefer reusable export/import reasoning over bespoke barrel handling
- prefer explicit candidate generation and ranking over direct single-choice classification

### 4. Keep the system conservative

- Default to no patch when evidence is weak.
- Preserve public APIs when possible.
- Avoid introducing new files unless the evidence supports it.
- Minimize diff noise and touched files.

## Coding Conventions

- **Type Safety:** strict TypeScript throughout
- **Explainability:** every classification or rank should be explainable
- **Replayability:** store enough information to rescore and replay decisions later
- **Formatting Preservation:** prefer low-noise diffs via recast/jscodeshift
- **Validation Boundary:** a candidate is only trustworthy if cycle and validation checks pass

## Implementation Priorities

1. observation and evidence capture
2. graph-analysis core
3. search-based candidate generation
4. benchmark-driven ranking
5. broader automation only after the above are solid

If a change adds a new fix path without improving the evidence pipeline, it is probably the wrong next change.
