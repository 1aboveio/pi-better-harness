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

Start from a clean, up-to-date `main` branch:

```sh
git switch main
git pull --ff-only origin main
git status --short
```

Verify the workspace and npm package contents:

```sh
npm run verify
npm publish --dry-run -w packages/pi-better-background-tasks --registry=https://registry.npmjs.org/
npm publish --dry-run -w packages/pi-better-subagents --registry=https://registry.npmjs.org/
npm publish --dry-run -w packages/pi-better-goal --registry=https://registry.npmjs.org/
npm publish --dry-run -w packages/pi-better-harness --registry=https://registry.npmjs.org/
```

Publish the dependency packages before the meta package:

```sh
npm publish -w packages/pi-better-background-tasks --registry=https://registry.npmjs.org/
npm publish -w packages/pi-better-subagents --registry=https://registry.npmjs.org/
npm publish -w packages/pi-better-goal --registry=https://registry.npmjs.org/
npm publish -w packages/pi-better-harness --registry=https://registry.npmjs.org/
```

The explicit registry flag matters on machines whose npm registry is configured
to a mirror.

Confirm the packages are visible:

```sh
npm view pi-better-background-tasks version --registry=https://registry.npmjs.org/
npm view pi-better-subagents version --registry=https://registry.npmjs.org/
npm view pi-better-goal version --registry=https://registry.npmjs.org/
npm view pi-better-harness version --registry=https://registry.npmjs.org/
```

Smoke-test the install path:

```sh
pi install npm:pi-better-harness
```

Then create the matching GitHub release:

```sh
gh release create v0.1.0 \
  --title "v0.1.0" \
  --notes "Initial npm release of Pi Better Harness.

Install:
\`\`\`sh
pi install npm:pi-better-harness
\`\`\`

Packages:
- pi-better-harness
- pi-better-subagents
- pi-better-background-tasks
- pi-better-goal

pi-better-read-aloud is intentionally not included yet."
```
