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

## Remote SSH

For remote work, pass structured `ssh` fields and put the command to execute on
the host in `command`. Do not wrap it in a hand-written outer `ssh` command. The
preset constructs a local `shell:false` argv with non-interactive defaults:
`BatchMode=yes`, a 10 second connect timeout, and no TTY on control and poll
paths.

Supported connection fields are:

- `host` (required)
- `user`
- `port`
- `identity_file`
- `jump` (passed with `-J`)
- `options` (additional SSH `-o` key/value pairs)

Required safety options cannot be disabled through `options`. Password and
keyboard-interactive authentication therefore fail fast instead of waiting for
a prompt.

### Spawn + SSH

Spawn defaults to a durable remote tmux session. The session name is derived
from the background task id, remote output is copied into the normal local task
log, and stop kills that tmux session before recording `cancelled`. Persisted
host, session name, mode, log offset, command, and conditions let supervision
resume after `/reload` or a session restart without creating a second tmux
session.

```json
{
  "name": "remote deploy",
  "command": "./scripts/deploy.sh production",
  "timeout_seconds": 1800,
  "ssh": {
    "host": "deploy.example",
    "user": "release",
    "port": 2222,
    "identity_file": "/home/me/.ssh/release",
    "jump": "bastion.example",
    "options": { "ServerAliveInterval": "15" }
  },
  "remote": {
    "session": "tmux",
    "workdir": "/srv/app",
    "install_tmux": true
  }
}
```

A tmux-backed spawn probes `command -v tmux` and `tmux -V` first. If tmux is
missing and installation is enabled, the preset detects `apt-get`, `dnf`,
`yum`, `apk`, `pacman`, `zypper`, or `brew`. Root installs directly, brew uses
its normal unprivileged command, and other supported managers use `sudo -n`
only when passwordless sudo is available. Every successful package install is
disclosed in logs and status.

If installation is disabled, no supported manager exists, passwordless sudo is
unavailable, installation fails, or tmux cannot be verified, the task produces
a needs-user result with the exact one-host install and verify commands. Spawn
fails closed; it never silently falls back to direct mode. Bootstrap itself is
time-bounded so a package mirror cannot hold supervision indefinitely.

Spawn has no default `timeout_seconds`. When a deadline is supplied, a running
tmux session is killed and the task becomes `timed_out` with the host and
session in its result text.

### Watch + SSH

Watch + SSH always uses direct, one-shot SSH polls. Each interval opens one SSH
connection, runs the remote `command`, records stdout, stderr, exit status, and
evaluates the existing `success_when` and optional `failure_when` conditions.
Watch never probes, installs, or starts tmux, even if tmux fields are supplied.
A resumed watch reconstructs the same SSH target and keeps its persisted
conditions.

```json
{
  "name": "wait for remote health",
  "command": "curl -fsS http://127.0.0.1:8080/health",
  "interval_seconds": 15,
  "ssh": { "host": "app.example", "user": "deploy" },
  "remote": { "session": "direct" },
  "success_when": { "type": "stdout_contains", "value": "ok" },
  "failure_when": { "type": "stderr_contains", "value": "fatal" }
}
```

Remote watches use the normal 900 second default timeout. Set
`timeout_seconds: 0` to disable it explicitly. A deadline, including the
default, produces `timed_out` with the SSH target in the result text.

### Direct Spawn Escape Hatch

Set `remote.session=direct` on spawn to skip tmux and all installation work.
This is intended for short commands where durable remote lifecycle control is
not required. Direct mode has weak stop semantics: stop or timeout terminates
the local SSH client, but the remote process may still be running. Status and
launch text call out this risk and never claim a remote kill.

### V1 Non-Goals

SSH ControlMaster and connection multiplexing are intentionally out of scope in
v1. Tmux owns remote job lifecycle; connection reuse can be added separately
without coupling correctness to control-socket state. V1 also does not provide
interactive password authentication, interactive remote shells, PTY or tmux
attach UX, `screen` / `systemd-run` / `nohup` fallback ladders, guaranteed
remote kill in direct mode, or a first-class Windows OpenSSH matrix.

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
metadata is required. `bg_task_log` defaults to a 5-line terminal-aware tail.
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