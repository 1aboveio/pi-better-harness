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

Callbacks are terminal-only by default. Ordinary callback-enabled terminal
transitions accumulate for 100 ms and produce one compact follow-up, shared with
subagent completions loaded in the same Pi host. Every row includes source, id,
label, terminal status, and its durable status/result tool. `callback:false`
never enters the batch and sends no model follow-up.

Cancelled tasks never produce a callback: stopping a task is an explicit action
by the agent or user, so a completion wakeup would be noise. The cancellation is
recorded as a durable callback suppression, so a cancelled task is also silent
across a session restart. `timed_out`, `failed`, and `succeeded` transitions
still fire callbacks.

Set `PI_BETTER_CALLBACK_BATCH_MS` to `0` through `5000` milliseconds to tune the
accumulation window; invalid values use 100 ms. A single event flushes when that
bounded window expires. Failed sends leave all affected events unmarked and
retryable; ownership is rechecked at flush so another cwd/session is suppressed.

Callbacks point to `bg_task_status` first. The aggregate never contains result
objects or raw logs. The default status response is a compact model-facing
summary that omits large command bodies; use `verbose:true` only when full
metadata is required. `bg_task_log` defaults to a 20-line terminal-aware tail.
`tail_lines: 0` returns the retained raw log, up to a 512 KiB safe-read cap.

Pi's optional `followUpMode: all` still helps when a later completion arrives
after an earlier 100 ms aggregate has already flushed: Pi can consume queued
follow-ups together in one later agent turn. This extension does not change Pi
core or Pi's default follow-up mode.

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

## Observable Progress

Running tasks are classified as `healthy`, `quiet`, or `stalled` from observable
progress. A process advances when its output log advances; a watcher advances
when its poll command returns. The navigator shows quiet or stalled tasks, and
stalled tasks are marked unhealthy in goal activity. This is advisory only: it
does not stop or fail a process.

The shared defaults are quiet after 60 seconds and stalled after 5 minutes.
Override either threshold in milliseconds for all installed harness extensions:

```sh
PI_BETTER_STALL_QUIET_MS=120000
PI_BETTER_STALL_MS=600000
```

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