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
- Harness-owned run timing: every run gets a soft deadline (30 min, then a wrap-up steer into the child and one parent wake, stopped after 5 min grace), a hard ceiling (90 min), and a no-progress wake (10 min). Override per spawn with `deadline_minutes`, `grace_minutes`, `max_minutes`, `stuck_minutes`, or globally in `config.json` / `PI_SUBAGENT_*_MINUTES`. See [usage notes](docs/usage.md#run-timing-deadline-ceiling-stuck).

## Install

```sh
pi install npm:pi-better-subagents
```

Try it for one run:

```sh
pi -e npm:pi-better-subagents
```

Linux confinement requires a usable `bubblewrap` backend and Pi SDK 0.82.1 or newer. `/sandbox` controls the independent Subagents profile, which each launch freezes. Pi handles its own startup, authentication, and provider connection; task tools obey the selected file, command, and network permissions. Outside project defaults to Write: tasks write across home and temp but can remove files outside the workspace only in temp, hidden home directories, and worktree folders (Linux keeps ordinary home folders read-only instead). Confined children admit `read`, `write`, `edit`, and `bash`, the guarded `apply_patch` (Codex patches that follow the file rules), and the trusted tools ticked in `/sandbox` → Subagents · Tools (default `web_fetch` and `web_search`), which run outside the file rules. Other requested tools are reported as unavailable, with the reason. See [usage notes](https://github.com/1aboveio/pi-better-harness/blob/main/packages/pi-better-subagents/docs/usage.md#write-sandbox) for the runtime boundary and supported configurations.

## Delegation Modes

`config.json` sets `delegationMode` to `manual`, `adaptive` (default), or
`coordinator`. `/subagents` displays the active mode, and
`/subagents mode manual|adaptive|coordinator` changes it for the current
session without changing config. Manual delegates only on explicit user or workflow request, even with a
plan. Adaptive delegates substantial independent work when useful. Coordinator
uses `agents_catalog` to discover current role descriptions and delegates every
nontrivial role-owned task, while the foreground coordinates, integrates, and
verifies. See [usage notes](docs/usage.md#delegation-mode).

`agents_catalog` shows each role's and named agent's default model and effort,
such as `default openai/gpt-6-sol@high`. To launch on that default, omit
`model` and `thinking` on a role or agent spawn; name one only for a stated
reason. When a launch's model or effort differs from the default, its launch
line says so, for example
`model openai/gpt-6-astra@high (role default openai/gpt-6-sol@high)`.

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
