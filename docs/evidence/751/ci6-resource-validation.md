# CI6 supported-platform resource qualification

**Both resource lanes passed on `68b9cc8cb43ad0c3098549646ec9fb9b2a7065e6`. The aggregate CI run is not green:** separate watcher-fixture and observer-teardown corrections still require qualification. See the [current acceptance matrix](status-index.md) for epic status.

[CI run 43763570151](https://github.com/1aboveio/pi-better-harness/actions/runs/43763570151) includes successful [Linux](https://github.com/1aboveio/pi-better-harness/actions/runs/43763570151/job/132963538828) and [macOS](https://github.com/1aboveio/pi-better-harness/actions/runs/43763570151/job/132963538460) resource jobs. Each passed full-runtime measurements, packed standalone qualification, cached offline restart, actual socket recipient backpressure recovery, and shared-read measurements.

## Recorded budgets

| Evidence | Linux | macOS |
| --- | --- | --- |
| Full-runtime scenarios | 1/5/10 native clients plus two real remote adapters | Same |
| Coordinator / derived connections, every full window | 2 / 1 | 2 / 1 |
| Unchanged Background scope refresh/reconcile | 0 / 0 | 0 / 0 |
| Shared scenarios | 4,416/10,000 records × 1/5/10 clients | Same |
| Unchanged shared metadata reads / projections | 0 / 0, all six windows | 0 / 0, all six windows |
| Publication observations within unchanged <=1,000 ms budget | 160/160 | 160/160 |
| Maximum committed-change-to-subscription latency | 245.73 ms | 376.08 ms |
| Full ten-client RPC p95 / p99 | 0.90 / 18.26 ms | 8.84 / 22.44 ms |
| Full ten-client aggregate CPU / RSS | 6,550 ms / 4.38 GB | 17,177 ms / 3.46 GB |
| Shared 10,000/10-client RPC p95 / p99 | 3.23 / 4.64 ms | 7.91 / 14.93 ms |
| Shared 10,000/10-client aggregate CPU / RSS | 25,009 ms / 2.21 GB | 23,191 ms / 2.37 GB |

Both ten-client sustained measurement windows lasted at least 60 seconds. Actual provider archive reads and per-record marker-stat deltas stayed zero. Full-window legacy full/index directory reads and terminal metadata reads stayed zero; active-process supervision reads remain visible in the reports. The archive-scale query worker reported four directory watchers after 10,000-history/10-client measurement, rather than per-history-file or per-client watchers.

The publication probe measures external atomic metadata commits through matching pushed Unix subscription events, without snapshot polling. CI5 Linux failed this unchanged one-second gate after repeated replacements lost file-inode notifications. CI6 qualifies the directory-entry watcher correction on Linux as well as macOS; the fallback inventory interval was not shortened. Separate regression coverage uses a 60-second fallback and exercises repeated file, child-directory and whole-root replacement.

Full-runtime exact native terminal receipts reached only the originating remote recipient on both platforms. Remote coverage uses real RemoteClientSession adapters and HostedSessions over loopback Unix transport; it is not cross-machine SSH performance. Full CPU/RSS includes the actual guardian, server, worker, runners/commands, ordinary clients and adapter/measurement process. Shared-read CPU/RSS covers its narrower standalone read slice. Instrumentation overhead is included; machine details are retained.

## Provenance and retained artifacts

The [compact machine-readable summary](ci6-resources/summary.json) retains every scenario's timing/counter results, source manifests, machine details, job links and SHA-256 checksums of the original JSON bytes. Four original reports are stored losslessly as `ci6-resources/{linux,macos}-{full-runtime,shared-read}.json.gz`; inspect with `gzip -dc <file>`. This preserves final-platform evidence without duplicating earlier large historical JSON reports.

All reports identify the exact CI source above and include deterministic content manifests. Their dirty fields retain `cli.ts` and `remote-cli.ts` modifications from installation; these are not described as clean-checkout measurements. Per-platform content digests are preserved as recorded rather than normalized. No result or source field was rewritten in the compressed reports.

The CI commands, from repository root, are:

```sh
PI_FULL_RUNTIME_REPORT="$RUNNER_TEMP/full-runtime-resources.json" node --import tsx packages/pi-better-server/scripts/measure-full-runtime.mjs
PI_SHARED_READ_REPORT="$RUNNER_TEMP/shared-read-resources.json" node packages/pi-better-server/scripts/measure-shared-reads.mjs
```

The workflow exports its provisioned private Node through `PI_TEST_PRIVATE_RUNTIME_NODE`. Complete commands for package/offline and backpressure qualification remain in the linked job logs.
