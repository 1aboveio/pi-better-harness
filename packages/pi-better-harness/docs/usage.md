# pi-better-harness

Harness-owned task context and Todo, alongside the core Pi Better Harness extensions.

Use it to manage the tools used most often in Pi:

- `pi-better-sandbox` for an opt-in write sandbox around Pi's foreground tools
- `pi-better-subagents` for detached subagent runs and completion callbacks
- `pi-better-background-tasks` for durable shell tasks and command watchers
- `pi-better-ssh` for safe synchronous remote commands over reusable SSH connections
- `pi-better-goal` for explicit triggers and background-aware continuation
- Harness Outcome & Todo for persistent outcomes, optional checklists, and context reminders

`pi-better-read-aloud` is intentionally not included yet.

## Install

Install the component packages and the Harness-owned runtime:

```sh
npx pi-better-harness install
```

Use project-local Pi settings:

```sh
npx pi-better-harness install --local
```

The installer keeps component identities, loads only Harness-owned extensions from
its bundle, and removes a retired Plan registration in the selected scope.
Alternatively, load the complete bundle with `pi install npm:pi-better-harness`.

## Outcome & Todo

In `/harness-settings`, **Outcome & Todo** defaults to **Off**. Enabling it exposes
`update_todo`, `get_todo`, and the Todo widget. `/todo` opens the full view;
`/todo expand`, `/todo collapse`, `/todo hide`, and `/todo show` control its display.
An outcome can exist without a checklist. A finished or cleared checklist does not
complete or remove the outcome.

Harness registers its context hook when loaded. While enabled and a task is active,
it includes a short outcome reminder and current Todo focus before each model call.
No hook file or postinstall setup is required. Disabling the feature hides the tools
and widget and stops reminders without deleting saved state. Enabling it never
starts or resumes work. `/goal` and skills cannot enable it on their own.

Skills use this optional interface only when its tools are available. Workflow task
plans retain their own schema, revision checks, and source requirements. When the
interface is off, workflows continue using their own records and text display.
Use `newTask: true` with an outcome when switching to unrelated work; omit it for
corrections to the current task. Session state follows the active branch and survives
compaction and reload. Existing Plan histories remain readable as Todo.

## Ordinary Startup

Nothing changes about how you start Pi:

```sh
pi
```

The sandbox extension starts inactive. `/sandbox on` enables it for the current
session; `/sandbox default on` persists opt-in across startup, new session,
resume, fork, and reload. It ships no launcher. See
[the sandbox package](https://github.com/1aboveio/pi-better-harness/tree/main/packages/pi-better-sandbox#readme)
for the full policy.

## Included Tools

After installation, Pi can use these model-callable tools:

| Extension | Tools |
| --------- | ----- |
| `pi-better-sandbox` | none — it replaces the built-in `bash`, `write`, and `edit` tools rather than adding any |
| `pi-better-subagents` | `subagent_spawn`, `subagent_spawn_batch`, `subagent_list`, `subagent_output`, `subagent_result`, `subagent_stop` |
| `pi-better-background-tasks` | `bg_task_spawn`, `bg_task_watch`, `bg_task_list`, `bg_task_status`, `bg_task_log`, `bg_task_stop`, `bg_task`, `bg_status` |
| `pi-better-ssh` | `remote_bash`, `ssh_profile`, `ssh_mux` |
| `pi-better-goal` | `get_goal`, `update_goal`, `get_background_activity` |
| Harness Outcome & Todo (when enabled) | `update_todo`, `get_todo` |

The goal extension also provides the `/goal` and `/better-activity` commands.

## Coordinated Execution

For substantial work, an enabled Harness Todo can serve as the foreground coordinator's milestone ledger. It is optional: when disabled, use the workflow's own records or ordinary task tracking. Identify ready, authorized independent units, including separate per-host migrations, and start them concurrently within resource constraints before waiting. Serialize only for real dependencies, shared writes, resource or capacity limits, or explicit rollout or availability requirements; record the reason.

Use foreground tools for small, tightly coupled, or interactive work. Use `subagent_spawn` or `subagent_spawn_batch` only as permitted by the active `manual`, `adaptive`, or `coordinator` delegation mode. Manual forbids proactive subagents, not parallel foreground or background execution; an explicit user request or active workflow requirement may still authorize delegation. Use `bg_task_spawn` or `bg_task_watch` for independent long-running commands or waits. Continue unblocked foreground work after launch instead of polling workers.

Ask once about an unresolved material operational availability tradeoff while independent preparation continues. A host-local failure does not block other independent hosts unless there is evidence of a shared cause. Concurrency never bypasses safety, authorization, or workflow prerequisites. This policy adds no auto-launcher, scheduler, or reminder loops.

Mark distinct ready milestones `in_progress` concurrently only when their work is actually underway. Track per-host deliverables as distinct milestones, not individual worker processes. The subagent and background-task registries own run status; the plan owns milestones, dependencies, integration, and verification. Before completing verification, the plan, or the active goal, ensure every relevant subagent and background task is terminal and inspect and integrate its result or failure.

Sandbox control is human-only. `/sandbox`, `/sandbox on`, `/sandbox off`,
`/sandbox default on|off`, `/sandbox deny ...`, and `/sandbox rules` are slash
commands with no tool equivalent, so the model cannot change its own
confinement or edit the paths it is confined away from. `/sandbox off` and
`/sandbox default off` additionally need interactive confirmation and are
refused where there is no interactive UI.

### What is and is not confined

Reads and network access are **unrestricted** — this sandbox only limits writes.
Writes are confined for the integrated first-party execution paths: Pi's built-in
`bash`, `write`, and `edit` tools, user-entered `!` / `!!` commands, local
`pi-better-background-tasks` launches, and `pi-better-subagents` children.

Pi's own process, arbitrary `pi.exec` calls, and unrelated third-party extension
code are **not** confined. This is a tool-execution sandbox, not a boundary
around Pi itself.

Confinement is **per surface**. Each integrated surface denies its own control
plane — the files naming what it will run next — but not every other surface's.
With more than one first-party surface installed, a confined process on one can
still write another's control plane. Read the guarantee as "this surface's
writes are confined", not "no unconfined execution can be arranged anywhere".

## Install Individual Packages

Use these when you want only one part of the harness:

```sh
pi install npm:pi-better-sandbox
pi install npm:pi-better-subagents
pi install npm:pi-better-background-tasks
pi install npm:pi-better-ssh
pi install npm:pi-better-goal
```

## Update Or Remove

```sh
npx pi-better-harness uninstall
npx pi-better-harness uninstall --local
```

## Source

Repository: https://github.com/1aboveio/pi-better-harness
