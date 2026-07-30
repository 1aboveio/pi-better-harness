# pi-better-harness

Pi Better Harness is a small set of Pi extensions for keeping long-running work visible while the foreground agent stays responsive.

## What You Get

- `pi-better-subagents`: run delegated Pi work in detached, sandboxed child processes.
- `pi-better-background-tasks`: keep shell processes and watchers running without blocking the current turn.
- `pi-better-goal`: track the active objective and wake the foreground when background work drains.

`pi-better-read-aloud` lives in this repo but is not published or included in the meta package yet.

## Install

Install the full bundle:

```sh
pi install npm:pi-better-harness
```

Install only one part:

```sh
pi install npm:pi-better-subagents
pi install npm:pi-better-background-tasks
pi install npm:pi-better-goal
```

Try the bundle for one run without saving it to Pi settings:

```sh
pi -e npm:pi-better-harness
```

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
- [Subagents details](packages/pi-better-subagents/docs/usage.md)
- [Background tasks details](packages/pi-better-background-tasks/docs/usage.md)
- [Goal details](packages/pi-better-goal/docs/usage.md)
