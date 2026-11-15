# Managed runtime integration checkpoint

Integration branch: `fix/751-managed-integration`. This is not final epic acceptance.

The branch combines managed launch recovery, server-owned continuation, recipient delivery, durable timing notices, upgrade obligations and admission fencing. Merge resolution preserves both the shared execution context and durable no-attempt refusal receipts. Generated domain sources are regenerated from canonical packages; the Server compiler excludes those source mirrors, while canonical packages retain their own checks.

A fresh `npm ci` in this worktree removed cross-checkout workspace aliases. All workspace typechecks pass. Combined functional checks passed 23 lifecycle/continuation/delivery tests and 124 coordinator tests; a subsequent integrated delivery/query/Background/timing group passed 12 tests. Six query executor tests pass, including actual shared coordinator connection ownership. Real local SDK and HostedSession delivery now uses ordinary observation/timers and callback batching, with no synthetic workflow wake or manual flush.

Integration review added exact branch/Goal matching to upgrade dependency admission, active worker waits without claims to upgrade obligations, and durable completion for launch refusals that never created an attempt. The journal-only recovery fixture verifies original writer PID/recipe, original retry identity, terminal publication with no recipient, and no permanent accepted-intent obligation.

## Still incomplete

- The full-stack resource harness found three coordinator connections against the maximum of two. Sharing the query worker's reader removed one duplicate; a foreground `ObservedWaitHost` still owns a persistent connection and requires proper server mutation/admission migration. The failing report is retained without relaxing the budget.
- Legacy Subagents fixtures still combine mechanical manager and foreground recipient behavior. Their migration has exposed and fixed a real timing-notification loss, but the full Subagents suite has not passed.
- Further continuation crash/bridge/capability fixes are being validated on the continuation branch before integration.
- Final combined macOS/Linux resource matrices, packaging/upgrade checks, independent review and the requirement-by-requirement epic audit remain required.
