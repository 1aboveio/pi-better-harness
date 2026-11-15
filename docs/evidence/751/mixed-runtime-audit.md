# Mixed native and remote runtime evidence

The full resource matrix now uses two real `RemoteClientSession` presentation adapters over Unix transport attached to two real HostedSessions, concurrently with ordinary local SDK clients. This exercises the logical remote adapter boundary; it does not claim cross-machine SSH/network coverage.

The originating remote session launches a real canonical Background tool through its hosted extension. That runner and command remain active alongside the local managed Subagent, local Background runner/command, and legacy commands throughout the 1/5/10-local-client measurements. The server owns mechanical execution. Remote adapters have no local extension handlers; ordinary local clients open no coordinator connection. The measurement process that hosts both remote adapters is included in aggregate CPU/RSS, as are the actual remote runner and command.

After completion, the originating remote session receives the exact native `background-terminal:<operationId>` receipt. Neither the second remote session nor the ordinary local session receives it. The reusable `runtime-mixed-remote.test.ts` smoke test asserts these routes, roles, canonical-root ownership, and isolation without presenting its shortened measurement as performance evidence.

`full-runtime-mixed-remote-macos.json` records the full run. All three windows held 2 coordinator connections and 1 derived index; unchanged-window Background reconciliation and scope refresh deltas were zero. The 60-second 10-local-client window measured RPC p95 1.61 ms and p99 4.65 ms. It included sampler/driver overhead and measured 7,164 aggregate CPU ms and 4.54 GB aggregate RSS across all related sampled processes.

## Unavailable continuation CI diagnosis

The original unavailable-continuation scenario passed unchanged locally in 9.2 seconds. The CI failure log showed markedly slower scheduling/startup (the preceding standalone scenario took 12.2 seconds versus roughly 2 seconds locally); it did not contain evidence identifying a retained production owner. No production liveness defect was reproduced.

The regression now waits for the parked attempt's terminal metadata and verifies that all accepted dependencies have durable terminal revisions. A hello-only diagnostic connection verifies actual runtime-client detachment without granting runtime liveness. The fixture advances the existing daemon clock seam and invokes the exact production `sweepIdle` path, which still checks real live writers/runners and accepted work. It does not force-close the daemon or modify liveness facts. Failures include the last real status. Independent wall-clock idle and race tests remain unchanged.
