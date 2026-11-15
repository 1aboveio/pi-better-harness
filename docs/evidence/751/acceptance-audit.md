# Unified runtime acceptance audit

Audit baseline: `7e70fdf5` (origin/main), 2026-11-16.

Issue #751 remains incomplete. Merged implementation and open issue state are separate evidence: #755 and #759 have merged PRs, while their issues remain open.

## Verified locally

On macOS, this command passed all 17 tests with no skips (95.4 seconds):

```sh
node --import tsx --import ./scripts/isolate-registry.mjs --test packages/pi-better-server/test/runtime-lifecycle.test.ts packages/pi-better-server/test/runtime-socket-lifecycle.test.ts
```

The tests exercise real SQLite runner obligations, guardian signal shutdown, bounded idle-shutdown recovery, exact-owner guardian replacement, loss of all recovery processes, persisted restart budgets, concurrent path-alias launches, refusal to reclaim an unresponsive live owner, verified worker retention, connection retention versus probes, default 30-second idle plus five-second shutdown, 100 registration/shutdown races, server SIGKILL recovery, failed read-worker shutdown, and socket teardown.

PR #773 is merged. Its CI run 43727950643 passed all reported checks, including macOS lifecycle coverage and all three server shards. Local testing alone does not establish Linux behavior; retain the CI evidence when assessing platform coverage.

## Remaining implementation evidence

