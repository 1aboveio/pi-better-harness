# Managed Subagent launch audit

Integration base: main d2bfeea0 (Catalog/Background PR #789 merged after CI 43741123570 passed).

The existing #761 branch contains a fixed managed launch host, durable intent journal, bootstrap writer fence, per-original-owner capacity, client admission and managed supervision hooks. The old PR description incorrectly described it as an integration-only baseline. This work is not yet acceptance-complete.

## Integration evidence

Resolved the main merge by retaining both runtime capabilities, worker-isolated reads, shared Background supervision and startup cleanup. Failed-launch cleanup retains writer ownership until child close. A derived read refresh runs independently of the accepted launch receipt.

Server and Subagents typechecks pass. The real SDK launch test passes with pinned Node 24.14.1: frozen Catalog recipe, same-key retry, original-owner capacity separation, exact bootstrap refusal, parent exit, server restart without duplicate attempts, and saved-conversation continuation. The fixture now uses canonical transport paths and bounded terminal waits; cleanup checks process-start identity. Recovery currently uses the existing 15-second health pass, so its terminal wait allows 20 seconds. This is not a measured final event-latency guarantee.

## Review findings still requiring implementation

- Recovery examines metadata records but misses journal-only attempts when a crash occurs after prepare/spawn/bootstrap and before metadata publication. Such attempts need reconciliation of their exact token, writer and lease; permanent outcome_unknown and permanent capacity occupancy do not satisfy the design.
- The launch journal now uses the coordinator mutation store. Tests prove the launch service shares the root connection, closing it preserves another service’s lease, stale journal access fails after final close, and constructor failure releases the lease before retry. Full runtime connection accounting remains part of the final resource acceptance.
- Failed host recovery needed cleanup. The fixed adapter now closes the host on failure, and SDK initialization errors are surfaced. Additional fault tests must prove cleanup of partial initialization and retry behavior.

The broader crash-point, permission-intersection, legacy-owner and packaging matrices remain to be verified before #761 can close. #762–#765 and the final #782/epic budgets remain outstanding.

## Shared launch journal validation

Moved durable launch operations into the canonical coordinator StoreContext and regenerated standalone/runtime copies. Coordinator and Server typechecks pass. Ten focused server tests pass, including the real SDK launch/restart case; the additional injected epoch-failure test passes and proves factory cleanup and retry. Host shutdown now releases journal resources even when SDK shutdown throws. Server-level retry after failed initialization and journal-only crash recovery remain outstanding.
