# pi-better-background-tasks

Durable background processes and watchers for [Pi](https://pi.dev).

Use it when work should keep running while the foreground session stays free: dev servers, long scripts, queue watchers, deploy checks, log tails, and other command-driven tasks.

## Core Features

- Start long-running commands without blocking the current turn.
- Watch commands until success, failure, or timeout.
- Keep task metadata and logs available across reloads.
- Show active work in Pi's background-work navigator.

## Install

```sh
pi install npm:pi-better-background-tasks
```

Try it for one run:

```sh
pi -e npm:pi-better-background-tasks
```

## Update Or Remove

```sh
pi update npm:pi-better-background-tasks
pi remove npm:pi-better-background-tasks
```

## More Detail

- Repository: https://github.com/1aboveio/pi-better-harness
- Detailed notes: https://github.com/1aboveio/pi-better-harness/blob/main/packages/pi-better-background-tasks/docs/usage.md
