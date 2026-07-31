# pi-better-background-tasks

Generic durable background tasks for [pi](https://pi.dev). The extension lets an
agent start long-running commands or command-based watchers without blocking the
foreground turn. Task metadata and logs are stored under the OS temp directory,
so status and logs remain available across `/reload` and ordinary session use.

The core is deliberately domain-neutral. GitHub, Mergify, Cloud Build, Vercel,
and similar integrations should be thin presets on top of the generic watcher,
not special cases in the runtime.

## Tools

| Tool | Purpose |
| ---- | ------- |
| `bg_task_spawn` | Start a long-running process and return immediately. |
| `bg_task_watch` | Poll a command until success/failure/timeout. |
| `bg_task_list` | List known tasks. |
| `bg_task_status` | Inspect one task. Compact by default; pass `verbose:true` for full metadata JSON. |
| `bg_task_log` | Read a bounded, terminal-aware task log tail. |
| `bg_task_stop` | Cancel a watcher or terminate a process task. |
| `bg_task` | Action-based wrapper for `spawn`, `watch`, `list`, `status`, `log`, `stop`, `clear`. |
| `bg_status` | Small action wrapper for `list`, `status`, `log`, `stop`, `clear`. |

`clear` dismisses terminal tasks for the active cwd/session so they no longer
count as foreground attention. It keeps metadata and logs on disk for explicit
inspection.

Callbacks are terminal-only by default. When `callback` is not false, a task that
reaches a terminal state queues one follow-up message telling the foreground
agent which task finished and which tool to call for details.

Callbacks point to `bg_task_status` first. The default status response is a
compact model-facing summary that omits large command bodies; use
`verbose:true` only when full metadata is required. `bg_task_log` defaults to a
20-line terminal-aware tail. `tail_lines: 0` returns the retained raw log, up
to a 512 KiB safe-read cap.

## Log Retention

Background processes retain at most 4 MiB of raw output by default. When output
crosses that budget, the task keeps its newest raw bytes in the same log inode
and records the discarded-byte count in task status and detail metadata. This
preserves detached-process output while preventing progress-heavy commands from
growing a log without bound during supervision.

Set `max_log_bytes` on `bg_task_spawn` or `bg_task_watch` to use a different
budget, with a minimum of 64 KiB. The detail page always shows 10 terminal
display rows initially; `l` switches between 10 and 25 rows. Carriage-return
progress redraws such as `rsync --progress` are collapsed to their latest
visible state, leaving subsequent error lines readable.

Command watchers default to a 15 minute timeout when `timeout_seconds` is
omitted. Pass `timeout_seconds: 0` to disable the watcher timeout explicitly.
Spawned processes do not get a default timeout.

## Examples

```json
{
  "name": "dev server",
  "command": "npm run dev",
  "cwd": "/path/to/app"
}
```

```json
{
  "name": "wait for success",
  "command": "node ./scripts/check-status.js --json",
  "interval_seconds": 15,
  "timeout_seconds": 600,
  "success_when": { "type": "json_path_equals", "path": "$.status", "value": "done" },
  "failure_when": { "type": "json_path_equals", "path": "$.status", "value": "failed" }
}
```

Commands run through `/bin/bash -lc` by default so shell-mode watchers behave
consistently across sessions. Set `PI_BETTER_BACKGROUND_TASKS_SHELL` to override
that shell, or pass `argv` and `shell:false` to avoid shell parsing.