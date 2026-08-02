# pi-better-harness

Pi Better Harness is a small set of Pi extensions for keeping long-running work
observable while the foreground agent stays responsive.

The npm package `pi-better-harness` is a meta package. Installing it loads the
three core extensions:

| Package | Purpose |
| ------- | ------- |
| `pi-better-subagents` | Launch detached `pi -p` subagents, inspect their output, and receive completion callbacks. |
| `pi-better-background-tasks` | Run durable shell tasks and command watchers without blocking the current turn. |
| `pi-better-goal` | Track the current objective and keep Pi aware of active background work. |

`pi-better-read-aloud` lives in this repo but is intentionally not part of the
meta package yet.

## Install

Install the full harness through Pi:

```sh
pi install npm:pi-better-harness
```

Install only one extension when you do not want the full bundle:

```sh
pi install npm:pi-better-subagents
pi install npm:pi-better-background-tasks
pi install npm:pi-better-goal
```

For a temporary one-off run without changing Pi settings:

```sh
pi -e npm:pi-better-harness
```

## Packages

This repository is a private npm workspace. The root package is not published.
The publishable packages are:

| Workspace | npm package | Included in meta package |
| --------- | ----------- | ------------------------ |
| `packages/pi-better-harness` | `pi-better-harness` | yes |
| `packages/pi-better-subagents` | `pi-better-subagents` | yes |
| `packages/pi-better-background-tasks` | `pi-better-background-tasks` | yes |
| `packages/pi-better-goal` | `pi-better-goal` | yes |
| `packages/pi-better-read-aloud` | `pi-better-read-aloud` | not yet |
| `packages/navigator` | internal workspace | no |

All four publishable packages carry the `pi-package` npm keyword. The bundle is
the recommended install for most users, and the component packages remain
available for people who want only one extension.

## Development

Use Node.js 22 or newer.

```sh
npm install
npm run verify
```

Useful narrower checks:

```sh
npm run typecheck
npm test
npm run test:cross-session
```

## Local Pi Development

Pi can load this repo directly from the root `pi.extensions` manifest:

```sh
pi install .
```

For a temporary run:

```sh
pi -e .
```

You can also install individual workspace directories while iterating:

```sh
pi install ./packages/pi-better-subagents
pi install ./packages/pi-better-background-tasks
pi install ./packages/pi-better-goal
```

## Release Checklist

Packages are versioned and published independently. A release changes only the
manifest for the package being released. When a component package changes, bump
`pi-better-harness` separately only if the meta package should bundle that new
component version. Release changed components before releasing the meta package.

Start from a clean, up-to-date `main` branch:

```sh
git switch main
git pull --ff-only origin main
git status --short
```

Verify the workspace and the package being released:

```sh
npm run verify
npm publish --dry-run -w packages/pi-better-goal --registry=https://registry.npmjs.org/
```

Add package-scoped notes to `CHANGELOG.md`; independent packages can use the
same semantic version without colliding:

```md
## [pi-better-goal@0.1.15] - 2026-08-02

### Fixed

- Description of the released Goal change.
```

Commit the manifest, lockfile, and changelog changes through the normal PR and
merge queue. After merge, dispatch `.github/workflows/publish.yml` and select the
single npm package to release. The workflow reads the version from that package's
manifest, publishes only its workspace, and creates a package-scoped tag and
GitHub release such as `pi-better-goal@0.1.15`.

Confirm that package is visible:

```sh
npm view pi-better-goal version --registry=https://registry.npmjs.org/
```

The explicit registry flag matters on machines whose npm registry is configured
to a mirror.

Smoke-test the released package's install path:

```sh
pi install npm:pi-better-goal
```

Pi's package gallery discovers npm packages tagged with the `pi-package` keyword.
After npm publish, the bundle and the three component packages are all eligible
to appear there.

The publish workflow creates the package-scoped Git tag and GitHub release after
npm verification succeeds.
