# Offline Startup Benchmark Scratch Study

Discussion-only evidence, not a production change or an architecture recommendation. All created files are in this directory. No commits, installs, provider prompts, paid-model requests, or agent tool executions were performed. Product policy and any runtime architecture decision remain with Product Manager and Architect; independent critique remains with Reviewer.

## Recorded Result

Final run: **2026-10-08T17:07:15.051Z**. Seven measured samples per arm, sequential cold launches with rotating arm order, followed by one warm SDK process. The final run did not run alongside the focused tests.

| Arm / Timing Boundary | n | Median (ms) | Min-Max (ms) |
| --- | ---: | ---: | ---: |
| Cold Node CLI RPC: parent before spawn -> successful `get_state` receipt | 7 | 478.38 | 466.41-499.60 |
| Cold Node SDK: parent before spawn -> SDK session-ready marker receipt | 7 | 467.29 | 459.91-472.99 |
| Cold SDK internal: import + fresh services + create + bind | 7 | 390.13 | 381.26-395.58 |
| Cold SDK import alone | 7 | 364.14 | 356.62-368.41 |
| Fresh SDK session in warm process: fresh services + create + bind | 7 | 6.66 | 5.94-7.61 |
| Current task-runtime guard bootstrap: parent before spawn -> successful `get_state` receipt | 7 | 813.25 | 803.50-826.17 |

The cold SDK and CLI readiness distributions are close in this small local sample. The median difference is 11.09 ms; this study does not establish a meaningful production advantage for either cold path. The SDK internal breakdown shows that import is a large part of its cold measurement.

The warm process imported the SDK once (365.61 ms), then performed a recorded first creation (23.26 ms) that is excluded from the seven warm samples. The 6.66 ms warm median measures NEW sessions with fresh runtime state, not reuse of a conversation. It excludes process startup and imports, so it is not an apples-to-apples end-to-end speedup over cold CLI RPC.

Guard-bootstrap RPC readiness was higher than the stripped CLI arm here. This is an aggregate observation, not an attribution of the difference to Jiti, sandboxing, a particular guard hook, or any other individual component.

Raw full-precision timing samples, responses, diagnostics, per-child commands/environments, source hashes, and verification are in [results.json](results.json). The table is rounded for readability.

## Repeat Exactly

Use the existing install and the same runtime. No dependency installation is needed. Run the test command and benchmark command separately, in order:

```sh
cd /Users/exoulster/projects/pi-better-harness
/opt/homebrew/Cellar/node@24/24.14.1_1/bin/node --test docs/research/subagent-startup-scratch/benchmark.test.mjs
/opt/homebrew/Cellar/node@24/24.14.1_1/bin/node docs/research/subagent-startup-scratch/benchmark.mjs 7
```

The benchmark overwrites only its scratch `results.json`, creates `.run-*` private fixtures under this directory, and removes those fixtures in `finally`. The tests likewise create and remove `.test-*` fixtures here. Earlier exploratory attempts stopped on scratch-runner assertions; those temporary fixtures and processes were cleaned. Only the final successful run is represented by `results.json`.

Files:

- [benchmark.mjs](benchmark.mjs): fixture ownership, LF-framed process transport, timing, statistics, guard arm, artifact generation, and outside-scratch checks.
- [sdk-worker.mjs](sdk-worker.mjs): cold import or sequential fresh warm sessions with state/identity checks.
- [offline.cjs](offline.cjs): network-denial preload and shutdown audit.
- [benchmark.test.mjs](benchmark.test.mjs): focused behavioral tests for the runner.

## Runtime And Environment

Node **v24.14.1**, executable `/opt/homebrew/Cellar/node@24/24.14.1_1/bin/node`; macOS Darwin **24.6.0**, **arm64**, **Apple M3 Max**, 16 reported CPUs. Every measured child used this same Node executable. Full `process.versions` is recorded in JSON.

SDK **1.0.4**, from this exact installed directory:

```text
/Users/exoulster/node_modules/.pnpm/@earendil-works+pi-coding-agent@1.0.4_@aws-sdk+credential-provider-node@3.972.84_@smith_28d7cad98b67b749f8571d22c620bc56/node_modules/@earendil-works/pi-coding-agent
```

