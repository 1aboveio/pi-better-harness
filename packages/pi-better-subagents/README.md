# pi-better-subagents

`pi-better-subagents` is a Pi extension for detached, sandboxed subagent runs that keep the foreground Pi session free.

## Quick Answer

Use `pi-better-subagents` when you want Pi to launch independent agent work without blocking the current conversation. Each subagent runs in its own `pi -p` child process, reports back when finished, and keeps durable logs for later inspection.

## Screenshots

<p><img src="https://raw.githubusercontent.com/1aboveio/pi-better-harness/main/docs/images/package-gallery/pi-better-subagents.png" alt="pi-better-subagents rendered in Pi" width="49%" /><img src="https://raw.githubusercontent.com/1aboveio/pi-better-harness/main/docs/images/package-gallery/overview/pi-better-subagents.png" alt="pi-better-subagents package overview" width="49%" /></p>

## Core Features
- Non-blocking subagent launches, with an optional role and named-agent catalog (`docs/agent-catalog.md`, `docs/agent-catalog-lifecycle.md`).
- Default OS write sandboxing on macOS and Linux.
- Explicit tool allowlists for child sessions.
- Durable logs, result retrieval, and [failure observations](docs/failure-observations.md) independent of lifecycle status. A live child handles its own tool errors; the parent is woken only for actionable incidents, and children can classify handled failures with `failure_disposition`.
- Live background-work navigator for active runs.

## Install

```sh
pi install npm:pi-better-subagents
```

Try it for one run:

```sh
pi -e npm:pi-better-subagents
```

Linux confinement requires a usable `bubblewrap` backend and Pi SDK 0.82.1 or newer. `/sandbox` controls the independent Subagents profile, which each launch freezes. Pi handles its own startup, authentication, and provider connection; task tools obey the selected file, command, and network permissions. Outside project defaults to Read. Currently confined children admit `read`, `write`, `edit`, and `bash`; unsupported requested tools are reported as unavailable. See [usage notes](https://github.com/1aboveio/pi-better-harness/blob/main/packages/pi-better-subagents/docs/usage.md#write-sandbox) for the runtime boundary and supported configurations.

## When To Use

Use this package for independent coding, review, research, or verification work that can finish later. Do not use it for steps that need immediate foreground interaction or user clarification.

## Compatibility

| Requirement | Support |
|-------------|---------|
| Pi | Required |
| Install method | `pi install npm:pi-better-subagents` |
| macOS sandboxing | Supported by default |
| Linux sandboxing | Uses `bubblewrap` when available |
| Development runtime | Node.js 22+ |

## Update Or Remove

```sh
pi update npm:pi-better-subagents
pi remove npm:pi-better-subagents
```

## More Detail

- Repository: https://github.com/1aboveio/pi-better-harness
- Detailed notes: https://github.com/1aboveio/pi-better-harness/blob/main/packages/pi-better-subagents/docs/usage.md
- License: https://github.com/1aboveio/pi-better-harness/blob/main/LICENSE
