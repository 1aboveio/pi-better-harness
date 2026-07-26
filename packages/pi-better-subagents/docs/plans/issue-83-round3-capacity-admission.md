# Issue #83 Round 3 — class-complete fix plan

Theme mandated: `batch-capacity-admission` (recurring across 3 review rounds).

## Invariant class to close

Default `onCapacity:"reject"` is all-or-nothing and must not exceed `maxConcurrent`
under interleaving with other spawn calls in the same parent process. Capacity
accounting is shared by single-spawn and batch-spawn (reserve/commit/release).
`launch-available` still launches as many as fit and backfills pre-spawn failures.
Failure paths keep reporting launched/failed/skipped without stopping already-launched jobs.

## Adjacent members checked

1. reject + concurrent single-spawn interleaving (no oversubscribe)
2. reject whole-batch reserve failure (no partial launch)
3. single-spawn reserve failure at cap
4. launch-available per-slot reserve + skip remainder
5. launch-available backfill after pre-spawn failure (release then re-reserve)
6. reject per-job launch failure releases unused reservations; later jobs reported failed; launched stay running
7. test-workspace-isolation: e2e stubs never touch checkout `node_modules`

## Slices

- [x] capacity gate module + unit tests (reservation invariant) — `capacity.mjs`, `tests/capacity_gate.test.mjs`
- [x] wire gate into single + batch spawn paths — `index.ts`, `batch.mjs` pendingCount
- [x] real interleaving regression test (e2e Promise race) — `tests/batch_spawn_end_to_end.test.mjs`
- [x] e2e stubs via module loader / temp root only — no checkout `node_modules` mutation
- [x] checklist + gates + PR contract