The measured CLI is that directory's **unbundled `dist/cli.js` invoked with Node**, not the global command. The global `/Users/exoulster/.bun/bin/pi` resolves to that install's `dist/bundle/cli.js`; it was inspected as a path but **not executed or timed**. This study makes no Node-versus-Bun or bundled-versus-unbundled claim.

Each child receives a newly constructed environment, not a copy of the user's environment. Exact values for every sample are in `results.json`. Fixed values are `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0`, `PI_PACKAGE_DIR=<exact SDK directory>`, `LANG=C`, `LC_ALL=C`, `TZ=UTC`, `NO_COLOR=1`, `TERM=dumb`, and `PATH=<same Node directory>:/usr/bin:/bin`.

`HOME`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `TMPDIR`, `TMP`, `TEMP`, and `PI_CODING_AGENT_DIR` all point under each owned scratch fixture. Its private agent directory starts with `auth.json` and `settings.json` containing `{}`. No provider API-key, OAuth, proxy, `NODE_OPTIONS`, personal settings, personal resource, or session environment is inherited. [Configuration][configuration] and [environment variables][environment] document these controls; context loading is disabled explicitly because it otherwise walks ancestors without requiring trust.

The preload is passed as `--require <scratch>/offline.cjs` on every measured child. It throws before Node fetch, HTTP(S), socket-connect, TLS, UDP-send, and common DNS calls, then audits attempts at exit. All 22 benchmark children reported **zero network attempts**. This is an additional Node-level tripwire, not a claim of whole-process kernel network confinement.

## Readiness And Semantic Boundaries

**CLI:** stdin is kept open while one `{"type":"get_state","id":"startup"}` command is queued. The timer ends only when the matching successful response arrives. Then stdin is closed and the child is awaited through exit. This is real [RPC state readiness][rpc-commands], not `node --help`, CLI help, version printing, or process spawn alone. The [RPC protocol][rpc] specifies LF framing, IDs, and stdin-EOF shutdown.

The CLI arguments are:

```text
--mode rpc --offline --no-session --no-extensions --no-skills
--no-prompt-templates --no-themes --no-context-files --no-approve
```

**SDK:** the worker dynamically imports `dist/index.js`, creates fresh file-backed `SettingsManager` with untrusted project settings, fresh file-backed `ModelRuntime` (private auth/models/model-store paths, network disabled), and fresh `DefaultResourceLoader` with the equivalent disabled resource flags. It reloads resources, performs the additional offline model refresh used by CLI services, creates a fresh in-memory `SessionManager`, calls `createAgentSession()`, and awaits `bindExtensions({})`. Its marker is written immediately afterward, before validation/disposal. Internal timers separately record import, runtime creation, resources/refresh, and session creation/binding. These APIs and lifecycle semantics are described in the [SDK documentation][sdk] and checked examples.

**Warm:** one process keeps its cwd and environment fixed throughout. After disposing/flushing the previous session, the private agent directory's disk contents are reset outside the next sample's timer. Every sample constructs new settings, credentials, ModelRuntime/model collection, resource loader, session manager, agent/session, and tool objects; WeakSet checks reject object reuse. Session IDs must also be distinct. No `runtime.newSession()` that retains shared services, singleton auth reuse, shared ModelRuntime, imported conversation, or concurrent session construction is used. Imported modules and their implementation-level caches remain warm by design.

**Default built-ins:** the CLI defaults to `read`, `bash`, `edit`, `write`; the SDK explicitly selects that same set. CLI built-in extensions normally include MCP, llama.cpp, codemode, and tool search, whereas SDK sessions do not load the same CLI extension set automatically. `--no-extensions` disables the CLI built-ins in this study, and no SDK factories add them. See [CLI tools/resources][cli], [settings][settings], and [SDK built-in extension semantics][sdk]. Consequently this is not a measurement of either default fully configured application.

