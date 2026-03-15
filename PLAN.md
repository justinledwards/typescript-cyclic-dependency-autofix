# Circular Dependency Autofix Bot MVP Plan

## Summary

This application will scan JavaScript and TypeScript repositories for circular dependencies, classify which cycles are likely safe to fix automatically, generate patch files for those fixes, store the findings and patches in a database, and provide a simple review UI so a human can inspect candidates and choose which fixes should become pull requests.

The first release should focus on high-confidence, low-risk fixes in JS, JSX, TS, and TSX files. It should not try to solve every circular dependency. Its value comes from being conservative, repeatable, and useful across many repositories.

The operating model is:

1. Pull or update repository heads on a cheap server.
2. Run dependency analysis against each repo.
3. Detect circular dependencies and normalize them into distinct issues.
4. Classify each issue into fixable now, suggest-only, or ignore.
5. Generate patch files for high-confidence cases.
6. Store repo metadata, findings, patch files, validation results, and review state in a database.
7. Present a small UI for triage, review, and PR decisions.

---

## Libraries and tools to attempt first

### Core analysis and fix pipeline

- **dependency-cruiser**
  - Primary cycle detector and dependency graph source
  - Use structured output, not just terminal text
  - Best fit for graph-first detection

- **TypeScript Compiler API**
  - Primary semantic analysis layer
  - Use for symbol resolution, type-only import checks, declaration lookup, reference analysis, and free variable analysis
  - Best foundation for deciding whether a candidate extraction looks safe

- **ts-morph**
  - Convenience layer over the TypeScript Compiler API
  - Good for easier AST navigation and source file manipulation
  - Use it if development speed matters more than using raw compiler APIs everywhere

- **jscodeshift**
  - Primary codemod rewrite engine
  - Good for moving declarations, rewriting imports, and generating clean file patches across JS, JSX, TS, and TSX

- **recast**
  - Formatting-preserving printer used well with jscodeshift
  - Helps avoid ugly diffs and unnecessary churn

### Validation and developer workflow

- **TypeScript (`tsc`)**
  - Typecheck validation after rewrite

- **eslint**
  - Optional post-fix lint validation

- **prettier**
  - Optional post-fix formatting normalization

- **git**
  - Use for patch generation, worktree isolation, and clean diff creation

### Server-side app and storage

- **Node.js**
  - Main runtime

- **SQLite**
  - Easiest MVP database for findings, repos, patch metadata, validation results, and review state

- **better-sqlite3**
  - Good simple SQLite access layer for Node

- **Fastify** or **Express**
  - Lightweight API backend for the review UI
  - Prefer Fastify if you want structure and speed, Express if you want familiarity

### UI

- **React**
  - Review interface

- **Vite**
  - Simple frontend build setup

- **TanStack Query**
  - Useful for findings list, patch detail, and review actions

- **Monaco Editor** or **CodeMirror**
  - Side-by-side diff or patch inspection

### GitHub integration, later in MVP if needed

- **simple-git**
  - Good for local repo automation

- **octokit**
  - Use later when creating PRs through GitHub API becomes worth it

### Other candidates if the first choice becomes a problem

- **Madge**
  - Alternate dependency graph tool
  - Simpler in some cases, but less attractive than dependency-cruiser for this project

- **Babel parser / @babel/traverse**
  - Alternate AST stack for JS-first parsing
  - Useful fallback if jscodeshift or ts-morph has trouble on some repos

- **tsquery**
  - Helpful if query-style AST matching becomes useful

- **PostgreSQL**
  - Upgrade path if SQLite becomes too limiting for multi-repo history and UI filtering

- **Next.js**
  - Alternate choice if you want one full-stack app instead of separate API plus UI

---

## MVP goals

- [ ] Detect circular dependencies in JS, JSX, TS, and TSX files across cloned repositories.
- [ ] Normalize cycle reports so duplicate cycle orderings collapse into one issue.
- [ ] Classify cycles into high-confidence auto-fix, suggest-only, or unsupported.
- [ ] Auto-fix only a narrow class of safe cases.
- [ ] Generate patch files for candidate fixes.
- [ ] Re-run dependency analysis and validation after a rewrite.
- [ ] Store findings and artifacts in a database.
- [ ] Provide a simple review UI to inspect findings and patches before making PRs.
- [ ] Keep the system conservative enough that accepted patches build trust instead of creating noise.

