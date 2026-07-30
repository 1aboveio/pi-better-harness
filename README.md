# Pi Better Harness

`pi-better-harness` is a Pi extension bundle for delegated subagents, durable background shell tasks, and goal tracking that stays aware of background work.

## Quick Answer

Use Pi Better Harness when a Pi session needs to keep moving while related work runs elsewhere. Install the bundle with `pi install npm:pi-better-harness`, or install only the individual extension you need.

## Install The Bundle

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

## When To Use

Use this repo when you want Pi to delegate independent work, supervise long shell commands, or keep an explicit objective open until background work has drained.

Do not use the bundle when you only need one extension; install that package directly instead.

## Packages

- `pi-better-subagents`: detached, sandboxed subagent runs.
- `pi-better-background-tasks`: durable shell tasks, watchers, logs, and status inspection.
- `pi-better-goal`: objective tracking with background-aware continuation.

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
- [Subagents details](packages/pi-better-subagents/docs/usage.md)
- [Background tasks details](packages/pi-better-background-tasks/docs/usage.md)
- [Goal details](packages/pi-better-goal/docs/usage.md)
- [License](LICENSE)
