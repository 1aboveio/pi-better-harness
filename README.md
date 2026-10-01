# Pi Better Harness

`pi-better-harness` is a Pi extension bundle for an opt-in foreground write sandbox, delegated subagents, durable background shell tasks, synchronous SSH commands, goal tracking, and structured plans.

## Quick Answer

Use Pi Better Harness when a Pi session needs to keep moving while related work runs elsewhere. Install every harness extension as a standalone Pi package with `npx pi-better-harness install`, or install only the individual extension you need.

## Install The Whole Harness

Install every harness extension with a standalone package identity:

```sh
npx pi-better-harness install
```

Remove them all with `npx pi-better-harness uninstall`. Add `--local` to either command for project-local Pi settings.

Install only one part:

```sh
pi install npm:pi-better-sandbox
pi install npm:pi-better-subagents
pi install npm:pi-better-background-tasks
pi install npm:pi-better-ssh
pi install npm:pi-better-goal
pi install npm:pi-better-plan
```

The backward-compatible bundled installation remains available:

```sh
pi install npm:pi-better-harness
```

## Minimal Tool Output

With the bundled harness (`pi install npm:pi-better-harness`), use
`/tool-output minimal` to keep the conversation readable. A tool run stays
visible while it is the latest thing on screen. Once later model text is
written, that run — every tool call and result between model texts — folds
into one line such as `▸ 4 tools · read ×2, bash`. The live run at the bottom
stays open, with result bodies hidden. Extension and MCP calls fold the same
way. The agent still receives the complete result; execution, sandboxing,
paging, and execution defaults are unchanged.

`/tool-output normal` restores each tool's ordinary renderer; `/tool-output`
toggles between the two modes. Ctrl+O unfolds runs and reveals results. On a
Pi build with clickable rows, click a folded line to open that run, and click
again to fold it. The preference is saved in the current session and restored
on resume/reload; new sessions start in normal mode.

This is an **internal TUI adapter**, tested with Pi 0.82.1 and 0.99.1, not a
public renderer API. Future Pi upgrades may require adapter changes. An
incompatible display API leaves ordinary output enabled and reports a warning.
It does not apply to print/RPC mode or exported transcripts.

The standalone-package installer does not install this bundled extension.
To load it directly from a checkout:

```sh
pi -e ./packages/pi-better-harness/extensions/minimal-output/index.ts
```

## When To Use

Use this repo when you want Pi to delegate independent work, supervise long shell commands, or keep an explicit objective open until background work has drained.

Do not use the bundle when you only need one extension; install that package directly instead.

## Packages

- `pi-better-sandbox`: an opt-in write sandbox for Pi's foreground tools.
- `pi-better-subagents`: detached, sandboxed subagent runs.
- `pi-better-background-tasks`: durable shell tasks, watchers, logs, and status inspection.
- `pi-better-ssh`: safe synchronous remote commands over reusable SSH connections.
- `pi-better-goal`: objective tracking with background-aware continuation.
- `pi-better-plan`: persistent structured execution plans with explicit progress.

`pi-better-read-aloud` lives in this repo but is not published or included in the meta package yet.

## Compatibility

| Requirement | Support |
|-------------|---------|
| Pi | Required |
| Install method | `pi install npm:...` |
| Development runtime | Node.js 22+ |

## Development

Use Node.js 22 or newer.

```sh
npm install
npm run verify
```

Load this checkout directly in Pi while developing:

```sh
pi -e .
```

## Docs

- [Development and release notes](docs/development-and-release.md)
- [Write sandbox details](packages/pi-better-sandbox/README.md)
- [Subagents details](packages/pi-better-subagents/docs/usage.md)
- [Background tasks details](packages/pi-better-background-tasks/docs/usage.md)
- [SSH details](packages/pi-better-ssh/README.md)
- [Goal details](packages/pi-better-goal/docs/usage.md)
- [Plan details](packages/pi-better-plan/README.md)
- [License](LICENSE)
