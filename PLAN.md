# Circular Dependency Autofix Bot
## Data-First Completion Plan

## Summary

The next phase of this project is focused on turning the system into a data-generating cycle lab that learns which rewrites are useful, safe, and reviewable across real repositories.

The goal is to move from:

`detect -> classify -> patch -> validate -> review`

to:

`detect -> extract features -> rank against historical evidence -> generate candidates -> validate -> review -> learn`

This plan is the documentation source of truth for that transition.

## Phase Goal

Completion for this phase means:

- every cycle produces reusable feature and evidence data, even when no fix is generated
- ranking and promotion are driven by historical data, not only static heuristic weights
- the planner uses an explicit graph/search layer for candidate generation
- the system identifies and auto-promotes a materially larger set of real-world patterns across the benchmark corpus
- benchmark and review data measurably improve future ranking and promotion decisions

## Slice 1: Make Data Capture the Primary Product Surface

### Required outcomes

- Add first-class `cycle_observations` and `candidate_observations` style storage, either as new tables or as structured extensions of the current cycle/candidate records.
- Capture, for every scan:
  - canonical cycle identity
  - repo profile
  - feature vector
  - strategy attempts
  - selected rank order
  - validation result and failure category
  - review outcome
  - benchmark and acceptance labels
- Persist graph-derived metadata even for `unsupported` and `suggest_manual` cases.
- Add rescoring and replay paths so historical candidates can be re-ranked when evidence changes.
- Add reporting surfaces for:
  - top failure clusters
  - most common cycle shapes
  - strategy success rate by repo profile
  - acceptance rate by strategy family
  - unsupported but recurrent pattern groups
- Make `retry:failed` a real workflow that consumes stored observations and produces new patch or validation history without erasing prior attempts.

### Why this slice matters

Without this, the system still behaves like a one-shot heuristic tool. With it, every run improves the training and evaluation dataset.

## Slice 2: Introduce a Reusable Graph-Analysis Core

### Required outcomes

- Build a reusable symbol-level dependency graph layer beneath the planner.
- The graph layer must compute:
  - symbol-to-symbol dependencies
  - symbol-level SCCs
  - file-level and symbol-level import and export edges
  - transitive re-export resolution
  - top-level initialization and side-effect risk labels
  - declaration movability and API-preservation signals
- Keep graph output serializable so it can be stored with observations and benchmark rows.
- Replace strategy-local barrel logic with a reusable export graph module.

### Why this slice matters

Broader automation requires reasoning about real dependency structure, not only file-level heuristics and ad hoc AST checks.

## Slice 3: Replace Single-Strategy Heuristics with Explicit Search

### Required outcomes

- Generate candidate rewrites by searching over graph edits instead of directly choosing one heuristic outcome.
- Implement search primitives for:
  - weighted feedback-edge removal
  - def-use and dependency-closure slicing
  - graph partition or leaf-cluster detection for larger SCCs
  - constrained candidate scoring for API preservation, files touched, side-effect risk, and naming fit
- Keep multiple viable candidates ranked through persistence, validation, and review instead of collapsing too early to a single winner.

### Strategy families to add on top of the graph core

- `state_setter_inline`
- `type_value_split`
- `slice_extract_shared_v2`
- `barrel_export_graph_rewrite_v2`
- `internal_entrypoint_pattern` as manual-only initially

### Why this slice matters

This is the step that turns the planner from a fixed classifier into a search-and-rank engine.

## Slice 4: Turn the Corpus into the Main Evaluation Loop

### Required outcomes

- Treat benchmark mining as the primary evaluation framework, not side data.
- Maintain a stable corpus of real TypeScript repositories spanning:
  - libraries
  - applications
  - monorepos and workspaces
  - barrel-heavy repos
  - state-heavy UI repos
- For each repo, cycle, and candidate, store:
  - graph features
  - planner features
  - validation outcomes
  - review labels
  - acceptance labels
  - diff-shape metrics
