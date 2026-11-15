# Unified runtime acceptance status

**Validation complete. PR merge and issue closure pending.** [CI8 run 43766305095](https://github.com/1aboveio/pi-better-harness/actions/runs/43766305095) passed all 18 jobs on `9acbc1a90b53695d60672e680950d7df966f5cab`, including the aggregate `ci` gate. The [final validation record](ci8-final-validation.md), [job summary](ci8-jobs.json) and [resource summary](ci8-resources/summary.json) are the current evidence. Documentation added after that source does not change the validated runtime.

This index supersedes status claims in earlier checkpoint audits. Their initial failures, incomplete matrices and pending-CI statements remain historical evidence, not current blockers. Passing validation does not itself merge a PR or close an issue.

## Requirement matrix

| Requirement | Final integrated evidence | Status |
| --- | --- | --- |
| #761 managed launch and authority | Real launch/bootstrap, ownership/fence/recovery, native reload and permission tests; exact writer identity, durable intent recovery, original-owner capacity and captured/current authority | Validated in green CI8 |
| #762 continuation after foreground exit | Eleven parked-worker scenarios, permission narrowing/tool intersection, bounded unavailable backoff and idle shutdown, crash-window and at-most-once recovery; same-instance runtime diagnostics | Validated in green CI8 |
| #763 exact recipient delivery | Real local SDK and HostedSession result/timing flows, branch/Goal binding and native receipts, unread-result exclusion from daemon liveness, actual slow Unix socket replay; bounded dirty-notification recovery and stale-generation fencing | Validated in green CI8 |
| #764 pinned-build upgrades | Activation/connection obligations, durable admission fence with exact accepted-worker exception, migration/future-schema refusal, installed artifact, offline restart and corruption qualification | Validated in green CI8 |
| #765 migration and supported platforms | Server-owned Background/Subagents mechanical work, standalone and whole-Harness/native journeys, mixed ordinary local/remote execution, Linux/macOS package/offline/resource qualification | Validated in green CI8 |
| #782 bounded reads and resource budgets | Shared read connection, isolated/fair bounded failure folding, indexed request/callback recovery, real SQLite stalls with supervision progress, bounded read-worker recovery and aggregate process measurements | Validated in green CI8 |
| #749/#747 provider and archive budgets | Actual registered provider; 1/50-row rendering and 60 unchanged paints; 4,416/10,000-history × 1/5/10-client matrix with zero unchanged metadata/projection/provider archive/marker work | Validated in green CI8 |
| Healthy event publication | External atomic commit to matching pushed Unix subscription event, no polling shortcut; directory-entry watchers survive repeated file/child/root replacement | 320/320 platform observations <=1 s; maximum 243.19 ms |

Foundational lifecycle, transport, cancellation, Catalog and Background work remains part of the integrated runtime. Default 30-second idle plus five-second shutdown, 100 admission/shutdown races, exact PID/start/token recovery, query isolation and no foreground mechanical fallback were preserved. The unavailable-continuation fixture advances the existing idle-clock seam only after durable terminal facts and actual client detachment; independent wall-clock lifecycle tests remain intact.

## Final resource conclusions and scope

Both platforms completed all three full-runtime and six shared-read scenarios. Every full window retained coordinator 2 / derived 1 and zero unchanged Background scope refresh/reconciliation. Every shared window retained zero metadata reads/projections and actual-provider archive/marker work. Full-runtime and 10,000-history ten-client windows ran for at least 60 seconds. Final machine/process timing, CPU, RSS, I/O, lag, source and content manifests are retained in compressed original reports linked from the [final validation record](ci8-final-validation.md).

Remote evidence uses two real RemoteClientSession adapters over loopback Unix transport and HostedSessions alongside ordinary local clients and actual server-owned work. Exact recipient isolation passed. This is not cross-machine SSH performance evidence. Full totals include the actual guardian/server/worker/runner/client/adapter processes and instrumentation; shared-read totals cover a narrower standalone read slice. Windows verification passed its CI contracts but is not claimed as a managed-runtime resource platform. Optional skipped tests are not counted as coverage.

All final reports identify the CI8 source and preserve nonempty installation-related dirty fields for `cli.ts`/`remote-cli.ts`; they are not labeled clean-checkout measurements. Older clean local reports remain useful historical evidence, but final supported-platform qualification comes from CI8.

## Completion actions

1. Review the documentation-only acceptance delta, merge the implementation PR and reconcile engineering issue status with this evidence.
2. Close the epic and implementation issues only after merge/closure actions are actually completed. No implementation or validation gap is left open in this index.

Earlier [acceptance](acceptance-audit.md), [managed integration](managed-integration-audit.md), [launch](subagent-launch-audit.md), [continuation](subagent-continuation-audit.md), [delivery](recipient-delivery-audit.md), [Background ownership](background-ownership-audit.md), [upgrade](upgrade-audit.md), [final gates](final-acceptance-gates.md), [CI6](ci6-resource-validation.md) and [CI7](ci7-resource-validation.md) records are retained for audit history.
