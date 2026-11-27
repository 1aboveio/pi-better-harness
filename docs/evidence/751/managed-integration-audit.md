# Managed runtime integration checkpoint

> **Status authority:** [Current acceptance matrix](status-index.md). This is a historical checkpoint; its open gaps and test counts are not the current completion status. Original evidence is retained below.

Integration branch: `fix/751-managed-integration`. This is not final epic acceptance.

The branch combines managed launch recovery, server-owned continuation, recipient delivery, durable timing notices, upgrade obligations and admission fencing. Merge resolution preserves both the shared execution context and durable no-attempt refusal receipts. Generated domain sources are regenerated from canonical packages; the Server compiler excludes those source mirrors, while canonical packages retain their own checks.

A fresh `npm ci` in this worktree removed cross-checkout workspace aliases. All workspace typechecks pass. Combined functional checks passed 23 lifecycle/continuation/delivery tests and 124 coordinator tests; a subsequent integrated delivery/query/Background/timing group passed 12 tests. Six query executor tests pass, including actual shared coordinator connection ownership. Real local SDK and HostedSession delivery now uses ordinary observation/timers and callback batching, with no synthetic workflow wake or manual flush.

Integration review added exact branch/Goal matching to upgrade dependency admission, active worker waits without claims to upgrade obligations, and durable completion for launch refusals that never created an attempt. The journal-only recovery fixture verifies original writer PID/recipe, original retry identity, terminal publication with no recipient, and no permanent accepted-intent obligation.

## Current acceptance gaps

- Server-owned Background now meets the recorded macOS root connection budget at 1/5/10 clients. Final clean-head Linux/macOS resource and installed-package runs remain required.
- Native fast-terminal observation exposed a missing discovery path. Indexed recent-terminal discovery and exact-recipient callback recovery are being completed; old owed callbacks must survive beyond display retention without history scans.
- Mixed local/remote execution coverage and the final requirement-by-requirement epic audit remain required.

## Integrated recipient and installed-domain checks

At `96729d1b`, seven shared-observation/backpressure tests and four real SDK/HostedSession assignment/timing delivery tests pass. The pending-recipient index retains exact-scope terminal obligations older than the normal display cutoff, pages bounded results, and avoids repeated filesystem projection. An actual paused Unix socket fills the production output queue, reconnects after replay truncation, and repairs the exact outcome without a second model turn.

The standalone package test now imports and initializes the fixed managed SDK/domain from the installed artifact, with no repository imports. This exposed shutdown ordering that disposed the SDK before Background announced unavailability. Commit `96729d1b` closes the service first. The installed-domain qualification and cached offline restart both pass (2 tests; 76.7 seconds; local evidence `.work/standalone-dEYLTi`). All workspace typechecks pass after recipient integration.

The Linux/macOS resource CI lane now includes the full process tree measurement, standalone installed-domain/offline qualification, and real socket backpressure recovery. CI results at the final integrated head remain required; configuration alone is not platform evidence.

The broader integrated Server run, using the verified private Node 24.14.1, passes 898 tests (877 passed, 21 skipped, zero failures; 321.9 seconds). It excludes standalone packaging, opt-in remote network installation and the separately validated Subagent runtime matrix. No skipped test is claimed as platform evidence. Initial CI run 43751198478 reproduces the known three-coordinator-connection failure on Linux; the pending Background ownership migration must pass the unchanged bound on both platforms.

## CI follow-up and native reload

The first combined CI run (43751198478) reproduced the three-connection budget failure on both Linux and macOS. It also exposed Node 22 directly running managed-domain tests, an outcome-commit assertion race, old foreground-manager fixture assumptions, and a guardian test killing its first process before protocol readiness. The fixture corrections preserve the production private Node requirement and the accepted connection bound.

Five managed connection/lifecycle assertions pass under private Node 24, invoked successfully by an actual Node 22.22.2 host. The guardian recovery case passes after awaiting real protocol readiness before SIGKILL. Four native reload journeys pass against the installed fixed SDK and explicitly configured offline provider, including original-worker continuity, one exact completion, server-loss log finalization, and saved-conversation follow-up without Background. No PATH-injected worker CLI is used.

The integrated terminal-failure replay group passes all eight tests. An old handled lost record can receive a new malformed log while its foreground is disconnected; the manager writes canonical failure evidence and the exact saved session receives the new notification once. Review of this new folding path must still establish bounded main-thread work and backlog behavior before final query-isolation acceptance.

## Native integration checkpoint at `11c1d7e3`

Background supervision and request recovery are server-owned. Explicit cross-session `all:true` cancellation retains the actual requester and the target's original owner/token/host/revision, with requester-scoped retry keys. Native same-workspace and cross-workspace cases also verify that the requester cannot fabricate the owner's evidence-read acknowledgment.

The whole Harness sandbox journey now loads its published shims through a real SDK AgentSession. All nine checks pass, including server-owned durable Background execution and kernel-enforced writes. Native codemode passes six cases against Pi 0.99.1; actual Node 22 remote managed-connect passes all 20 cases. All workspace typechecks pass. The integrated Subagents health/lifecycle suite passes 46 tests, including all three cases that failed in CI run 43753106418.

Large terminal-log folding now uses a separate mechanical worker with no SQLite connection, bounded indexed work, fair requeueing and epoch revocation. Eleven integrated tests pass, including a 128 MiB log, multi-batch drain and socket responsiveness. Background durable request recovery uses 128-row indexed batches with event-loop yields; its migration/query-plan fixture includes 10,000 completed requests and 260 pending requests. These checks close the earlier unbounded folding/recovery findings; final aggregate measurements still apply.

CI run 43755946344 tests this checkpoint while callback-index and mixed-client work continues. It is not final-head acceptance.
