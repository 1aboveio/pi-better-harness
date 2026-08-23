# pi-better-harness

Meta package for the core Pi Better Harness extensions.

Use it to manage the tools used most often in Pi:

- `pi-better-sandbox` for a default-on write sandbox around Pi's foreground tools
- `pi-better-subagents` for detached subagent runs and completion callbacks
- `pi-better-background-tasks` for durable shell tasks and command watchers
- `pi-better-goal` for current-goal tracking and background-aware continuation

`pi-better-read-aloud` is intentionally not included yet.

## Install

Install every harness extension as a standalone Pi package:

```sh
npx pi-better-harness install
```

Use project-local Pi settings:

```sh
npx pi-better-harness install --local
```

For backward-compatible bundled loading, use `pi install npm:pi-better-harness`.

## Ordinary Startup

Nothing changes about how you start Pi:

```sh
pi
```

The sandbox extension arms itself at every session start — startup, new session,
resume, fork, and reload. It ships no launcher and writes no settings file. See
[the sandbox package](https://github.com/1aboveio/pi-better-harness/tree/main/packages/pi-better-sandbox#readme)
for the full policy.

## Included Tools

After installation, Pi can use these model-callable tools:

| Extension | Tools |
| --------- | ----- |
| `pi-better-sandbox` | none — it replaces the built-in `bash`, `write`, and `edit` tools rather than adding any |
| `pi-better-subagents` | `subagent_spawn`, `subagent_spawn_batch`, `subagent_list`, `subagent_output`, `subagent_result`, `subagent_stop` |
| `pi-better-background-tasks` | `bg_task_spawn`, `bg_task_watch`, `bg_task_list`, `bg_task_status`, `bg_task_log`, `bg_task_stop`, `bg_task`, `bg_status` |
| `pi-better-goal` | `get_goal`, `update_goal`, `get_background_activity` |

The goal extension also provides the `/goal` and `/better-activity` commands.

Sandbox control is human-only. `/sandbox`, `/sandbox on`, `/sandbox off`,
`/sandbox deny ...`, and `/sandbox rules` are slash commands with no tool
equivalent, so the model cannot disable its own confinement or edit the paths it
is confined away from. `/sandbox off` additionally needs an interactive
confirmation and is refused where there is no interactive UI.

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
pi install npm:pi-better-goal
```

## Update Or Remove

```sh
npx pi-better-harness uninstall
npx pi-better-harness uninstall --local
```

## Source

Repository: https://github.com/1aboveio/pi-better-harness
