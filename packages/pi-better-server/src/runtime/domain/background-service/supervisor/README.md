# Detached local supervisor

Slice 2 of [ADR 0020](../../../../docs/adr/0020-observed-waits-retain-an-owner.md) and the
[observed-waits design](../../../../docs/plans/observed-waits-design.md): local process and command-watch
supervision that survives the process that launched it. Nothing in this directory is wired into the
Background Tasks tools yet; the parent owns that integration.

## Contract

| Function | Meaning |
| --- | --- |
| `createLocalSupervisor({ directory })` | Caller-side adapter. The directory is configurable and may be any writable path. |
| `.start(options)` | Validate, persist the launch record, spawn the runner in its own process group, and report the durable claim. |
| `.inspect(taskId, options?)` | Reconcile from records. Never launches, never retries. |
| `.stop(taskId, options?)` | Write a durable stop request, wait for runner evidence, then escalate to a verified process group. |

`options.token` is the execution identity: the task id is derived from it (`bgs_<sha256 prefix>`), so a
second `start` with the same token reports the existing execution and a different request under the
same token is refused. A runner claims the token with an exclusive file create before executing, so
even two racing runners cannot execute the same command twice.

Statuses: `starting`, `running`, `succeeded`, `failed`, `timed_out`, `cancelled`, `lost`. `starting`
and `running` are observations; the others come from a durable terminal record. `lost` means no
terminal evidence exists and none can now appear — it is never reinterpreted as success.

## Durable records (`<directory>/tasks/<taskId>/`)

| File | Writer | Purpose |
| --- | --- | --- |
| `launch.json` | caller, once | immutable argv/cwd/limits/conditions; never contains environment values |
| `claim.json` | runner, exclusive | proves the token was claimed before execution |
| `command.json` | runner | identity of the live command or watch check |
| `stop.json` | caller | durable stop request, readable from any process |
| `result.json` | runner (or stop escalation) | terminal status, exit code, bounded evidence, log paths |
| `lost.json` | any inspector | no terminal evidence exists |
| `stdout.log`, `stderr.log` | runner | per-stream output, capped per stream |
| `events.log` | runner | lifecycle lines (claim, checks, stop, terminal) plus inherited runner stderr |

Terminal records are written exclusively: the first terminal record wins, so a late writer cannot turn
evidence into a different outcome.

## Boundaries

- **Admission is the caller's.** Pass an argv that was already admitted and, if applicable, already
  confined by the sandbox wrapper. The supervisor executes it verbatim and adds no permission.
- **Environment values are not persisted.** `env` is merged into the runner's own environment only;
  records say `"environment": "inherited"`.
- **No relaunch of ambiguous execution.** A launch without a claim is reported (`starting`, then
  `lost`), never retried. A runner that disappears without a terminal record is `lost`.
- **Identity gates every signal.** The caller signals a process only when the recorded start token
  verifies against the live pid. `created but no token` means `unknown`, and an unknown identity is
  refused rather than signalled. The runner signals the direct child through the `ChildProcess`
  handle it still owns, and rechecks the recorded token before the delayed escalation.
- **A group signal requires a live, owned leader.** The pgid is only addressable evidence that *a*
  group exists; after the leader exits, a recycled id is indistinguishable from the original. The
  runner therefore signals the group only while the leader it spawned is still alive on its
  retained handle and its recorded start token agrees — the leader is then a live member, which is
  what proves the group. Once it exits, the runner sends no further group signal: the direct child
  was already killed through the handle, the cleanup is reported `groupCleanup: "unproven"`, and
  surviving members are left to their owner. The same rule governs the caller's external cleanup:
  every group signal re-verifies the leader, and a dead leader refuses the escalation.
- **`empty` is never claimed when cleanup is unproven.** `groupCleanup: "empty"` means a group
  signal was sent while the leader was owned *and* the group was then observed empty. If identity
  was lost first, the terminal says `unproven` even if the group later disappears on its own.
- **Stopping a task with a surviving command never rewrites the verdict.** If a recorded command
  survives its runner — a `lost` task, or a terminal whose `groupCleanup` is `unproven` — an explicit
  `stop` kills it only with a verified identity, writes `cleanup.json`, and leaves the recorded
  verdict intact. Unknown identity is refused with an explicit reason. When the recorded leader is
  already gone but its group still has members, those members cannot be proven and the stop refuses
  them; cleanup of such a group stays an operator action.
- **Local only.** No SSH or remote adapter, no coordinator database, no dependency waits, no model
  continuation. Stopping a task is a caller action and does not imply assignment success.
- **Watch conditions are the production ones.** `successWhen`/`failureWhen` are validated with
  `validateCondition` and evaluated with `evaluateCondition`; failure wins over success, and a
  condition evaluation error (`json_path_*`) keeps the watch running, as in `pollWatch`.

## Shipped runner artifact

The executable is the emitted JavaScript closure under `generated/`, never the
TypeScript source: Node refuses type stripping under `node_modules`
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). `runner.ts` is the source; run

```
node src/supervisor/emit-runner.mjs
```

to regenerate `generated/*.mjs` after changing the runner or its runtime
dependencies. The closure covers `runner`, `store`, `types`, `identity`,
`conditions`, `process` and `process-identity`, imports only `node:` builtins,
and is checked in so the package works without a build step.
`supervisor.codegen.test.ts` regenerates it and fails on drift.

**Packaging (parent-owned):** the package `files` list carries
`src/supervisor/**/*.mjs` so the closure ships; `npm pack --dry-run` includes
`src/supervisor/generated/*.mjs`. The installed-path test copies this tree into a
temp `node_modules` and runs it there.

The runner is spawned detached with `stdio` pointed at `events.log`, so a crash
before the claim is still diagnosable. Output capture mirrors `runCommandOnce`
(per-command timeout, SIGTERM then SIGKILL to the process group after 2s,
UTF-8-safe truncation), except that the child handle is retained so a stop can
end an in-flight check, and group cleanup is driven to a proven empty state
before the terminal record is published.

Tests: `supervisor.test.ts` drives real subprocesses for parent-exit survival, duplicate-token
single execution, stop, timeout, watch cadence/conditions, environment secrecy, lost evidence,
installed-path execution, emitted-closure drift, atomic record publication, TERM-resistant
descendant cleanup, delayed-late-claim fencing, orphan cleanup with verified/unknown identity,
a live fence holder that pauses past the old stale window, proven-dead and unreadable fence owners,
a suspended runner that must report cleanup unproven instead of signalling a pgid it can no
longer prove, plus the proof that a recorded command with an unverifiable identity is left alone.
