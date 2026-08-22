# pi-better-background-tasks

`pi-better-background-tasks` is a Pi extension for durable background shell tasks, watchers, logs, and status inspection.

## Quick Answer

Use `pi-better-background-tasks` when a command should keep running while the foreground Pi session stays free. It is best for dev servers, long scripts, queue watchers, deploy checks, log tails, and other command-driven work.

## Screenshots

<p><img src="https://raw.githubusercontent.com/1aboveio/pi-better-harness/main/docs/images/package-gallery/pi-better-background-tasks.png" alt="pi-better-background-tasks rendered in Pi" width="49%" /><img src="https://raw.githubusercontent.com/1aboveio/pi-better-harness/main/docs/images/package-gallery/overview/pi-better-background-tasks.png" alt="pi-better-background-tasks package overview" width="49%" /></p>

## Core Features

- Start long-running commands without blocking the current turn.
- Watch commands until success, failure, or timeout.
- Keep task metadata and logs available across reloads.
- Show active work in Pi's background-work navigator.
- Flag running tasks with no observable output or completed poll as stalled.

## Remote SSH

For short synchronous remote commands that should return output in the current
turn, install `pi-better-ssh` and use `remote_bash`. Use background tasks for
long-running or durable remote jobs and asynchronous health watches.

Prefer structured `ssh` fields over hand-written `ssh` command lines. A remote
spawn uses a durable tmux session by default, while a remote watch opens one
direct SSH poll per interval and does not require tmux. The package keeps the
same local metadata, logs, terminal statuses, callbacks, and `/reload` recovery
for both.

```json
{
  "name": "remote build",
  "command": "npm run build",
  "ssh": { "host": "build.example", "user": "deploy" },
  "remote": { "workdir": "/srv/app" },
  "timeout_seconds": 1800
}
```

Tmux-backed spawn can install tmux non-interactively when the remote host allows
it and fails closed with copy-pasteable setup guidance when it cannot. Set
`remote.session=direct` only as an explicit escape hatch for short jobs: stop or
timeout can terminate the local SSH client but the remote process may still be
running. See the detailed usage notes for bootstrap policy, watch conditions,
timeouts, and v1 non-goals.

## Install

```sh
pi install npm:pi-better-background-tasks
```

Try it for one run:

```sh
pi -e npm:pi-better-background-tasks
```

## When To Use

Use this package for shell commands that need logs, status, cancellation, or completion notifications across a Pi turn.

Do not use it for short commands where the foreground session should wait for the result directly; use `remote_bash` from `pi-better-ssh` instead.

## Compatibility

| Requirement | Support |
|-------------|---------|
| Pi | Required |
| Install method | `pi install npm:pi-better-background-tasks` |
| Development runtime | Node.js 22+ |

## Update Or Remove

```sh
pi update npm:pi-better-background-tasks
pi remove npm:pi-better-background-tasks
```

## More Detail

- Repository: https://github.com/1aboveio/pi-better-harness
- Detailed notes: https://github.com/1aboveio/pi-better-harness/blob/main/packages/pi-better-background-tasks/docs/usage.md
- License: https://github.com/1aboveio/pi-better-harness/blob/main/LICENSE