---

## MVP safe auto-fix scope

The first release should only auto-fix cycles that match all or nearly all of the following:

- [ ] Two-file cycle only.
- [ ] Files are `.js`, `.jsx`, `.ts`, or `.tsx`.
- [ ] Candidate shared symbol is a top-level named function, const, type alias, or interface.
- [ ] No default export involved in the extracted symbol.
- [ ] No class extraction in v1.
- [ ] No module-local mutable state captured by the extracted symbol.
- [ ] No obvious top-level side-effect dependency required for the symbol to behave correctly.
- [ ] No namespace import or re-export trickery involved in the moved symbol.
- [ ] The new shared file does not create another cycle.
- [ ] Validation passes after rewrite.

---

## MVP implementation checklist

### 1. Repository runner and workspace management

- [ ] Create a worker that can clone a repo if it does not exist locally.
- [ ] Add update logic to fetch and hard-reset to the target remote branch head.
- [ ] Store repo metadata such as owner, name, default branch, last scanned commit, local path, and last scan time.
- [ ] Use isolated temp worktrees or temp copies for rewrite attempts so patch generation stays clean.
- [ ] Add per-repo status tracking such as queued, scanning, analyzed, patched, validation failed, ready for review, ignored.
- [ ] Add retry and failure tracking for clone, install, analyze, rewrite, and validation stages.

### 2. Dependency cycle detection

- [ ] Run dependency-cruiser against JS, JSX, TS, and TSX files only.
- [ ] Configure output as structured JSON instead of only terminal text.
- [ ] Parse only circular dependency findings for the MVP pipeline.
- [ ] Normalize cycle order so the same cycle is not stored multiple times due to rotation.
- [ ] Store normalized cycle path, participating files, and raw depcruise payload in the database.
- [ ] Add file filtering rules for obvious generated, vendored, dist, coverage, and test output paths.

### 3. AST and semantic analysis layer

- [ ] Build an analysis service around the TypeScript Compiler API or ts-morph.
- [ ] Parse both files participating in a two-file cycle.
- [ ] Identify import edges crossing between the two files.
- [ ] Resolve which imported symbols are actually responsible for the cross-file dependency.
- [ ] For each candidate symbol, collect declaration kind, export kind, location, references, and free variables.
- [ ] Detect whether the candidate symbol references module-local mutable state.
- [ ] Detect whether the candidate symbol depends on sibling helpers that would also need to move.
- [ ] Detect whether a candidate edge is type-only and may be solvable with `import type`.
- [ ] Detect barrel-file scenarios where direct imports may remove the cycle without extraction.
- [ ] Produce a fix classification for each cycle.

### 4. Fix classification engine

- [ ] Create a deterministic classification enum such as `autofix_extract_shared`, `autofix_direct_import`, `autofix_import_type`, `suggest_manual`, `unsupported`.
- [ ] Mark two-file cycles with safe top-level declarations as `autofix_extract_shared`.
- [ ] Mark cycles caused by barrel imports as `autofix_direct_import` where safe.
- [ ] Mark TS type-only opportunities as `autofix_import_type` where safe.
- [ ] Mark class-heavy, side-effect-heavy, or multi-file entangled cycles as `suggest_manual` or `unsupported`.
- [ ] Attach a confidence score and a reason list to every classification.

### 5. Shared-file extraction codemod

- [ ] Implement extraction of top-level named functions, consts, type aliases, and interfaces into a new leaf file.
- [ ] Prefer semantic file names like `shared.ts`, `render-primitives.tsx`, or `types.ts` when obvious.
- [ ] Fall back to machine-generated pair names only when no better semantic name can be inferred.
- [ ] Rewrite the original two files to import from the new shared file.
- [ ] Preserve exports so the rest of the repo behaves the same as before.
- [ ] Preserve relative import correctness from the new shared file.
- [ ] Use recast or equivalent printing to reduce formatting churn.
- [ ] Abort and mark failed if the extracted file would itself depend back on one of the original files.

### 6. Alternate fix codemods for v1

