# Pi Subagents: Process Versus SDK

Date: 2026-10-08. Status: source review and offline benchmark complete; no runner migration implemented.

## Question

The current process-based runner works, but starting a subagent feels slow. Would embedding Pi through the SDK improve startup without losing isolation, durability, or extension compatibility?

Separate these intervals before deciding:

1. Admission to spawn-tool return: catalog/model selection, workspace preparation, policy preparation, process creation, identity capture, and registry writes.
2. Process creation to ready session: imports, guard compilation, settings/auth/model services, resources, extensions, and lifecycle binding.
3. Ready session to provider response: credential refresh, connection/request time, provider queueing, and first streamed response.
4. Provider response to useful output: reasoning, tool selection, and the first task operation.

An SDK factory primarily changes interval 2. A faster factory does not establish that interval 2 explains the reported delay.

## Current Implementation

The parent assembles `-p --mode json` arguments with explicit model, effort, tool, extension, and session choices. Launch policy and optional workspace cloning happen before process creation. The child is detached, unreferenced, and writes stdout/stderr directly to a file; the parent is not in the log byte path.

For confined tasks, the native entry point imports the complete task guard through Jiti before calling the installed SDK's `main()`. Thus the existing design already uses SDK code, but uses its CLI entry point in a separate process. Jiti's disk and module caches are disabled for this guard load. That is a candidate cost to measure, not a proven bottleneck.

`startedAt` is recorded after spawn and process-identity capture, not at admission or readiness. The guard emits a typed `task_sandbox_ready` event after its `session_start` handler installs and verifies the selected tools; the event currently has no explicit timing field.

Sources: [launch path](../../packages/pi-better-subagents/index.ts), [detached spawn](../../packages/pi-better-subagents/spawn.ts), [native bootstrap](../../packages/pi-better-subagents/task-runtime.mjs), [guard readiness](../../packages/pi-better-subagents/task-guard.ts).

### Actual Security Boundary

[ADR 0007](../adr/0007-trusted-runtime-task-boundary.md) supersedes the earlier whole-child startup boundary. Pi is trusted for authentication, provider transport, configuration, and persistence. Task bash commands and fixed file-operation workers are kernel-confined; other task tools require verified adapters or explicit human trust. The child Pi runtime itself is not sandboxed by this policy.

Consequently, a separate process is a crash/state/lifecycle boundary, not automatically a complete security sandbox. An SDK alternative must preserve guarded task execution and the immutable launch policy. Merely passing a different `cwd`, disabling ambient extensions, or using `SessionManager.inMemory()` does not replace those protections.

Sources: [ADR 0007](../adr/0007-trusted-runtime-task-boundary.md), [ADR 0009](../adr/0009-guarded-and-trusted-subagent-tools.md).

## Four Designs

| Design | Startup opportunity | Isolation and durability | Additional work |
| --- | --- | --- | --- |
| Current detached JSON process | Optimize repeated bootstrap while retaining one fresh process per run | Separate process per run; direct file-backed output survives loss of the foreground; existing PID/process-group supervision | Lowest change risk; retain current behavior |
| Warm Pi RPC process | Retain process/imports; use maintained commands to create or switch sessions | Separate process, but tasks sharing a worker share failure and module state; standard pipe/EOF shutdown is not equivalent to today's detached durable runner | Worker ownership, compatible policy/workspace grouping, log demultiplexing, durable control, reset and recovery |
| SDK inside foreground Pi | Retain imports and selectively reuse services; direct typed events | Shares foreground lifetime, memory, event loop, module state, and process authority | Session-specific services, guarded tools, lifecycle/event routing, and explicit concurrency/reset verification |
| Warm detached SDK worker | Retain imports while constructing fresh run sessions outside foreground | Foreground remains separate; one active task per worker limits blast radius, but reuse still retains module state | Custom worker protocol, admission, per-run policy/guards, logs, cleanup, recycling, and recovery |

Warm reuse is not an SDK-exclusive feature: RPC is explicitly long-lived. A fair comparison includes warm RPC as well as warm SDK, rather than comparing only cold CLI startup with a preloaded SDK.

