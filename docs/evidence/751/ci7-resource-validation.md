# CI7 final-source resource qualification

**Linux and macOS resource lanes passed on `6af7c517b05b89b7568b15c74077e42992a3bf5b`, including the final native observation collector correction.** This records resource qualification, not aggregate CI or epic closure; see the [acceptance status](status-index.md).

[CI7](https://github.com/1aboveio/pi-better-harness/actions/runs/43765129541) contains successful [Linux](https://github.com/1aboveio/pi-better-harness/actions/runs/43765129541/job/132968402509) and [macOS](https://github.com/1aboveio/pi-better-harness/actions/runs/43765129541/job/132968402855) lanes. Both passed full-runtime measurement, packed standalone domains, cached offline restart, actual socket recipient backpressure recovery and the shared-read matrix.

Each platform completed three full-runtime scenarios (1/5/10 ordinary clients alongside two real remote adapters) and six shared-read scenarios (4,416/10,000 records × 1/5/10 clients). The sustained ten-client full-runtime and 10,000-record shared-read windows ran for at least 60 seconds.

- Every full-runtime window retained **2 coordinator / 1 derived connection** and zero unchanged Background scope refresh/reconciliation.
- All shared windows retained zero metadata reads/projections, actual-provider archive reads and per-record marker-stat deltas. The final archive-scale worker retained four directory watchers, independent of client/history-file count.
- All **320 external-commit-to-pushed-subscription observations** met the unchanged <=1,000 ms budget. No snapshot polling is counted as publication.
- Exact native terminal receipts reached only the originating remote recipient on both platforms. Full-window legacy full/index directory reads and terminal metadata reads remained zero; active supervision reads remain recorded.

| Platform | Maximum publication latency, all scenarios | Full 10-client RPC p95 / p99 | Full aggregate CPU / RSS | Shared 10,000/10-client RPC p95 / p99 | Shared aggregate CPU / RSS |
| --- | --- | --- | --- | --- | --- |
| linux | 246.86 ms | 0.73 / 16.38 ms | 6,167 ms / 4.38 GB | 2.83 / 5.27 ms | 24,570 ms / 2.16 GB |
| macos | 396.93 ms | 6.34 / 17.49 ms | 12,855 ms / 3.52 GB | 7.75 / 17.01 ms | 20,831 ms / 2.41 GB |

The full aggregate includes the guardian, server, managed worker, actual runners/commands, ordinary clients and remote-adapter/measurement process. Shared-read totals cover the narrower standalone read slice. Instrumentation overhead and machine characteristics are retained. Remote adapters use loopback Unix transport and real HostedSessions; this is not cross-machine SSH performance.

## Retained evidence and provenance

The [machine-readable summary](ci7-resources/summary.json) contains every scenario, exact source/content manifests, job links, machine details and SHA-256 hashes of the original report bytes. Four original reports are preserved losslessly as `ci7-resources/{linux,macos}-{full-runtime,shared-read}.json.gz`; use `gzip -dc <file>` to inspect them. Older reports remain historical; none are duplicated in this record.

All four reports identify the source above and retain installation-related dirty fields for `cli.ts` and `remote-cli.ts`. These are not labeled clean-checkout measurements. Platform-specific content manifests are preserved as recorded; the compressed reports contain the original bytes without altered results or provenance.

Commands, from repository root, remain:

```sh
PI_FULL_RUNTIME_REPORT="$RUNNER_TEMP/full-runtime-resources.json" node --import tsx packages/pi-better-server/scripts/measure-full-runtime.mjs
PI_SHARED_READ_REPORT="$RUNNER_TEMP/shared-read-resources.json" node packages/pi-better-server/scripts/measure-shared-reads.mjs
```

The workflow exports its provisioned private Node as `PI_TEST_PRIVATE_RUNTIME_NODE`. Package/offline/backpressure commands and their successful results are retained in the linked job logs.