- [ ] Implement direct-import replacement when a barrel file causes the cycle and a direct leaf import removes it safely.
- [ ] Implement `import type` conversion when a TS cycle is runtime-free and clearly type-only.
- [ ] Keep these fixes behind the same validation requirements as extraction fixes.

### 7. Validation pipeline

- [ ] Re-run dependency-cruiser after each rewrite attempt.
- [ ] Verify that the original target cycle no longer exists.
- [ ] Verify that no new circular dependency was introduced by the rewrite.
- [ ] Run `tsc --noEmit` when a TypeScript project is detected.
- [ ] Optionally run repo lint if it is cheap and predictable.
- [ ] Optionally run targeted tests if the repo has a simple and reliable command for them.
- [ ] If validation fails, store the failure reason and keep the patch for manual inspection if useful.

### 8. Patch generation and artifact storage

- [ ] Generate a unified diff patch for every successful rewrite.
- [ ] Store patch text, touched files, classification, confidence, and validation summary in the database.
- [ ] Store before and after cycle results for easy UI comparison.
- [ ] Keep a copy of the generated shared file contents or transformed file contents for review.
- [ ] Track whether a finding has been reviewed, approved, rejected, ignored, or turned into a PR candidate.

### 9. Database schema

- [ ] Create a `repositories` table.
- [ ] Create a `scans` table linked to repositories and commit SHAs.
- [ ] Create a `cycles` table for normalized cycle issues.
- [ ] Create a `fix_candidates` table for classification output and confidence.
- [ ] Create a `patches` table for generated patch content and validation status.
- [ ] Create a `review_decisions` table for human triage state.
- [ ] Add indexes for repo, commit, status, confidence, and review state.

### 10. Review UI

- [ ] Build a repositories list view.
- [ ] Build a findings queue filtered by status and confidence.
- [ ] Show normalized cycle path and participating files.
- [ ] Show fix classification, confidence, and reasons.
- [ ] Show unified diff patch text.
- [ ] Show before and after dependency summary.
- [ ] Add review actions such as approve, reject, ignore, and revisit later.
- [ ] Add basic search and filters by repo, cycle size, classification, and validation status.

### 11. CLI and operations

- [ ] Build a CLI command to scan one repo.
- [ ] Build a CLI command to scan all tracked repos.
- [ ] Build a CLI command to retry failed candidates.
- [ ] Build a CLI command to export approved patches.
- [ ] Add logging for clone, dep analysis, classification, rewrite, and validation stages.
- [ ] Add concurrency limits so a cheap server does not thrash itself.

### 12. Metrics and trust-building

- [ ] Track total repos scanned.
- [ ] Track total cycles found.
- [ ] Track high-confidence candidates found.
- [ ] Track successful auto-fixes.
- [ ] Track validation pass rate.
- [ ] Track review approval rate.
- [ ] Track accepted PR rate later when GitHub integration is added.

---

## Recommended MVP release slices

### Slice 1: detector only

- [ ] Clone or update a repo.
- [ ] Run dependency-cruiser.
- [ ] Normalize circular dependency findings.
- [ ] Store results in SQLite.
- [ ] Show findings in a minimal UI.

### Slice 2: classifier only

- [ ] Add AST and semantic analysis.
- [ ] Classify cycles into safe, suggest-only, unsupported.
- [ ] Display classification reasons in the UI.
- [ ] Do not rewrite yet.

### Slice 3: first autofix

- [ ] Implement shared-file extraction for a very narrow safe case.
- [ ] Generate patch files.
- [ ] Re-run depcruise and typecheck.
- [ ] Store successful patches.

### Slice 4: review workflow

- [ ] Add review states and patch approval.
- [ ] Add export of approved patch files.
- [ ] Improve UI diff display and filtering.

### Slice 5: scale-out quality

- [ ] Add direct-import and `import type` fixes.
- [ ] Add concurrency controls and batch scans.
- [ ] Improve confidence scoring.
- [ ] Add basic repository allowlist and ignore rules.

---

## Things we probably cannot safely handle in the first release

### Hard architectural cycles

- [ ] Multi-file cycles with business logic spread across three or more files.
- [ ] Cycles involving workflow orchestration, service registries, or plugin loaders.
- [ ] Cycles where the real fix is dependency inversion rather than extraction.

