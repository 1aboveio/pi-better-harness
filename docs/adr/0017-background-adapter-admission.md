# Verified Background tool admission

## Status

Implementation amendment for [#572](https://github.com/1aboveio/pi-better-harness/issues/572), following the Architect's admission recommendation. Extends [ADR 0007](0007-trusted-runtime-task-boundary.md) and the Background amendment in [ADR 0005](0005-sandbox-permission-table.md). No new permission defaults or shared task-sandbox API are introduced.

## Contract

The foreground sandbox uses the existing `installTaskTools.admitExtensionTool` hook. Background tools do not gain admission from their names or source alone.

For each call, Sandbox emits a synchronous `pi-better-background-tasks:adapter-request` with version `1`, the tool name, the input, and a reply callback. The current Background registration replies with version `1`, its exact registered parameter-schema object, and either `local-launch` or `registry`. Each `registerTools` invocation creates fresh top-level schema identities and keeps them in its own closure. Shutdown removes its capability listener.

Sandbox independently resolves trusted Background entries from its installation: the Background package's `src/index.ts` and the harness's `extensions/background-tasks/index.ts` wrapper. The actual `pi.getAllTools()` entry must have an absolute, canonical source matching one of those entries, and its `parameters` must be the exact object returned by the adapter. Sandbox checks the inventory again after the reply. Missing provenance, copied or stale schemas, another source registering the same name, missing replies, and incompatible versions do not qualify.

The event bus establishes compatibility, not authentication. Source provenance and schema identity bind admission to the owning registration, consistent with the existing shared task guard. This does not sandbox malicious installed extension code; that code already runs in trusted Pi.

## Admitted Operations

- Local launches: `bg_task_spawn`, `bg_task_watch`, and `bg_task` with the exact actions `spawn` or `watch`. Background owns executable confinement and its launch-time permission snapshot.
- Registry operations: `bg_task_list`, `bg_task_status`, `bg_task_log`, and `bg_task` or `bg_status` with the exact actions `list`, `status`, `log`, or `clear`.
- Local stop: `bg_task_stop`, or the exact action `stop` on either wrapper, only when the Background closure reads existing local process/watch metadata without SSH or remote metadata. Missing or unreadable target metadata does not receive this exemption. The existing session-ownership checks still run in the tool body.

Structured SSH launches receive no local-adapter exemption. Remote stop can execute SSH in trusted Pi, so it remains blocked while Main confinement applies, even if a caller claims the target is local or network access is enabled. Local stop and registry actions do not require command execution to be enabled.

Both foreground `tool_call` handlers use the verified classification. A verified local Background launch skips Main's commands check; the Background consumer still enforces its own profile. In particular, Main commands Off does not block a permitted confined Background launch, and Background commands Off still refuses it when Main commands are On.

When Main is Off and Background is On, the later handler still requires a compatible verified local adapter before allowing a launch. This supersedes ADR 0005's statement that old consumers may continue following Main in that combination: old consumers now fail closed until upgraded. Both columns Off preserve the existing unconfined behavior. Subagent admission and existing sandbox UI behavior are unchanged.

## Verification

Focused tests in `packages/pi-better-sandbox/test/background-admission.test.ts` drive Pi's real extension loader and `ExtensionRunner.emitToolCall`, exercising all registered tool-call handlers. They cover both extension load orders, fresh reload identities, canonical source aliases, the harness wrapper entry, spoofed/replaced registrations, absent/incompatible consumers with Main Off, explicit actions, caller attempts to label remote stop as local, and local registry operations with commands Off.

Real macOS Seatbelt checks execute standalone and wrapper spawn/watch calls with Main commands Off and Background commands On. Project markers appear; outside-write markers do not. The tests also prove Background confinement with Main Off, Background commands refusal with either Main state, and unconfined negative controls with Background Off. A running local task can still be stopped and cleared after both command switches turn Off.

Verification on macOS:

- `node --import tsx --test packages/pi-better-sandbox/test/*.test.ts`: 236 passed, one Linux-only test skipped. The eight new admission tests all passed, including the real-kernel cases.
- `node node_modules/typescript/bin/tsc --noEmit -p packages/pi-better-sandbox/tsconfig.json`: passed.
- `npm exec --workspace=packages/pi-better-background-tasks -- vitest run src/sandbox.test.ts src/sandbox-kernel.test.ts src/sandbox-provenance.test.ts src/task-diagnostics.test.ts src/output.test.ts src/runtime.test.ts src/stall.test.ts`: all 154 tests passed across seven files.
- Background package type-checking was attempted. It reports the existing unrelated `batch.test.ts:136` and `batch.ts:75` errors about `batchId`; those files were not changed.
- Scoped `git diff --check`: passed. Test-quality lint reported zero gates and one text-oracle lead. That lead matches source-path fixtures used for provenance checks; the test loads and executes tools, not source-text assertions.

Linux kernel behavior requires a capable Linux runner; the macOS run does not establish that evidence. The previously reproduced #409 end-to-end failure was not rerun or changed. No full-repository suite, new TUI end-to-end run, or live SSH test was claimed. No commits were made.