## SDK Contract Findings

Evidence is pinned to the locally installed official Pi SDK **1.0.4**. The repository development SDK is **0.82.1**. A production runtime comparison must use the same version and interpreter; a version change is not an architectural speedup.

- A default `createAgentSession()` constructs model, settings, session, and resource services. Resources still need loading. Supplying services can reduce repeated setup, but also transfers ownership and freshness obligations to the host.
- `cwd` is passed to services; the factory does not change the process working directory. Arbitrary extensions using `process.cwd()` or `process.env` remain process-global. Our task guard currently uses `process.cwd()` during installation, so multi-workspace embedding is not a drop-in change.
- Normal model runtime providers and credentials are instance-scoped. Sharing a runtime shares its mutable state. Compatibility provider APIs, extension module caches, and some auth-file read state introduce separate process-level sharing concerns.
- SDK defaults do not load the CLI's codemode, tool-search, and MCP factories. Extension parity requires intentional loading and lifecycle binding, not only a matching tool-name list.
- One `AgentSession` is one conversation. Prompts while streaming require explicit steering or follow-up behavior. RPC request IDs correlate command responses, not independent conversation streams.
- Subscribe before prompting. `agent_settled`, rather than `agent_end`, is the automatic-work completion boundary. Settlement does not itself mean success, durable replay, or termination of extension-owned background activity.
- SDK `abort()` waits for idle. `session.dispose()` is synchronous and requests cancellation; it is not an awaited graceful-shutdown barrier. Runtime lifecycle replacement handles additional shutdown work.
- RPC stdin EOF requests orderly disposal. The installed `RpcClient.stop()` instead uses SIGTERM with a SIGKILL fallback. A normal parent-owned pipe therefore needs redesign if work must continue after foreground exit.
- Persistent session JSONL is not the JSON/RPC event stream. Progress/delta events need separate durable recording if the runner depends on replay.

Primary-source entry points: the installed official [SDK documentation](/Users/exoulster/node_modules/.pnpm/@earendil-works+pi-coding-agent@1.0.4_@aws-sdk+credential-provider-node@3.972.84_@smith_28d7cad98b67b749f8571d22c620bc56/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md), [CLI integration documentation](/Users/exoulster/node_modules/.pnpm/@earendil-works+pi-coding-agent@1.0.4_@aws-sdk+credential-provider-node@3.972.84_@smith_28d7cad98b67b749f8571d22c620bc56/node_modules/@earendil-works/pi-coding-agent/docs/cli-integration.md), [SDK factory](/Users/exoulster/node_modules/.pnpm/@earendil-works+pi-coding-agent@1.0.4_@aws-sdk+credential-provider-node@3.972.84_@smith_28d7cad98b67b749f8571d22c620bc56/node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js:69), [extension loader](/Users/exoulster/node_modules/.pnpm/@earendil-works+pi-coding-agent@1.0.4_@aws-sdk+credential-provider-node@3.972.84_@smith_28d7cad98b67b749f8571d22c620bc56/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js:86), and [session lifecycle](/Users/exoulster/node_modules/.pnpm/@earendil-works+pi-coding-agent@1.0.4_@aws-sdk+credential-provider-node@3.972.84_@smith_28d7cad98b67b749f8571d22c620bc56/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:988).

## Measurements

The [offline benchmark](subagent-startup-scratch/README.md) used Node v24.14.1 and installed Pi SDK 1.0.4 on an Apple M3 Max, macOS 24.6.0. Seven samples per arm were recorded; all 22 measured children exited, with zero network attempts. Parent verification reran the six benchmark-runner tests successfully. [Raw results](subagent-startup-scratch/results.json) retain full precision, commands, state responses, environment, and source hashes.

| Measurement | Median | Range | Boundary |
| --- | ---: | ---: | --- |
| Cold Node CLI RPC | 478.38 ms | 466.41-499.60 ms | Before spawn to successful `get_state` receipt |
| Cold Node SDK | 467.29 ms | 459.91-472.99 ms | Before spawn to initialized/bound session marker |
| SDK cold import alone | 364.14 ms | 356.62-368.41 ms | Inside child: dynamic SDK import |
| Fresh session in warm SDK process | 6.66 ms | 5.94-7.61 ms | Fresh service objects, resources, tools, history, and lifecycle binding; imports already loaded |
| Current guard bootstrap | 813.25 ms | 803.50-826.17 ms | Before spawn to RPC readiness through `task-runtime.mjs` |