### Import-time behavior and side effects

- [ ] Modules with top-level side effects that influence runtime behavior.
- [ ] Modules that register handlers, patch globals, or initialize caches on import.
- [ ] Cycles where import evaluation order may be semantically important.

### Complex symbol kinds

- [ ] Classes with instance state, private fields, decorators, or inheritance-sensitive behavior.
- [ ] Default-export-heavy modules with ambiguous safe extraction boundaries.
- [ ] Namespace imports and re-export graphs that obscure the true dependency edge.

### Framework-specific edge cases

- [ ] Framework magic files and convention-based imports that are not easy to reason about generically.
- [ ] Dynamic import routing systems and code splitting patterns that hide actual runtime edges.
- [ ] Build-time generated files or macro-driven source transforms.

### Validation complexity

- [ ] Repositories with no reliable automated validation command.
- [ ] Monorepos with unusual workspace bootstrapping requirements.
- [ ] Repositories whose tests are too expensive or too flaky to use as part of automated patch acceptance.

---

## Roadmap for future releases

### Future release: safer and broader analysis

- [ ] Add stronger free-variable and dependency-closure analysis.
- [ ] Add side-effect detection scoring at module level.
- [ ] Add better handling for sibling helper chains that need to move together.
- [ ] Add import-order risk scoring.

### Future release: broader fix types

- [ ] Support multi-symbol extraction in one pass.
- [ ] Support extraction of small clusters of dependent helper functions.
- [ ] Support splitting runtime from types automatically into `types.ts`.
- [ ] Support dependency inversion suggestions for service-layer cycles.
- [ ] Support barrel import cleanup as a first-class fix path.

### Future release: richer repository understanding

- [ ] Detect common repo tooling and infer validation commands automatically.
- [ ] Add monorepo package awareness and per-package scan targeting.
- [ ] Add framework profiles for React, Next.js, Vite, Express, Nest, and similar ecosystems.
- [ ] Add repo-specific ignore and allow rules.

### Future release: better review and PR flow

- [ ] Add GitHub authentication and PR creation with Octokit.
- [ ] Generate PR descriptions explaining the detected cycle, the fix type, and validation results.
- [ ] Add reviewer notes and acceptance history.
- [ ] Add support for re-running a previously approved patch on a newer commit.

### Future release: trust and quality metrics

- [ ] Add historical fix acceptance rate by classification type.
- [ ] Add false-positive and false-fix tracking.
- [ ] Add confidence calibration based on actual review outcomes.
- [ ] Add dashboards for repo health and autofix success rate.

### Future release: horizontal scale

- [ ] Add a queue and worker model for many repositories.
- [ ] Add object storage for patch artifacts and scan reports.
- [ ] Upgrade from SQLite to PostgreSQL if scan volume grows.
- [ ] Add deduplicated caching of repository analysis state by commit SHA.

---

## Suggested first-repo testing strategy

- [ ] Test first on a small set of repositories you know how to validate.
- [ ] Include a few TypeScript-heavy repos and a few mixed JS or TSX repos.
- [ ] Start by running in detector-only mode and comparing findings with manual inspection.
- [ ] Enable autofix only on repos where validation is predictable.
- [ ] Review and score every generated patch manually before thinking about PR automation.
- [ ] Use the earliest approval and rejection data to refine safe-case heuristics.

---

## Practical success criteria for the MVP

- [ ] It can scan many repositories without manual setup for each one.
- [ ] It can identify circular dependencies reliably enough to be useful.
- [ ] It only auto-fixes a narrow class of cases with a high validation pass rate.
- [ ] It produces patch files that are small, understandable, and easy to review.
- [ ] It gives a human reviewer enough evidence to trust or reject a patch quickly.
- [ ] It builds a feedback loop that improves the classifier over time.

---

## Notes on project philosophy

- [ ] Prefer a small number of highly reliable fixes over broad but noisy automation.
- [ ] Keep detection, classification, rewrite, and validation as separate layers.
- [ ] Make every classification explainable.
- [ ] Treat cycle removal as a trust problem as much as a technical one.
- [ ] Design for reviewability, not just automation.
