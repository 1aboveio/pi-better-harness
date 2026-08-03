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

Do not use it for short commands where the foreground session should wait for the result directly.

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
