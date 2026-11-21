# Managed Subagent launch audit

> **Status authority:** [Current acceptance matrix](status-index.md). This is a historical checkpoint; its open gaps and test counts are not the current completion status. Original evidence is retained below.

Integration base: main d2bfeea0 (Catalog/Background PR #789 merged after CI 43741123570 passed).

The existing #761 branch contains a fixed managed launch host, durable intent journal, bootstrap writer fence, per-original-owner capacity, client admission and managed supervision hooks. The old PR description incorrectly described it as an integration-only baseline. This work is not yet acceptance-complete.

## Integration evidence

Resolved the main merge by retaining both runtime capabilities, worker-isolated reads, shared Background supervision and startup cleanup. Failed-launch cleanup retains writer ownership until child close. A derived read refresh runs independently of the accepted launch receipt.

Server and Subagents typechecks pass. The real SDK launch test passes with pinned Node 24.14.1: frozen Catalog recipe, same-key retry, original-owner capacity separation, exact bootstrap refusal, parent exit, server restart without duplicate attempts, and saved-conversation continuation. The fixture now uses canonical transport paths and bounded terminal waits; cleanup checks process-start identity. Recovery currently uses the existing 15-second health pass, so its terminal wait allows 20 seconds. This is not a measured final event-latency guarantee.

## Review findings still requiring implementation

- Journal-only recovery now restores a frozen metadata snapshot using the exact writer PID/start identity and lease after fencing the previous epoch. A never-bootstrapped attempt becomes lost; unknown live writer identity/authority refuses recovery. Prior accepted intents receive durable recovered/not-launched receipts so they do not occupy capacity or block upgrades forever.
- The launch journal now uses the coordinator mutation store. Tests prove the launch service shares the root connection, closing it preserves another service’s lease, stale journal access fails after final close, and constructor failure releases the lease before retry. Full runtime connection accounting remains part of the final resource acceptance.
- Failed host recovery needed cleanup. The fixed adapter now closes the host on failure, and SDK initialization errors are surfaced. Additional fault tests must prove cleanup of partial initialization and retry behavior.

The broader crash-point, permission-intersection, legacy-owner and packaging matrices remain to be verified before #761 can close. #762–#765 and the final #782/epic budgets remain outstanding.

## Shared launch journal validation

Moved durable launch operations into the canonical coordinator StoreContext and regenerated standalone/runtime copies. Coordinator and Server typechecks pass. Ten focused server tests pass, including the real SDK launch/restart case; the additional injected epoch-failure test passes and proves factory cleanup and retry. Host shutdown now releases journal resources even when SDK shutdown throws. Server-level retry after failed initialization and journal-only crash recovery remain outstanding.

## Journal-only recovery evidence

The real SDK fixture now covers ordinary restart and SIGKILL followed by restoration of the durable pre-metadata/pre-receipt state while the detached workers remain alive. Both scenarios retain the original PIDs and recipes, reject stale bootstrap, complete from worker evidence, and permit saved-conversation continuation. This is explicit durable-state fault injection; it does not claim instruction-level interruption at every write boundary. The recovered same-key request returns the original attempt IDs without dispatching another token.

Four recovery classification tests cover pre-bootstrap fencing, live exact writer adoption, unknown authority refusal, and dead/recycled identity preservation. Fourteen focused server tests pass. Five real confined worker kernel tests pass after replacing TypeScript parameter properties in the canonical journal (Node strip-only compatibility).

The broad Subagents suite currently does not pass: its first run reported 1255 passes, 149 failures, and seven skips. The strip-only failure is fixed and its five affected kernel tests pass; many remaining failures are old foreground factory fixtures now reaching managed admission or expecting replaced foreground health loops. These need migration to the new ownership boundary, not a production fallback. The workspace-wide typecheck also exposed Goal/Harness dependency API mismatches and render-scheduler node-type configuration errors; coordinator and Server targeted checks pass. No full-suite or #761 acceptance claim is made.

Managed terminal publication now commits assignment outcomes before suppressing parent delivery. Startup also publishes recovered terminal assignments independently of recipient attachment. A fixed runtime binding routes assignment operations through the shared mutation store. The real journal-only SDK scenario proves the original recipient is absent when its terminal outcome becomes durable, and proves no accepted launch intent remains as a permanent upgrade obligation.
