# pi-better-harness

`pi-better-harness` is a Pi meta package that installs the core Pi Better Harness extensions for delegated subagents, durable background tasks, and goal tracking.

## Quick Answer

Use `pi-better-harness` when you want the full background-work set for Pi. It manages:

- `pi-better-subagents` for detached, sandboxed subagent runs.
- `pi-better-background-tasks` for durable shell tasks and watchers.
- `pi-better-goal` for objective tracking that is aware of background work.

`pi-better-read-aloud` is intentionally not included yet.

## Screenshots

<p><img src="https://raw.githubusercontent.com/1aboveio/pi-better-harness/main/docs/images/package-gallery/pi-better-harness.png" alt="pi-better-harness rendered in Pi" width="49%" /><img src="https://raw.githubusercontent.com/1aboveio/pi-better-harness/main/docs/images/package-gallery/overview/pi-better-harness.png" alt="pi-better-harness package overview" width="49%" /></p>

## Install

Install the three extensions as standalone Pi packages, so Pi displays and manages each by its own package name:

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

## When To Use

Use the installer when you want all three core extensions with standalone package identities. Install an individual package instead when you only need subagents, shell task supervision, or goal tracking.

## Compatibility

| Requirement | Support |
|-------------|---------|
| Pi | Required |
| Recommended install | `npx pi-better-harness install` |
| Development runtime | Node.js 22+ |

## Update Or Remove

Remove all three standalone packages:

```sh
npx pi-better-harness uninstall
```

Add `--local` to remove them from project-local settings.

## More Detail

- Repository: https://github.com/1aboveio/pi-better-harness
- Detailed notes: https://github.com/1aboveio/pi-better-harness/blob/main/packages/pi-better-harness/docs/usage.md
- License: https://github.com/1aboveio/pi-better-harness/blob/main/LICENSE
