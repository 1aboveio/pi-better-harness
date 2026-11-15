# Final acceptance gates for #765 and #782

This checklist preserves the accepted design's budgets. Existing resource JSON is partial evidence, not proof of full epic completion.

| Gate | Runnable evidence | Remaining scope |
| --- | --- | --- |
| Actual provider #749, 1/50 rows | Subagents `tests/navigator_provider_projection.test.mjs` | Rerun integrated head; resource probe must call the registered provider, not only Pi get_state. |
| Archive #747, 4,416/10,000 | Subagents `tests/archive_history_budget.test.mjs`; Server resource script | Zero unchanged archive reads/per-record marker stats; atomic change touches affected record only. |
| 1/5/10 real clients, same unchanged scope | `node packages/pi-better-server/scripts/measure-shared-reads.mjs` | Provider probe uses one fixture conversation for identical authorized scope; no prompts are submitted. Ten-client/10k window remains 60 seconds. |
| Full aggregate resources | Existing resource script reports Pi + server + idle work probe | Missing real guardian, running worker/runner, mutation activity, multiple HostedSessions and mixed local/remote clients in one fixed-machine report. Do not label idle work probe a real runner. |
| Root SQLite <=2 coordinator, <=2 derived | Executor + mutation service metrics/tests | Must account for both threads and main-thread services during actual managed launch, continuation, cancellation and result delivery. Read-worker active count alone is insufficient. |
| Socket response under slow SQLite/index rebuild | Server `test/query-executor.test.ts` plus resource rebuild measurements | Preserve measured p50/p95/p99 and lag; also prove supervision deadlines while stalled. |
| External writer/overflow/replay/backpressure | Server runtime work/scope/archive tests and executor tests | Integrated-head run and explicit external/overflow cases; no inference from warmed cache alone. |
| Default 30s +5s idle exit; guardian recovery; 100 close races | Server `test/runtime-lifecycle.test.ts`, socket lifecycle/startup tests | Exact PID/start/token identity, both guardian and server; accepted work survives parent/server exit without duplicate dispatch. |
| Paint budget | Actual Navigator render budget tests | 60 unchanged frames: zero filesystem/metadata stat/database/provider I/O. Provider refresh is a separate path. |
| Platform/package matrix | CI Linux/macOS resources; packed standalone test; remote upgrade tests | Repeat after integration, including independent Subagents, Background, Harness and mixed HostedSessions. |
| Remove migrated foreground loops | Source review plus idle-process counters | Inventory all remaining `setInterval`, registry scans, discovery and supervision ownership; fallback absence must be exercised with no server. |

Run Subagents tests from its package with `node --import tsx --import ./tests/isolate-registry.mjs --test ...`. Run Server tests from its package with `node --import tsx --import ../../scripts/isolate-registry.mjs --test ...`. Set `PI_TEST_PRIVATE_RUNTIME_NODE` to the verified Node 24.14.1 binary for artifact tests. Run the resource script from repository root and set `PI_SHARED_READ_REPORT` to retain raw output. Non-isolated tests can query unrelated global state and are not acceptance evidence.

The resource harness previously created real Pi processes but sent only get_state; seeded records had no matching callbackOrigin, so their real provider lists were empty. The repaired harness calls each actual registered provider, requires visible active rows, and instruments per-process archive reads and marker stats. It reports machine characteristics, PID/start/token identities and aggregate I/O. This repairs an evidence gap without claiming the missing full-stack scenarios above.

## Repaired harness run

All six 1/5/10-client and 4,416/10,000-history scenarios passed on macOS. Every real Pi's registered provider returned the two matching active rows. Unchanged client archive JSON reads and per-archive marker stats were zero, as were shared metadata reads and projections; the ten-client/10,000-history measurement ran for 60 seconds. Raw report: `shared-read-actual-provider-macos.json`. This run uses main d2bfeea0 plus the harness changes, not the pending launch/continuation/upgrade integration. Repeat on the integrated head and Linux before final acceptance.

## Full-stack connection gate

Run `PI_TEST_PRIVATE_RUNTIME_NODE=<verified Node 24.14.1> PI_FULL_RUNTIME_REPORT=<report.json> node --import tsx packages/pi-better-server/scripts/measure-full-runtime.mjs` from repository root after isolated `npm ci`. It launches the real guardian, server, two HostedSessions, SDK clients with both production extensions, a managed Subagent worker and a Background runner/command. All process roles carry exact PID/start/token identities and report CPU/RSS/I/O/main-loop lag; worker-thread SQLite metrics are added separately. Diagnostic sampler overhead is included. The 10-client steady running-work window is 60 seconds. No model network is used.

The first independently installed integration run failed the unchanged coordinator <=2 budget with three actual connections: one query-worker reader, one server mutation connection, and the foreground Background ObservedWaitHost store. Before sharing the query reader across Subagents and Background, there were four. Derived index connections remained one. The harness stops on the real budget failure rather than hiding the frontend or weakening the bound. `full-runtime-coordinator-budget-red-macos.json` preserves the failing report; remaining 5/10-client scenarios need rerunning after foreground ownership migration. This is a concrete incomplete #765/#782 gate, not accepted performance evidence.
