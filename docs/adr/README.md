# Architecture decision records

## Current lifecycle and permission rules

| When you need to know… | Start here |
| --- | --- |
| Which tools a task loads, which provider supplies them, and whether an operation is allowed | [Harness 0027 · Sandbox](0027-sandbox-tools-and-permissions.md) |
| Who owns a Background task, what counts as progress, and when a stall, wait or completion produces an event | [Harness 0028 · Background tasks](0028-background-task-policy.md) |
| When a frontend connects, how the shared server recovers work, and how a notification reaches its session after a disconnect | [Harness 0029 · Server and notifications](0029-notification-delivery.md) |
| When the foreground continues, waits, pauses or completes, and how Todo and acceptance evidence affect that decision | [Harness 0030 · Goal and Todo](0030-goal-and-todo-lifecycle.md) |
| How Recap summarizes a settled run and preserves foreground context and cache identity | [Harness 0031 · Session recaps](0031-isolated-session-recaps.md) |
| What survives a subagent attempt, which limits apply, what the parent receives, and when a workspace can be reclaimed | [Subagents 0007 · Subagent lifecycle](../../packages/pi-better-subagents/docs/adr/0007-subagent-lifecycle.md) |

When a worker parks on a Background task, the Background policy determines when the wait is ready. The worker resumes when eligible and interprets the evidence. The coordinator records the terminal assignment outcome. The server routes its notification to the parent, which checks the deliverable against its Goal.

## Supporting decisions

| Subject | Decision and scope |
| --- | --- |
| Remote commands | [Harness 0001 · Synchronous SSH commands](0001-pi-better-ssh-sync-remote-bash.md) and [0002 · Shared SSH protocol](0002-ssh-core-shared-package.md) define the separate command and durable-job entry points and their common transport. |
| Failure evidence | [Harness 0006 · Failure observations](0006-shared-failure-observations.md) defines incidents, dispositions and recovery evidence. [0012 · Permission reports](0012-actionable-permission-blockers.md) defines how an agent reports a failed operation. Its amendment removed automatic Goal holds. |
| Settings | [Harness 0013 · Settings contributions](0013-harness-settings-and-next-prompt-suggestions.md) defines package-owned controls and records the deferral of prompt suggestions. [0014 · Global defaults](0014-global-harness-defaults.md) governs persistence. |
| Execution and prompts | [Harness 0016 · Concurrency](0016-unified-execution-concurrency.md) defines shared scheduling guidance. [0021 · Prompt prefix](0021-prompt-prefix-stays-cached.md) defines how guidance can change within a conversation. |
| Prompt authoring and replay | [Harness 0033 · Modular prompts and replay](0033-modular-prompts-and-replay.md) covers global principles, skills, candidate revisions, authorized activation and isolated response, turn and task replay. |
| Goal and Todo storage | [Harness 0018 · Outcome, Todo and the Goal bridge](0018-harness-outcome-todo.md) defines record ownership, branch restoration and the durable work ledger. |
| Assignment coordination | [Harness 0020 · Observed waits](0020-observed-waits-retain-an-owner.md) defines wait ownership, fenced resumption, repair and the terminal transaction. [0022 · Assignment progress](0022-assignment-progress-projection.md) defines completion evidence and how consumers read the outcome. |
| Runtime performance | [Harness 0032 · Plugin and runtime performance design](0032-runtime-performance-design.md) defines who owns repeated work, when to refresh shared data and how to bound recovery. |
| Server implementation | [Harness 0023 · Unified server runtime](0023-unified-server-runtime.md) covers process ownership, build compatibility and recovery. |
| Worker supervision | [Subagents 0002 · Process-group health](../../packages/pi-better-subagents/docs/adr/0002-process-group-only-subagent-health.md) defines the evidence for orphaned and lost processes. [Subagents 0004 · Run timing](../../packages/pi-better-subagents/docs/adr/0004-harness-owned-run-timing.md) defines deadlines, hard timeouts and alerts. |
| Worker workspace | [Subagents 0006 · Git workspace isolation](../../packages/pi-better-subagents/docs/adr/0006-git-workspace-isolation.md) specifies Clone and Worktree, including recovery after a blocked Git operation. The lifecycle record above governs preservation and delivery in either mode. |
| Worker catalog | [Subagents 0003 · Roles and inheritance](../../packages/pi-better-subagents/docs/adr/0003-native-agent-catalog-live-inheritance.md), [0005 · Skill exposure](../../packages/pi-better-subagents/docs/adr/0005-catalog-skill-exposure.md) and [0008 · Catalog across hosts](../../packages/pi-better-subagents/docs/adr/0008-shared-worker-catalog.md) cover definitions, launch choices and host adapters. |

## Earlier sandbox and Background decisions

These records explain how the current policies evolved. Use the Sandbox and Background records above for present-day rules.

| Subject | Earlier decisions |
| --- | --- |
| Enforcement and startup | [Harness 0003 · Shared sandbox core](0003-sandbox-core-shared-package.md), [0007 · Trusted runtime](0007-trusted-runtime-task-boundary.md), [Subagents 0001 · Linux backend](../../packages/pi-better-subagents/docs/adr/0001-linux-sandbox-bubblewrap.md) |
| Scopes and settings | [Harness 0004 · Activation](0004-foreground-sandbox-opt-in.md), [0005 · Permission table](0005-sandbox-permission-table.md), [0026 · Explicit Off](0026-explicit-sandbox-off.md) |
| File and credential rules | [Harness 0008 · Write and removal](0008-write-without-delete.md), [0010 · File permission levels](0010-unified-file-permission-labels.md) |
| Tools, commands and processes | [Harness 0009 · Guarded and trusted tools](0009-guarded-and-trusted-subagent-tools.md), [0011 · Process inventory](0011-fixed-read-only-process-inventory.md), [0019 · Application and shell controls](0019-application-and-shell-controls.md), [0024 · macOS process identity](0024-sandbox-process-identity-compatibility.md) |
| Diagnostics and admission | [Harness 0015 · Local diagnostics](0015-local-sandbox-diagnostics.md), [0017 · Background adapter admission](0017-background-adapter-admission.md) |
| Background cleanup | [Harness 0025 · Assignment-owned task cleanup](0025-assignment-terminal-task-cleanup.md) |

## Reading and updating a decision

**Harness** numbers refer to this directory. **Subagents** numbers refer to the package's ADR directory. Cite the scope and link the record when referring across directories. Each directory assigns its own numbers.

Update the record that owns the rule. When a decision changes, identify the replaced clause in the earlier record and link to its successor. Keep still-applicable details and historical links. An accepted ADR records a design decision. Its acceptance cases describe what an implementation must demonstrate. Use test or release evidence for claims about a particular build.
