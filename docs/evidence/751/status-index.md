# Unified runtime acceptance status

**Current status: implementation and targeted acceptance evidence are integrated; #751 is not yet complete. Final CI6 qualification is pending.** This index supersedes the status claims in earlier checkpoint audits, while preserving their failures and raw reports as history.

Reviewed source: `57f831e4` (includes final local resource evidence). CI4 passed both Linux and macOS resource lanes, including full/shared measurements, packaging, offline restart and socket backpressure qualification. CI4 also exposed two Background projection regressions: scoped runner terminals could disappear before canonical publication, and ordinary scoped reads hydrated unrelated recent history. Both are corrected in `efaa87b0`, with the original visibility and read-count assertions retained. Fixture corrections and a complete final-head CI run remain required. Passing resource lanes are not a green aggregate CI result. Issue closure and PR merge remain separate actions.

CI5 at `e044fa4d` passed macOS resource, native Harness/sandbox, both extension compatibility versions, and the corrected Background paths. It exposed Linux atomic-replacement watcher loss (events fell back to the one-second inventory), a stale assignment result overriding an already-read canonical terminal, and lifecycle fixture ownership/setup races. The watcher and result fixes have focused regressions; the file-scoped query fixture now retains a real client. Final source must be requalified on both platforms. Earlier successful resource reports below are explicitly historical after these runtime corrections.

## Requirement matrix

| Requirement | Integrated evidence | Current gate |
| --- | --- | --- |
| #761 managed launch and authority | Real `runtime-subagent-launch`, `bootstrap-restart`, ownership/fence/recovery tests; exact writer identity and durable intent recovery; native reload; captured/current permission intersection | Targeted evidence integrated; final CI pending |
| #762 continuation after foreground exit | Eleven parked-worker scenarios, current-policy narrowing and tool intersection, unavailable backoff/idle, crash-window and at-most-once recovery | Targeted evidence integrated; final CI pending |
| #763 exact recipient delivery | Real local SDK and HostedSession result/timing flows, branch/Goal binding, native receipts, unread-result exclusion from daemon liveness, actual slow Unix socket replay | Targeted evidence integrated; final CI pending |
| #764 pinned-build upgrades | Activation/connection obligation tests; durable admission fence with exact accepted-worker exception; migration/future-schema refusal; installed artifact, offline restart and corruption coverage | Targeted evidence integrated; CI4 resource package/offline lanes passed; final CI pending |
| #765 migration and supported platform matrix | Server-owned Background and Subagents mechanical work; standalone and whole-Harness/native journeys; actual provider/render tests; mixed ordinary local plus RemoteClientSession execution | Targeted evidence integrated; CI4 Linux/macOS resource lanes passed; final compatibility/fixture CI pending |
| #782 bounded reads and resource budgets | Shared read connection, isolated mechanical failure folding, fair bounded fold queue, indexed request/callback recovery, real SQLite stalls with supervision progress, bounded read-worker restart, 1/5/10 process measurements | Local final resource runs and CI4 Linux/macOS resource lanes passed; final CI pending |
| #749/#747 provider and archive budgets | Actual registered provider, 1/50-row render coverage and 60 unchanged paints; 4,416/10,000-record shared-read matrix with zero unchanged metadata/projection/provider archive/marker work | Recorded measurements passed; final CI pending |
| Healthy event publication | External atomic commit to matching pushed subscription event; five commits per 1/5/10 subscriber scenario, no polling shortcut | All 160 final local observations passed <=1 s; maximum 102.84 ms. Probe added after CI4; CI6 pending |

Foundational lifecycle, transport, cancellation, Catalog and Background work is included in the integrated runtime. The original default 30-second idle plus five-second shutdown, 100 admission/shutdown races, exact PID/start/token recovery, query isolation and no-foreground-fallback constraints remain requirements; fixture changes do not relax them. The unavailable continuation test advances the existing idle-clock seam only after durable terminal facts and actual client detachment, while independent wall-clock lifecycle tests remain intact.

## Current resource evidence

[Final resource validation](final-resource-validation.md) gives exact commands, source stamps, limitations and raw report links by filename. It is the current local resource record:

- Full mixed runtime: clean `f49a0731`, all 1/5/10 scenarios, 60-second ten-client window, coordinator 2 / derived 1, zero unchanged Background reconciliation/scope refresh, and exact remote recipient isolation. Aggregate includes guardian, server, native clients, real worker/runners/commands and the remote-adapter driver.
- Shared archive reads: clean `28ab0add` (same runtime plus publication/provenance harness additions), all six 4,416/10,000 × 1/5/10 scenarios, including the 60-second 10,000/10 window and pushed publication measurements.
- Remote coverage is two real RemoteClientSession adapters over loopback Unix transport with HostedSessions. It does not claim cross-machine SSH performance.

CI4 artifacts were downloaded to `/tmp/pi-751-ci4-artifacts/{linux,macos}/_temp/{full-runtime,shared-read}-resources.json`. All four reports have no failure: each full report contains three scenarios and each shared report six. Full reports identify `f49a0731` and retain nonempty dirty manifests for `cli.ts`/`remote-cli.ts`; they must not be called clean-checkout measurements. The older shared harness did not record a source stamp or publication probe. CI provenance therefore comes from the CI run, not an invented report field. The clean local reports above supplement rather than rewrite those artifacts. No duplicate large raw files are added here.

## Remaining completion actions

1. Complete lifecycle fixture verification and obtain complete final-head CI6 results; record its run URL, source and exact lane outcomes here.
2. Confirm final CI covers the publication probe, copied-source provenance, package/offline checks and native compatibility journeys, without counting skipped tests as coverage.
3. Reconcile the final requirement matrix with the engineering issues and PRs before declaring #751 complete. Earlier audit text saying mixed clients are unmeasured, the root has three coordinator connections, or old broad suites still have their initial failure counts is historical, not the current diagnosis.
