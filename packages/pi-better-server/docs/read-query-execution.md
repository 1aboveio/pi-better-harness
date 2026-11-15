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
epic acceptance criterion. A test-only 100-million-row recursive SQLite query
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

These numbers are diagnostics, not fixed CI throughput promises. The remaining
#782/#751 evidence includes real Pi aggregate CPU/RSS/I/O, large rebuild latency
distributions across macOS/Linux, and guardian-enforced process exit. Socket client
processes and test-worker CPU/RSS do not establish whole-Pi resource budgets.