The cold CLI/SDK median difference was only 11.09 ms in this sample. There is no demonstrated material advantage from simply replacing a fresh CLI process with a fresh SDK process.

Warm session creation was much cheaper, but its timer excludes process startup and imports. Warm samples constructed new settings, credentials/model runtime, resource loader, session manager, agent, and tools, with unique sessions and no conversation reuse. The process retained imported modules and implementation-level caches, including potential shared auth-file read caches; fresh object identities do not establish arbitrary extension or credential isolation. The first warm creation took 23.26 ms and was recorded separately rather than included in the seven-sample warmed median.

Guard readiness was about 335 ms above the stripped CLI baseline. This is aggregate extra bootstrap work, not a measurement attributing that difference specifically to Jiti or kernel sandboxing. No task tool or kernel task worker ran.

### What This Does Not Prove

- These are offline session-readiness measurements, not production `subagent_spawn` or first-response latency. Parent admission, policy/workspace preparation, real credentials, provider requests, reasoning, and task execution are excluded.
- The tested CLI is SDK 1.0.4's unbundled `dist/cli.js` under Node. The actual global bundled CLI and other interpreters were not timed.
- Ambient extensions, skills, prompt templates, themes, and context files were disabled. The normal child loads its selected tools/providers and instruction resources. Both baseline arms used the same four default built-ins, but the guard arm also activates its disposition tool.
- Empty isolated credentials yielded an `unknown/unknown` model sentinel and zero available models. Readiness did not mean ready for a successful provider prompt. No prompt was sent.
- The trusted runtime was not whole-process sandboxed. Guard installation was measured; kernel file/shell-worker startup was not.
- Filesystem caches were not flushed, machine load was uncontrolled, and seven samples are not enough for universal latency or throughput claims.
- Warm RPC was not benchmarked. Its reuse potential is supported by the documented lifecycle, but this study establishes no warm-RPC performance number.

Repeat commands and the offline network tripwire are documented in the benchmark README. Warm session creation is evidence of a reuse opportunity, not proof of safe policy resets or a production speedup.

## Provisional Recommendation

Retain the working detached-process runner as the default while measuring the real launch stages. The offline cold results do not justify moving subagents into foreground Pi solely to avoid process startup.

If repeated imports/resource initialization are a substantial measured cost, explore a warm **separate-process** runner, comparing maintained RPC with a small SDK worker. Start with one active run per worker and fresh per-run conversations, permissions, guards, and artifact identities. Reuse of a compiled module is not permission to reuse a prior task's policy, working directory, or conversation.

Pool workers only when the SDK version, trusted extension set, provider/configuration context, workspace assumptions, and guard initialization can be made compatible. Current RPC session-reset commands do not by themselves prove that the harness's immutable guard policy has been replaced correctly.

Preserve: explicit model/effort resolution, catalog freshness, admitted tools, protected control files, file-backed durable output, cancellation, process-group health, callbacks after reload, and truthful failure states. A latency improvement is not acceptable if those contracts regress.

This is a hypothesis for a future experiment, not a decision to implement a pool. If provider or reasoning latency dominates, a warm worker may have little effect on the delay the user notices.

### Next Experiment

Record admission, process creation, the existing guard-ready event, provider-request start, first response delta (including reasoning), and first useful tool/text output on representative normal runs. Report cold/warm first-run effects and p50/p95 separately; do not time only the child's output or only the parent tool response.

Then compare the current runner with a warm RPC or SDK worker under the same SDK/interpreter, resource set, policy, real extension lifecycle, and mocked local provider transport. A pool experiment must also prove policy/workspace changes, no cross-run history, cancellation, provider/extension cleanup, durable logs after foreground loss, and callback recovery after reload. No migration should follow from the 6.66 ms stripped-session figure alone.