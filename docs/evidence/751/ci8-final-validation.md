# Final integrated validation

**CI8 passed all 18 jobs on `9acbc1a90b53695d60672e680950d7df966f5cab`. Validation is complete; PR merge and issue closure remain pending.** [Run 43766305095](https://github.com/1aboveio/pi-better-harness/actions/runs/43766305095) and the [retained job summary](ci8-jobs.json) identify the exact successful source and every lane.

This includes all three Server shards, four workspace/script shards, both Pi compatibility shards, Pi extension compatibility at 1.0.0 and 1.3.0, Linux/macOS/Node 24 sandbox lanes, Windows verification, both supported-platform resource lanes and the aggregate `ci` gate. A passing lane is not a claim that every optional test ran; skipped tests are not counted as coverage. Runtime support and performance acceptance remain macOS/Linux; Windows verification does not establish a Windows managed-runtime resource matrix.

The formerly failing unavailable-continuation fixture passed in Server shard 3. Its runtime diagnostic now uses the existing SDK-free exact-root/capability protocol without retaining runtime liveness; ordinary incompatible hosted-session SDK handshakes remain rejected. The final native observation collector correction is included in this same source and validation.

## Final platform resource evidence

Both [Linux](https://github.com/1aboveio/pi-better-harness/actions/runs/43766305095/job/132972062697) and [macOS](https://github.com/1aboveio/pi-better-harness/actions/runs/43766305095/job/132972062428) passed full-runtime measurement, packed standalone domains, cached offline restart, real socket recipient backpressure recovery and the shared-read matrix.

Every platform completed three full-runtime scenarios (1/5/10 ordinary native clients with two real remote adapters) and six shared-read scenarios (4,416/10,000 historical records × 1/5/10 clients). Ten-client full-runtime and 10,000-history shared-read measurement windows ran for at least 60 seconds.

| Gate | Linux | macOS |
| --- | --- | --- |
| Coordinator / derived connections, every full window | 2 / 1 | 2 / 1 |
| Unchanged Background scope refresh / reconciliation | 0 / 0 | 0 / 0 |
| Unchanged shared metadata reads / projections, all six windows | 0 / 0 | 0 / 0 |
| External commit → pushed subscription observations <=1 s | 160/160 | 160/160 |
| Maximum publication latency | 243.19 ms | 235.48 ms |
| Full ten-client RPC p95 / p99 | 0.69 / 15.90 ms | 7.00 / 21.97 ms |
| Full ten-client aggregate CPU / RSS | 5,713 ms / 4.36 GB | 13,095 ms / 3.37 GB |
| Shared 10,000/10-client RPC p95 / p99 | 2.82 / 4.15 ms | 6.57 / 13.23 ms |
| Shared 10,000/10-client aggregate CPU / RSS | 24,578 ms / 2.20 GB | 16,872 ms / 2.40 GB |

Actual provider archive reads and per-record marker stats stayed zero during unchanged windows. Full-window legacy full/index directory reads and terminal metadata reads stayed zero; active-process supervision reads remain visible. The archive-scale query worker retained four directory watchers rather than per-file or per-client watchers. No latency, connection, idle or resource gate was relaxed.

Exact native terminal receipts reached only the originating remote recipient on both platforms. Remote coverage uses real RemoteClientSession adapters and HostedSessions over loopback Unix transport, not cross-machine SSH performance. The full aggregate includes guardian, server, managed worker, actual runners/commands, ordinary clients and adapter/measurement process. Shared-read totals cover the narrower standalone read slice. Instrumentation overhead is included.

## Reproducibility and retained reports

The [resource summary](ci8-resources/summary.json) retains every scenario's metrics, exact source/content manifests, machine details, job links and SHA-256 hashes of the original JSON bytes. Four original final-source reports are preserved losslessly as `ci8-resources/{linux,macos}-{full-runtime,shared-read}.json.gz`; inspect with `gzip -dc <file>`. Previous reports remain historical and are not duplicated here.

All reports name the exact successful source above and preserve installation-related dirty fields for `cli.ts` and `remote-cli.ts`; these runs are not described as clean-checkout measurements. Platform content digests are retained as recorded. Compressed originals contain unmodified report bytes.

The workflow runs, from repository root:

```sh
PI_FULL_RUNTIME_REPORT="$RUNNER_TEMP/full-runtime-resources.json" node --import tsx packages/pi-better-server/scripts/measure-full-runtime.mjs
PI_SHARED_READ_REPORT="$RUNNER_TEMP/shared-read-resources.json" node packages/pi-better-server/scripts/measure-shared-reads.mjs
```

The provisioned private Node is exported through `PI_TEST_PRIVATE_RUNTIME_NODE`. Package/offline/backpressure commands and outcomes remain in the linked job logs. Current requirement status is in the [acceptance matrix](status-index.md).