**No usable model:** SDK 1.0.4's agent exposes an `unknown/unknown` model sentinel when nothing is configured, rather than always omitting `model`. Raw RPC responses retain it. SDK checks verify empty stored credentials, zero available models, and no model-runtime error. Both paths have zero conversation messages, no persistent session file, and no active streaming. Readiness here does **not** mean ready to successfully prompt a provider. The sentinel is grounded in the installed [agent-core implementation][agent-core].

**Guard arm:** the existing [task-runtime.mjs](../../../packages/pi-better-subagents/task-runtime.mjs) is invoked with the same Node and SDK, a scratch policy path, the CLI flags above, and `--no-builtin-tools`. The policy mirrors the private fixture shape in [task_runtime.test.mjs](../../../packages/pi-better-subagents/tests/task_runtime.test.mjs): project Read/write, outside Read, stored credentials Off, commands/network Off, process access Off, and `read/write/edit/bash` requested. The fixture and policy are prepared under scratch instead of calling `prepareTaskRuntime`, which performs additional parent setup and owns other runtime directories. That parent setup is not measured.

The launcher imports the current guard through Jiti with its filesystem cache disabled, then calls installed `main()`. A `task_sandbox_ready` marker confirms the selected guarded tools, followed by successful `get_state`; the CLI's stdout routing places this diagnostic marker on stderr in this install. The runner records its arrival/channel separately, never uses stderr as RPC response data. The guard also activates the disposition tool alongside the selected guarded tools, so this arm is not tool-identical to the stripped baseline CLI arm; see [task-guard.ts](../../../packages/pi-better-subagents/task-guard.ts).

**Kernel sandbox included: NO.** Guard bootstrap checks backend support and installs guarded adapters, but no task tool or kernel-confined file/shell worker is executed. The trusted Pi runtime itself is not whole-child sandboxed. [ADR 0007](../../adr/0007-trusted-runtime-task-boundary.md) defines this distinction. This study did not diagnose or change sandbox configuration; it ran under the already supplied default repository write confinement.

**Excluded latency:** fixture/policy setup, warm disk reset, provider credential acquisition/refresh, first provider request and response, model inference, tools, kernel task-worker launches, production parent orchestration and workspace provisioning, user resources, persisted conversations, and interactive UI. Offline local model-catalog/auth inspection is included; live catalog refresh is excluded. Cold timings include Node startup, applicable imports/initialization, and readiness pipe transport; warm timing does not. Verification, disposal, and process exit are outside readiness timing, although separately recorded `exitWallMs` includes them.

These are **not measured production subagent latencies**. Processes are cold, filesystem caches are not flushed, scheduler/load/power conditions are uncontrolled, and seven samples do not support broad performance conclusions or product/architecture decisions.

## Verification Record

- Focused runner suite: **6 passed, 0 failed, 0 skipped** on the final scripts. Tests exercise independently known medians/ranges, matching IDs and chunked JSONL, successful exit without readiness, rejected readiness, bounded timeout kill/reap, and an intentionally blocked fetch attempt with no live connection.
- Final benchmark: **22 children**, all closed; **7 samples per arm**, plus the recorded/discarded first warm creation. Real SDK state and object-identity assertions passed for every SDK session.
- All measured RPC `get_state` responses succeeded, with zero conversation messages, no streaming, and no persisted session file. All private auth files stayed `{}`. Guard markers reported exactly the four requested guarded tools.
- All benchmark network shutdown audits had zero attempts. No prompt or agent tool execution was sent. The existing production test file was read, not executed, because its full suite includes tool executions and synthetic Keychain operations outside this study.
- The benchmark compared **5,876 Git-listed paths** outside scratch before/after, including file contents/modes, and verified unchanged Git HEAD, index checksum, and status excluding scratch. Before/after content digest: `9480deaf3d3033bdec9e11c1d559aca164822a91cd64d57754b59330fc49531c`. Existing unrelated untracked files were preserved. Ignored files and contents of Git-listed nested repositories/gitlinks are not covered by that fingerprint.
- `.run-*` and `.test-*` fixtures were removed and owned children reaped. A final owned-PID check found no live benchmark PIDs; all saved script/runtime source hashes matched. Only README, scripts, and results remain here. No git mutations or production edits were requested or made.
- After the final benchmark fingerprint, a read-only `git status` also listed the unrelated untracked `docs/research/subagent-process-vs-sdk.md`, which was absent from the initial status. This study did not create, read, or modify it. The benchmark's before/after checks cover its execution window, not later concurrent changes by other work.

