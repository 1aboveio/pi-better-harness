# pi-better-harness

`pi-better-harness` is a Pi meta package that installs the core Pi Better Harness extensions: an opt-in foreground write sandbox, delegated subagents, durable background tasks, and goal tracking.

## Quick Answer

Use `pi-better-harness` when you want the full working set for Pi. It manages:

- `pi-better-sandbox` for an opt-in write sandbox around Pi's foreground tools.
- `pi-better-subagents` for detached, sandboxed subagent runs.
- `pi-better-background-tasks` for durable shell tasks and watchers.
- `pi-better-goal` for objective tracking that is aware of background work.

`pi-better-read-aloud` is intentionally not included yet.

## Screenshots

<p><img src="https://raw.githubusercontent.com/1aboveio/pi-better-harness/main/docs/images/package-gallery/pi-better-harness.png" alt="pi-better-harness rendered in Pi" width="49%" /><img src="https://raw.githubusercontent.com/1aboveio/pi-better-harness/main/docs/images/package-gallery/overview/pi-better-harness.png" alt="pi-better-harness package overview" width="49%" /></p>

## Install

Install the extensions as standalone Pi packages, so Pi displays and manages each by its own package name:

```sh
npx pi-better-harness install
```

For project-local Pi settings:

```sh
npx pi-better-harness install --local
```

The bundled installation remains available for compatibility:

```sh
pi install npm:pi-better-harness
```

## Ordinary Startup

You keep launching Pi the way you always have:

```sh
pi
```

The foreground write sandbox starts inactive. Use `/sandbox on` for the current
session or `/sandbox default on` to persist opt-in across startup, new session,
resume, fork, and reload. There is no launcher.

While it is on, Pi's built-in `bash`, `write`, and `edit` tools, your own `!` / `!!` commands, local background tasks, and subagents can write only under the directory you launched Pi from, minus the packaged deny paths (`.git/hooks`, `.env`, `.env.local`).

**Reads and network access are unrestricted** — this sandbox limits writes only. Writes are confined for those integrated first-party execution paths; Pi's own process, arbitrary `pi.exec` calls, and unrelated third-party extension code are **not** confined. Confinement is also **per surface**: each integrated surface denies its own control plane, not every other surface's, so with several first-party surfaces installed a confined process on one can still write another's control plane.

Sandbox state is human-only: `/sandbox`, `/sandbox on`, `/sandbox off`,
`/sandbox default on|off`, `/sandbox deny ...`, and `/sandbox rules` are slash
commands with no tool equivalent. `/sandbox off` and `/sandbox default off`
need interactive confirmation. Full policy: [pi-better-sandbox](https://github.com/1aboveio/pi-better-harness/tree/main/packages/pi-better-sandbox#readme).

## When To Use

Use the installer when you want every core extension with standalone package identities. Install an individual package instead when you only need the sandbox, subagents, shell task supervision, or goal tracking.

## Compatibility

| Requirement | Support |
|-------------|---------|
| Pi | Required |
| Recommended install | `npx pi-better-harness install` |
| Write sandbox on macOS | Seatbelt (`sandbox-exec`), ships with the OS |
| Write sandbox on Linux | Bubblewrap — install `bubblewrap` |
| Development runtime | Node.js 22+ |

## Update Or Remove

Remove every standalone package:

```sh
npx pi-better-harness uninstall
```

Add `--local` to remove them from project-local settings.

## More Detail

- Repository: https://github.com/1aboveio/pi-better-harness
- Detailed notes: https://github.com/1aboveio/pi-better-harness/blob/main/packages/pi-better-harness/docs/usage.md
- License: https://github.com/1aboveio/pi-better-harness/blob/main/LICENSE
