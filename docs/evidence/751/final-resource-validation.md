# Final resource validation

Both measurements ran sequentially from an isolated checkout with fresh `npm ci --registry=https://registry.npmjs.org` dependencies on macOS (Apple M3 Max). Each report records a clean source tree. The driver used Node 24.21.0; the full managed-runtime run used pinned Node 24.14.1 for managed processes.

## Full mixed runtime

Source: `f49a07318b11f35ee7e2c4b0681171501004bde3`. Raw report: `full-runtime-final-f49a0731-macos.json`.

From `packages/pi-better-server`:

```sh
PI_TEST_PRIVATE_RUNTIME_NODE=/tmp/pi-751-node/node-v24.14.1-darwin-arm64/bin/node PI_FULL_RUNTIME_REPORT=/tmp/pi-751-final-full-f49a0731.json node --import tsx scripts/measure-full-runtime.mjs
```

All 1/5/10 ordinary-client scenarios passed alongside two real RemoteClientSession adapters, active hosted Background work, local managed Subagent and Background work. This is loopback Unix remote-adapter coverage, not cross-machine SSH. Exact native terminal delivery reached only the originating remote recipient. The aggregate includes the adapter/measurement process, guardian, server, ordinary clients, managed worker, and actual Background runners/commands.

Every window retained two coordinator connections and one derived index. Unchanged Background reconciliation/scope-refresh deltas, full-directory reads, index-directory reads, and terminal metadata reads were zero. In the 60-second 10-client window, aggregate CPU was 5,263 ms, RSS was 3.52 GB, RPC p95 was 0.55 ms, and p99 was 3.34 ms. These totals include instrumentation overhead.

## Shared archive reads and event publication

Source: `28ab0add38421ffd6a18cfd09f137239e4148adb`: the same runtime source plus the committed publication probe and Git-free provenance harness fixes. Raw report: `shared-read-final-28ab0add-macos.json`. Its deterministic source manifest is recorded alongside the Git identity.

From `packages/pi-better-server`:

```sh
PI_SHARED_READ_REPORT=/tmp/pi-751-final-shared.json node --import tsx scripts/measure-shared-reads.mjs
```

All six 1/5/10-client scenarios with 4,416 and 10,000 historical records passed. Every unchanged window had zero metadata reads and zero projections; actual provider archive-read and per-marker-stat deltas stayed zero. This harness measures the standalone shared-read slice, not the full guardian/mutation process aggregate above.

Each scenario then measured five external atomic metadata commits through matching pushed events on 1/5/10 real Unix subscriptions. All 160 recipient observations met the healthy one-second budget; maximum visibility latency was 102.84 ms. The 10,000-history/10-client scenario measured publication p99 102.61 ms, RPC p99 4.42 ms, aggregate CPU 10,445 ms, and RSS 1.75 GB during its 60-second unchanged window. Publication probes run after that window, preserving the zero-work assertion.

## Copied-source compatibility

The real mixed-runtime smoke passed with the isolated checkout's Git metadata temporarily absent (13.5 seconds). Reports now use null Git identity and a deterministic content manifest for copied sources, rather than failing or inventing a commit. The provenance regression also verifies repeatability and sensitivity to source changes.