## Sources Read

Official installed documents read completely: package README; `docs/sdk.md`, `cli.md`, `cli-integration.md`, `rpc.md`, `rpc-commands.md`, `configuration.md`, `environment-variables.md`, `settings.md`, `security.md`, and `containerization.md`. Relevant links were followed for CLI/SDK boundaries, state readiness, storage/discovery, project trust, and isolation limits.

Official examples read completely: `examples/sdk/README.md`, `01-minimal.ts`, `05-tools.ts`, `06-extensions.ts`, `09-api-keys-and-oauth.ts`, `10-settings.ts`, `11-sessions.ts`, `12-full-control.ts`, `13-session-runtime.ts`, `14-codemode-mcp.ts`, and `examples/rpc-client.ts`. Examples were read, not run, since several prompt providers or assume ordinary user configuration.

Installed implementation inspected: full `dist/core/sdk.js`, `model-runtime.js`, `agent-session-services.js`, and `model-resolver.js`; relevant `main.js`, `resource-loader.js`/declarations, RPC state handler, and agent-core default-state ranges. Repository sources read completely: subagent CONTEXT, ADR 0007, `task-runtime.mjs`, `task-policy.ts`, `task-guard.ts`, and `tests/task_runtime.test.mjs`. Measured source hashes are retained in JSON.

[sdk]: /Users/exoulster/node_modules/.pnpm/@earendil-works+pi-coding-agent@1.0.4_@aws-sdk+credential-provider-node@3.972.84_@smith_28d7cad98b67b749f8571d22c620bc56/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md
[cli]: /Users/exoulster/node_modules/.pnpm/@earendil-works+pi-coding-agent@1.0.4_@aws-sdk+credential-provider-node@3.972.84_@smith_28d7cad98b67b749f8571d22c620bc56/node_modules/@earendil-works/pi-coding-agent/docs/cli.md
[rpc]: /Users/exoulster/node_modules/.pnpm/@earendil-works+pi-coding-agent@1.0.4_@aws-sdk+credential-provider-node@3.972.84_@smith_28d7cad98b67b749f8571d22c620bc56/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md
[rpc-commands]: /Users/exoulster/node_modules/.pnpm/@earendil-works+pi-coding-agent@1.0.4_@aws-sdk+credential-provider-node@3.972.84_@smith_28d7cad98b67b749f8571d22c620bc56/node_modules/@earendil-works/pi-coding-agent/docs/rpc-commands.md:155
[configuration]: /Users/exoulster/node_modules/.pnpm/@earendil-works+pi-coding-agent@1.0.4_@aws-sdk+credential-provider-node@3.972.84_@smith_28d7cad98b67b749f8571d22c620bc56/node_modules/@earendil-works/pi-coding-agent/docs/configuration.md
[environment]: /Users/exoulster/node_modules/.pnpm/@earendil-works+pi-coding-agent@1.0.4_@aws-sdk+credential-provider-node@3.972.84_@smith_28d7cad98b67b749f8571d22c620bc56/node_modules/@earendil-works/pi-coding-agent/docs/environment-variables.md
[settings]: /Users/exoulster/node_modules/.pnpm/@earendil-works+pi-coding-agent@1.0.4_@aws-sdk+credential-provider-node@3.972.84_@smith_28d7cad98b67b749f8571d22c620bc56/node_modules/@earendil-works/pi-coding-agent/docs/settings.md
[agent-core]: /Users/exoulster/node_modules/.pnpm/@earendil-works+pi-agent-core@1.0.4_@aws-sdk+credential-provider-node@3.972.84_@smithy+_3573e5a06d309d275e17b2937ed826c8/node_modules/@earendil-works/pi-agent-core/dist/agent.js:18