- PR #775 (Catalog) is open. Its reported aggregate CI failed because workspace shard 2 was cancelled; a completed green run and acceptance review are still needed.
- PR #776 (Background supervision) is open. Its description explicitly leaves scope-level discovery-loop shutdown, HostedSession host removal, partial-handoff/crash recovery, SDK closure, and standalone authority refusal unfinished or unverified.
- PR #777 (Subagent launch) is an integration baseline. Its description explicitly states that server-managed launch is not implemented.
- Worker continuation (#762), precise result delivery (#763), pinned-build upgrades (#764), and final migration/performance evidence (#765) remain open.
- The epic's additional #782 query-isolation performance acceptance must also be audited before closure.

Do not use these targeted lifecycle results to claim complete migration, launch authority, Catalog isolation, or the aggregate 1/5/10-client performance budget.

## Cancellation and owner follow-up

The following command passed 13 tests, with one Linux-only process-state test skipped on macOS (13.9 seconds):

```sh
node --import tsx --import ./scripts/isolate-registry.mjs --test packages/pi-better-server/test/daemon-owner.test.ts packages/pi-better-server/test/runtime-cancellation.test.ts
```

Evidence includes simultaneous owner contention, dead-owner reclamation, malformed identity refusal, exact receipt recovery through another authorized connection, SIGKILL at five cancellation boundaries, and the real Pi SDK loading the Background extension and invoking socket cancellation. The Linux-only skip is not local proof of Linux owner handling.

## Catalog integration checkpoint

Merged Catalog head `1dc4583f` with current main in local commit `30c7a8ae`. Resolved conflicts by retaining both advertised capabilities, both independent command dispatch paths and both domain-generation inputs. Server and Subagents typechecks pass. All seven real cancellation tests and the real Catalog daemon test pass together on this integration. The Catalog test must currently run from `packages/pi-better-server`; invoking it at repository root incorrectly resolves its fixture parent outside the worktree.

A further 97 Catalog schema, discovery, inheritance, lifecycle, saved-settings, skill-edit and UI tests pass with no skips. These do not replace the unfinished real-Pi and security acceptance matrix identified in PR #775.

Next security audit target: Catalog host registrations currently persist only PID and admission checks use `kill(pid, 0)`. Inspect exact process-start qualification before treating host identity acceptance as complete.

## Catalog process identity fix

Catalog host grants now capture the existing Subagent process-start token and admission verifies it on bind and every subsequent authorization. Missing or mismatched evidence is refused even if the PID exists. The shared server comparator pins the ps locale and normalizes spacing to match the established Subagent representation.

Server and Subagents typechecks pass. The new Catalog admission regression, real Catalog daemon test, owner tests and cancellation tests pass together: 15 passed, one Linux-only test skipped on macOS. This closes the inspected PID-reuse gap; it does not complete the remaining Catalog acceptance matrix.

## Full Server run and pinned-runtime retry

On integration head `64b9018d`, full Server verification finished with 813 passed, 37 failed and 21 skipped. Every failure had the same fixture prerequisite: the host Node was 24.21.0, while private-runtime fixtures require 24.14.1. Downloaded the official darwin-arm64 24.14.1 archive and verified its SHA-256 against the release checksum manifest. Reran all three affected test files with `PI_TEST_PRIVATE_RUNTIME_NODE` pointing to that binary: 45 passed, zero failures, one opt-in skip. This resolves every failure from that run; it is not a full-suite rerun of subsequent integration changes.

Two real Pi SDK Catalog acceptance tests also pass: multiple processes/projects/branches, persistent UI writes, session-only trust and revocation. The opt-in model-driven instruction-to-launch test was not run and is not claimed as evidence.

## Background supervision integration

At Background branch head `6aa1c4f0`, all 11 real-process supervision tests passed. Fixed repeated handoffs accepting conflicting destination/capability fields in `4ea2d4ac`; identical retries remain idempotent. All 118 coordinator tests and coordinator typecheck pass. All 11 real-process supervision tests pass again after the fix.

The Catalog and Background branches are now combined locally. Server, Background and Subagents typechecks pass; all 19 combined runtime tests pass with zero skips (Catalog, cancellation and Background supervision). No claim is made that Subagent launch (#761), worker continuation (#762), result receipt (#763), upgrades (#764), or final aggregate budgets (#765/#782) are complete.

## Shared mutation connection

Cancellation and Background result supervision previously each opened a coordinator connection. They now acquire leases on one main-thread connection per canonical root, separate from the query worker's read connection. Closing either service releases only its lease; final release closes the store. Canonical alias sharing, root isolation and reopen behavior are covered by a new test. Server typecheck and all 19 targeted mutation/cancellation/supervision tests pass. Aggregate connection/CPU budgets still require the full resource acceptance run.

## Shared-read measurement and connection metrics

The macOS shared-read harness completed all six scenarios: 1/5/10 real Pi processes with 4,416 and 10,000 historical records. Unchanged metadata reads and projections stayed at zero in every measurement window. Control RPC p99 ranged from 0.72 to 6.18 ms. Raw CPU/RSS/I/O and lag observations are in `shared-read-resources-macos.json`. This harness excludes guardian and mutation workload; it is not final epic performance acceptance. Rebuild status requests took roughly 979/1562 ms, exposing a remaining status-query dependency on the busy read worker.

Runtime metrics now separately expose `mutationSqlite.active` and `mutationSqlite.leases`; the existing `sqlite` metric remains the query-worker measurement. Real socket cancellation tests activate both mutation services and assert one shared connection with two leases. All seven socket tests, the lease test and Server typecheck pass. The measurement run started at fc142502, while this metrics-only change was being developed; rerun final acceptance on the final committed head.

## Nonblocking diagnostic status

`runtime_get_status` now returns the last observed worker liveness reasons with an explicit `livenessObservation` status and timestamp, while starting at most one asynchronous refresh. Missing evidence is marked unobserved; worker errors are degraded. Cached diagnostic reasons are never used by idle shutdown: it still awaits `livenessReasons()` before fencing admission.

Server typecheck and all 17 executor/lifecycle tests pass, including a deliberate native SQLite stall, 100 shutdown races, restart budgets and failed-worker shutdown. The slow-query regression proves repeated diagnostic requests do not multiply queued refreshes and fresh shutdown checks still wait. The measurement harness now enforces a 250 ms status-response budget during rebuild; the latest 10,000-history measurement returned status in 0.26 ms (previously about 1562 ms).

## Full extension verification and diagnostic refresh correction

Full Background suite: 564 passed, four skipped. The first full Subagents run exposed a duplicate fixture import and old fixtures that attempted packaged runtime installation instead of starting the real test daemon. Migrated those fixtures; UI assertions capture the visible frame before disconnect. The full rerun passes 1,405 tests with seven skips and zero failures, including the previously unloadable batch suite.

macOS CI on c4738fb3 failed with a four-second read deadline during the 10,000-history scenario. Diagnostic refresh still joined full reconciliation even though the socket response itself no longer waited. Added a separate worker observation command that reads the current index without starting or awaiting inventory. Fresh lifecycle checks retain the existing reconcile command. All five executor tests pass, including an explicit no-new-inventory assertion. Cross-platform resource CI must revalidate this correction; the original macOS CI failure is not treated as resolved solely by local tests.

## Cross-platform integration verification

CI run [43738263075](https://github.com/1aboveio/pi-better-harness/actions/runs/43738263075) passed on b0e05b41: all Server shards, workspace checks, Pi compatibility, Linux/macOS resource scenarios, platform sandboxes and Windows verification. This validates the diagnostic-refresh correction against the previously failing macOS workload.

A fresh local resource run completed all six scenarios with zero unchanged metadata reads and projections; raw evidence is in `shared-read-diagnostic-fixed-macos.json`. The harness now preserves the last phase and metrics in a partial report on failure. Startup recovery failure also has a regression proving mutation leases, the global port and exact daemon ownership are released before restart.

This establishes the integrated Catalog/Background/cancellation baseline. Server-managed launch, continuation, precise delivery, pinned upgrades and aggregate guardian/mutation performance remain outstanding.

## Failed-launch writer fence

Inspection of the launch path found cleanup releasing a continuation writer lease immediately after sending SIGKILL. It now waits for the child close event before releasing the lease or removing attempt evidence. A real-process regression proves another continuation is refused during that window and admitted after close. Subagents typecheck and 55 launch, continuation, cleanup-race and batch tests pass. The first targeted command omitted the package isolation preload and is not acceptance evidence; the recorded passing rerun uses `--import ./tests/isolate-registry.mjs`.

This corrects a pre-existing writer-safety gap; it does not implement server-managed launch.

## Integration review and legacy admission fence

Standards review found no confirmed documented-standard violations. It noted duplicated overlay hashing and bounded filesystem observation code as maintainability concerns. Host and server now consume one generated canonical overlay digest; the bounded stat loops remain unchanged.

Spec review found a concrete #760 partial-handoff defect: marking an entire scope managed for a new task could strand an older dead-host task without a result grant. Admission now refuses untransferred legacy tasks. Scope handoff checks durable operations inside its transaction, including operations with no sidecar yet. A database trigger prevents older store implementations from registering legacy work into a managed scope; unknown legacy scopes conservatively conflict with any managed scope in the root. Known other scopes remain independent, and compatible hosts retain grant-before-runner admission.

Review also found the schema-v3 migration skipped that trigger. The first migration open now installs it; a dedicated regression proves enforcement without a second open. Two SQLite connections exercise registration between snapshot and handoff, and registration after handoff. A real frontend is SIGKILLed while its runner stays alive: unrelated launch is refused without fencing discovery, explicit adoption retains the original task authority, and terminal import advances its wait exactly once.

Validation after these fixes: coordinator 121 passed; Background 564 passed/four skipped; 13 real Catalog/supervision tests passed; Server, Background, Subagents and coordinator typechecks passed. The scope fence persists for older clients as intended. Cross-platform raw reports from successful CI b0e05b41 are retained separately; they predate this admission-fence change.

## Main integration and concurrent packaging isolation

Merged main through 3fb5abb8, including the 0.47.0 release and independent status fix. Diagnostic status now consumes the worker-pushed observation; the redundant pull-refresh state and command are removed. Both status observation fields use the same cached evidence, while shutdown still performs a fresh liveness request. Six status/executor tests pass, including blocked initial inventory and stalled SQLite.

CI run 43739843816 exposed concurrent npm prepack rewriting generated source while a daemon imported it (`process.mjs` temporarily lacked its export). The standalone package test now copies source to a private packaging workspace before running prepack. It no longer modifies source consumed by parallel daemon tests. Running standalone packaging and all real result-supervision cases concurrently passes all 13 tests, including pinned Node installation, package integrity, offline restart and mixed-client refusal.

Full Subagents rerun after the scope fence and canonical digest change: 1,407 passed, seven skipped. This run predates the main merge; the post-merge status and packaging runs above exercise the changed paths.
