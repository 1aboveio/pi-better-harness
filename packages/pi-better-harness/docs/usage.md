# pi-better-harness

Meta package for the core Pi Better Harness extensions.

Use it to manage the background-work tools used most often in Pi:

- `pi-better-subagents` for detached subagent runs and completion callbacks
- `pi-better-background-tasks` for durable shell tasks and command watchers
- `pi-better-goal` for current-goal tracking and background-aware continuation

`pi-better-read-aloud` is intentionally not included yet.

## Install

Install all three extensions as standalone Pi packages:

```sh
npx pi-better-harness install
```

Use project-local Pi settings:

```sh
npx pi-better-harness install --local
```

For backward-compatible bundled loading, use `pi install npm:pi-better-harness`.

## Included Tools

After installation, Pi can use these model-callable tools:

| Extension | Tools |
| --------- | ----- |
| `pi-better-subagents` | `subagent_spawn`, `subagent_spawn_batch`, `subagent_list`, `subagent_output`, `subagent_result`, `subagent_stop` |
| `pi-better-background-tasks` | `bg_task_spawn`, `bg_task_watch`, `bg_task_list`, `bg_task_status`, `bg_task_log`, `bg_task_stop`, `bg_task`, `bg_status` |
| `pi-better-goal` | `get_goal`, `update_goal`, `get_background_activity` |

The goal extension also provides the `/goal` and `/better-activity` commands.

## Install Individual Packages

Use these when you want only one part of the harness:

```sh
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
