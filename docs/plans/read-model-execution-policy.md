# Read-model execution policy

Implements the read-executor portion of #782 within the #751 single-server design. This describes the current boundaries and remaining verification; it does not declare either issue complete.

## Execution boundary

The main thread handles bounded protocol parsing, connection admission, cached executor metrics, small response envelopes and diagnostic status. Snapshot queries, pagination, projection, SQLite reads, index reconciliation and snapshot JSON encoding execute in the dedicated read worker. Even a cache miss uses that worker; there is no synchronous fallback on the socket thread.

Diagnostic status returns the last observed liveness reasons with `observedAt` and an explicit observation state. The worker pushes observations with revision and fresh-liveness replies; status reads the cached observation without scheduling or awaiting worker work. These reasons may be stale. Idle admission separately awaits a fresh liveness query before deciding whether to drain. Neither a snapshot nor diagnostic status grants mutation authority.

The main-thread work target is at most 10 ms per ordinary dispatch. This is a review threshold, not a measured maximum across every operation. The real-process harness enforces a 250 ms control-status response budget while rebuilding history. Catalog file operations and canonical mutation transactions still execute on the main thread; their worst-case latency and supervision deadlines require further measurement. They are not covered by the read-worker isolation claim.

## Bounds and ordering

- The executor admits at most 64 active/queued operations and executes one at a time. Admission beyond that limit returns `runtime-overloaded`.
- Each operation has a four-second deadline. An active timeout degrades the executor and starts worker termination; it does not switch to a second reader.
- At most 64 client streams attach to an executor. The socket dispatcher separately limits each connection to 32 in-flight read queries.
- Identical snapshot requests share in-flight work keyed by the observed revision and normalized scope, including workspace, owner/session filters and pagination parameters. Subscriptions keep separate connection generations.
- The worker cache holds at most 32 entries and 16 MiB; individual cached snapshots are at most 4 MiB. Background history queries are not cached by this layer.
- Slow socket readers pause event delivery above 4 MiB and receive resync signaling when writable again. Worker event acknowledgments bound pending events and generation checks discard old-scope frames.
- Disconnect removes that client's waiters. Work shared by remaining clients continues. Metrics retain bounded arrays of 128 timing samples.

## Connection accounting

`runtime_get_metrics.sqlite` counts connections in the read worker, including the derived in-memory index. `mutationSqlite` reports the main-thread canonical coordinator connection and its service leases. Cancellation and Background result supervision share that connection per canonical root. These are distinct measurements; a read-worker-only count must not be described as total runtime connections.

The accepted normal-operation limits remain coordinator <=2 and derived index <=2, including worker connections. Hosted adapters and all execution processes must be included in final root-level verification. This policy does not approve a larger budget.

## Evidence and limits

`test/query-executor.test.ts` deliberately stalls native SQLite and checks socket responsiveness, bounded admission, deadlines, event ordering and diagnostic liveness. `test/runtime-lifecycle.test.ts` verifies fresh shutdown decisions, real process loss and bounded recovery. Native SQLite cannot necessarily be interrupted before its call returns: worker close stops waiting after one second, while the guardian owns the process shutdown budget.

The macOS measurements under `docs/evidence/751` cover 1/5/10 real Pi clients at 4,416 and 10,000 history records. Unchanged metadata reads and projections remain flat. After separating diagnostic status from fresh liveness queries, measured rebuild status latency fell from approximately 979/1562 ms to 0.27/0.26 ms. This is local evidence, not a universal latency guarantee.

The harness excludes guardian and mutation workloads. Final acceptance still needs Linux evidence on the final head, combined Pi/server/guardian/execution CPU/RSS/I/O, source-rebuild and failure cases, and measured supervision latency under concurrent mutation and slow reads.
