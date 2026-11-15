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
