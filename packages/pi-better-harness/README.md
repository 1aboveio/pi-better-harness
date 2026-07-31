# pi-better-harness

`pi-better-harness` is a Pi meta package that installs the core Pi Better Harness extensions for delegated subagents, durable background tasks, and goal tracking.

## Quick Answer

Use `pi-better-harness` when you want the full background-work bundle for Pi in one install. It loads:

- `pi-better-subagents` for detached, sandboxed subagent runs.
- `pi-better-background-tasks` for durable shell tasks and watchers.
- `pi-better-goal` for objective tracking that is aware of background work.

`pi-better-read-aloud` is intentionally not included yet.

## Screenshots

<p><img src="https://raw.githubusercontent.com/1aboveio/pi-better-harness/main/docs/images/package-gallery/pi-better-harness.png" alt="pi-better-harness rendered in Pi" width="49%" /><img src="https://raw.githubusercontent.com/1aboveio/pi-better-harness/main/docs/images/package-gallery/overview/pi-better-harness.png" alt="pi-better-harness package overview" width="49%" /></p>

## Install

```sh
pi install npm:pi-better-harness
```

Try it for one run without saving it to Pi settings:

```sh
pi -e npm:pi-better-harness
```

## Install Individual Packages

```sh
pi install npm:pi-better-subagents
pi install npm:pi-better-background-tasks
pi install npm:pi-better-goal
```

## When To Use

Use this package when you want all three core extensions loaded together. Install an individual package instead when you only need subagents, shell task supervision, or goal tracking.

## Compatibility

| Requirement | Support |
|-------------|---------|
| Pi | Required |
| Install method | `pi install npm:pi-better-harness` |
| Development runtime | Node.js 22+ |

## Update Or Remove

```sh
pi update npm:pi-better-harness
pi remove npm:pi-better-harness
```

## More Detail

- Repository: https://github.com/1aboveio/pi-better-harness
- Detailed notes: https://github.com/1aboveio/pi-better-harness/blob/main/packages/pi-better-harness/docs/usage.md
- License: https://github.com/1aboveio/pi-better-harness/blob/main/LICENSE
