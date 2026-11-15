# Managed runtime integration checkpoint

Integration branch: `fix/751-managed-integration`. This is not final epic acceptance.

The branch combines managed launch recovery, server-owned continuation, recipient delivery, durable timing notices, upgrade obligations and admission fencing. Merge resolution preserves both the shared execution context and durable no-attempt refusal receipts. Generated domain sources are regenerated from canonical packages; the Server compiler excludes those source mirrors, while canonical packages retain their own checks.

A fresh `npm ci` in this worktree removed cross-checkout workspace aliases. All workspace typechecks pass. Combined functional checks passed 23 lifecycle/continuation/delivery tests and 124 coordinator tests; a subsequent integrated delivery/query/Background/timing group passed 12 tests. Six query executor tests pass, including actual shared coordinator connection ownership. Real local SDK and HostedSession delivery now uses ordinary observation/timers and callback batching, with no synthetic workflow wake or manual flush.

Integration review added exact branch/Goal matching to upgrade dependency admission, active worker waits without claims to upgrade obligations, and durable completion for launch refusals that never created an attempt. The journal-only recovery fixture verifies original writer PID/recipe, original retry identity, terminal publication with no recipient, and no permanent accepted-intent obligation.

## Still incomplete

- The full-stack resource harness found three coordinator connections against the maximum of two. Sharing the query worker's reader removed one duplicate; a foreground `ObservedWaitHost` still owns a persistent connection and requires proper server mutation/admission migration. The failing report is retained without relaxing the budget.
- Legacy Subagents fixtures still combine mechanical manager and foreground recipient behavior. Their migration has exposed and fixed a real timing-notification loss, but the full Subagents suite has not passed.
- Continuation crash/bridge/capability fixes are integrated and the 17-test combined continuation group passes. Review identified an additional post-lease/pre-journal crash window and tool-policy intersection gap; both require correction and real fault coverage before acceptance.
- Final combined macOS/Linux resource matrices, packaging/upgrade checks, independent review and the requirement-by-requirement epic audit remain required.

## Integrated recipient and installed-domain checks

At `96729d1b`, seven shared-observation/backpressure tests and four real SDK/HostedSession assignment/timing delivery tests pass. The pending-recipient index retains exact-scope terminal obligations older than the normal display cutoff, pages bounded results, and avoids repeated filesystem projection. An actual paused Unix socket fills the production output queue, reconnects after replay truncation, and repairs the exact outcome without a second model turn.

The standalone package test now imports and initializes the fixed managed SDK/domain from the installed artifact, with no repository imports. This exposed shutdown ordering that disposed the SDK before Background announced unavailability. Commit `96729d1b` closes the service first. The installed-domain qualification and cached offline restart both pass (2 tests; 76.7 seconds; local evidence `.work/standalone-dEYLTi`). All workspace typechecks pass after recipient integration.

The Linux/macOS resource CI lane now includes the full process tree measurement, standalone installed-domain/offline qualification, and real socket backpressure recovery. CI results at the final integrated head remain required; configuration alone is not platform evidence.

The broader integrated Server run, using the verified private Node 24.14.1, passes 898 tests (877 passed, 21 skipped, zero failures; 321.9 seconds). It excludes standalone packaging, opt-in remote network installation and the separately validated Subagent runtime matrix. No skipped test is claimed as platform evidence. Initial CI run 43751198478 reproduces the known three-coordinator-connection failure on Linux; the pending Background ownership migration must pass the unchanged bound on both platforms.
