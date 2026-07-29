# pi-better-harness

Monorepo for the Pi Better Harness extension packages:

- `packages/pi-better-subagents`
- `packages/pi-better-background-tasks`
- `packages/pi-better-goal`
- `packages/pi-better-harness`

The publishable meta package is `pi-better-harness`. It depends on the three
core extension packages and exposes their entrypoints through its `pi.extensions`
manifest. `@1aboveio/pi-better-read-aloud` is not included yet.

## Install

```sh
pi install npm:pi-better-harness
```

Individual packages can also be installed directly:

```sh
pi install npm:@1aboveio/pi-better-subagents
pi install npm:@1aboveio/pi-better-background-tasks
pi install npm:@1aboveio/pi-better-goal
```

## Development

```sh
npm install
npm run typecheck
npm test
```

## Publish

```sh
npm publish -w packages/pi-better-background-tasks
npm publish -w packages/pi-better-subagents
npm publish -w packages/pi-better-goal
npm publish -w packages/pi-better-harness
```

Publish the individual packages before the meta package so its dependencies are
available from the npm registry.

## Local Pi Links

```sh
ln -sfn "$PWD/packages/pi-better-subagents" ~/.pi/agent/extensions/pi-better-subagents
ln -sfn "$PWD/packages/pi-better-background-tasks" ~/.pi/agent/extensions/pi-better-background-tasks
ln -sfn "$PWD/packages/pi-better-goal" ~/.pi/agent/extensions/pi-better-goal
```