- Add offline evaluation commands that answer:
  - which patterns recur most often
  - which patterns are easiest to solve mechanically
  - which strategies regress on specific repo profiles
  - where automation should stay manual-only

### Definition of a discovered pattern

A pattern is considered discovered when there is:

- a recurring cycle shape
- a recurring successful transformation
- acceptable validation and review outcomes across multiple repositories

## Slice 5: Add Learned Ranking After the Data Pipeline Is Stable

### Required outcomes

- Keep the deterministic scorer as the baseline.
- Export model-ready datasets from stored observation tables.
- Train offline ranking models to predict:
  - patch acceptability
  - validation risk
  - diff noisiness
  - repo-convention mismatch risk
- Use learned ranking only to order already-safe candidates.
- Keep model inference optional, versioned, and directly comparable against heuristic ranking.

### Important boundary

ML is a ranking mechanism, not a correctness mechanism.

### Current advisory ML surface

The repo now has a first offline advisory ML loop:

- `export:training-data` writes model-ready base exports
- `ml:prepare` derives `cycle_patterns`, `candidate_ranking`, and `candidate_preferences` datasets
- `ml:cluster` groups recurring cycle shapes
- `ml:train-ranker` trains baseline logistic models for acceptability, validation, and pairwise preference
- `ml:evaluate` reports repo-holdout metrics
- `ml:compare` persists heuristic-vs-model disagreements for later strategy work
- `report:ml-labeling-queue` prioritizes the disagreements that should be labeled next

The current ranking loop now includes:

- pairwise preference learning from real approved/rejected alternatives
- mirrored structural augmentation for those pairwise rows
- hard-negative mining when a safer candidate consistently beats a failed alternative

This slice is intentionally advisory-only. Runtime promotion and patch generation still depend on structural checks and validation outcomes.

## Slice 6: Finish the Automation Boundary

### Required outcomes

- Patch generation should happen only for candidates that clear ranking, confidence, and evidence gates.
- PR creation should happen only for candidates with passed validation and positive acceptance signals for similar cases.
- Add active-learning surfaces for:
  - best unsupported clusters
  - high-score but repeatedly rejected clusters
  - manual fixes that should become formal strategies
- Make the review UI and API expose the evidence behind each rank so human decisions improve the training data.

## Interfaces and Data Changes

- Add persistent observation storage or extend current tables so every cycle attempt is queryable as training data.
- Version feature vectors, graph summaries, and ranking outputs for replay and rescoring.
- Extend planner output to include:
  - graph summary
  - feature vector snapshot
  - evidence summary
  - promotion eligibility
  - failure signature history
- Extend CLI and API with:
  - `rescore`
  - `report:patterns`
  - `report:strategy-performance`
  - `report:unsupported-clusters`
  - real `retry:failed`

## Test and Acceptance Plan

- Unit tests for:
  - graph extraction
  - SCC detection
  - re-export resolution
  - side-effect labeling
  - slicing
  - candidate search scoring
- Integration tests for:
  - scan -> observe -> rank -> validate -> review -> rescore loops
  - retry and replay workflows
  - evidence-informed reranking
- Corpus tests that verify new benchmark and review data changes ranking outcomes.
- Acceptance tests for each new strategy family on real-repo fixtures and benchmark-labeled cases.

## Phase Completion Criteria

- every scanned cycle yields a stored observation row
- ranking changes measurably when evidence changes
- `retry:failed` and rescoring work end to end
- at least three strategy families beyond the current baseline show repeated accepted results in the corpus
- benchmark reports identify recurrent solvable clusters instead of isolated one-off fixes

## Project Principles

- Data collection and pattern discovery are the top priority.
- New strategy work must plug into the evidence pipeline, not bypass it.
- Graph and search infrastructure should be built before many more bespoke heuristics.
- Prefer globally useful patterns over repo-specific cleverness.
- Default to no patch when the evidence is weak.
