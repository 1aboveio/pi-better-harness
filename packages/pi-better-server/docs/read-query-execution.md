# Read Query Execution

This policy implements the query execution boundary for #753 and #782 within
ADR 0023. It does not change coordinator authority or execution admission.

## Ownership

One server lazily starts one read worker thread for its canonical agent root.
The worker owns the derived index, retained coordinator reader, source inventory,
projections, detail parsing, snapshot JSON encoding and subscription capture.
Normal operation retains one derived-index connection and at most one coordinator
connection. Both are counted by actual database constructor/close instrumentation
inside the worker; test budgets add any main-thread connections separately.

A coordinator revision change performs one read-only source pass to fingerprint
waits, resume-claim lineage and assignment outcomes by conversation. Only changed
conversations are reprojected; unknown source/schema state conservatively retries
coordinator-bound rows. An unrelated wait update does not reparse historical logs
or reproject every archived attempt.

The main event loop handles the existing bounded LF-JSON protocol, small response
envelopes, pre-encoded snapshot writes, admission, deadlines and event delivery.
It does not run read-model SQLite, filesystem inventory, log parsing or projections.
The existing 1 MiB request and 32 in-flight requests per connection remain in force.
No arbitrary SQL, launch or mutation operation is accepted by the executor.

## Bounds

| Resource | Bound |
| --- | --- |
| Executing read operations | 1 per canonical root |
| Executing plus queued operations | 64 per root |
| Read connections | 64 per root |
| Logical read deadline, including queue wait | 4 seconds, before the client's 5-second timeout |
| Executor close wait | 1 second |
| Cached scopes | 32, with at most 16 MiB of serialized snapshots |
| Background observation scopes | 128; active subscriptions stay pinned, one-shot scopes evict by least recent use |
| Individual snapshots / socket event allowance | 4 MiB |
| Worker event producer | One unacknowledged event plus one replaceable latest event per connection |
| Worker revision notifications | One unacknowledged notification plus one dirty bit |
| Timing samples | Last 128 observations per metric |

The queue reports `runtime-overloaded` when full. Equivalent in-flight snapshot
queries share one operation. Identity includes the executor's immutable canonical
root, observed invalidation generation, normalized workspace, origin session,
exact run, filters, detail flag, page size and cursor. Equivalent status sets and
omitted/default page sizes normalize to the same identity. Context is never shared
between roots or origin sessions.

Disconnect removes that connection's waiters. An unneeded queued operation is
removed immediately. A running shared read may finish for surviving waiters and
populate the bounded cache. Subscriptions remain per connection; initial capture
and observer installation occur at the same synchronous worker serial point.
Changing subscriptions advances a connection generation so buffered old-scope
events cannot overwrite the new scope. Slow readers retain the existing explicit
resync behavior. Full snapshots can replace intermediate notifications.

## Failure And Shutdown

An active deadline or worker error rejects admitted and future reads, drops queued
work, requests resync and marks the executor degraded. There is no automatic worker
replacement or restart loop. Cached read-model metrics and the ordinary server
status RPC remain available. A new server instance rebuilds derived state and
uses its new instance identity; failed-worker replies are ignored.

`Worker.terminate()` cannot interrupt a native SQLite call immediately. The executor
therefore distinguishes logical cancellation from actual worker exit and reports
`stopping` until exit occurs. Database counts become zero only after actual exit.
The close API stops waiting after one second, but neither worker `unref()` nor
`process.exit()` proves that the process has exited while native SQLite is busy.
The guardian/lifecycle implementation in #755 must enforce and verify the process
hard-stop budget after graceful shutdown; this query slice does not claim that
epic acceptance criterion. A test-only 60-million-row recursive SQLite query
demonstrates the limitation without exposing arbitrary SQL over the protocol.

## Measurements And Remaining Evidence

Run from `packages/pi-better-server`:

```sh
node --import tsx --import ../../scripts/isolate-registry.mjs --test test/query-executor.test.ts test/runtime-work.test.ts
```

On macOS arm64, Node 24.21.0, the deliberate 10-million-row query took 1,184.56 ms.
Concurrent Unix-socket RPC latency was p50 0.115 ms, p95 0.253 ms and p99 0.394 ms.
Main event-loop sampling at 10 ms resolution reported p50 11.03 ms, p95 11.17 ms
and p99 11.35 ms. These are observed histogram delays, not delay above the sampling
interval. The long native-query test rejected readers at 4,000.99 ms and returned
from close after 1,000.11 ms; actual worker exit took 11,728.04 ms.

The real daemon test uses 1/5/10 independent socket clients and processes, counts
actual worker plus main SQLite connections, imports external writer changes, and
verifies one underlying query per cold shared scope and none for its warmed reads.
The 10,000-record history fixture continues to enforce changed-record projection
and indexed pagination budgets. Queue saturation, surviving shared waiters,
disconnect cancellation, failure, producer credit and subscription replacement
have dedicated tests.

For real Pi process measurements, run from the repository root:

```sh
PI_SHARED_READ_REPORT=/tmp/shared-read-resources.json node packages/pi-better-server/scripts/measure-shared-reads.mjs
```

The script starts actual Pi RPC processes with standalone Subagents and seeded
read-only work records. It samples control RPC at 10 Hz, counts actual worker
database connections, and reports each Pi, the complete server process (including
its worker thread), and the fixture work process. Setup, the measurement driver,
and fixture writes are outside the steady-state resource window. Three-second
windows cover each 1/5/10-client scenario; the 10-client, 10,000-record case also
runs for 60 seconds. Short-window RSS can include startup garbage awaiting GC.
The macOS/Linux CI matrix uploads the JSON report and gates the required CI check.

Observed macOS arm64 results, Node 24.21.0, workspace Pi 0.82:

| History | Pi Clients | Window | Total CPU | End RSS | RPC p50 / p95 / p99 |
| --- | --- | --- | --- | --- | --- |
| 4,416 | 1 | 3.03 s | 193 ms | 719 MiB | 0.234 / 0.283 / 0.302 ms |
| 4,416 | 5 | 3.05 s | 308 ms | 1,188 MiB | 0.780 / 1.295 / 2.249 ms |
| 4,416 | 10 | 3.09 s | 474 ms | 1,870 MiB | 2.025 / 5.765 / 6.144 ms |
| 10,000 | 1 | 3.04 s | 444 ms | 856 MiB | 0.221 / 1.056 / 2.446 ms |
| 10,000 | 5 | 3.04 s | 556 ms | 1,394 MiB | 0.315 / 1.450 / 1.849 ms |
| 10,000 | 10 | 60.03 s | 12,126 ms | 1,736 MiB | 0.808 / 2.656 / 6.245 ms |

Each short window performed three shared compatibility inventories; the long
window performed 60. All windows reread zero source metadata records and performed
zero assignment reprojections. Filesystem block-input/output deltas were zero;
those OS counters do not count cached `stat` calls or prove zero filesystem calls.
The 10,000-record rebuild took 1,319 ms while control RPC measured
0.120 / 0.170 / 0.310 ms at p50 / p95 / p99. Server event-loop histogram delay in
the 60-second case was 10.879 / 11.100 / 12.075 ms at 10 ms sampling resolution.

The server used 8,790 ms CPU in that 60-second window, about 14.6% of one core.
Periodic source-signature inventories still scale with history and account for
much of that cost, even though they are shared across clients. This is a remaining
optimization for the final migration/performance slice, not evidence of a completed
whole-runtime CPU optimization. The figures are diagnostics, not fixed CI throughput
promises. Guardian-enforced process exit and the complete migrated supervision and
delivery matrix remain outstanding for #751; this read-only setup does not prove
task execution authority or guardian resource budgets.
