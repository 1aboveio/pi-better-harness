# pi-better-harness

Monorepo for three Pi extension packages:

- `packages/pi-better-subagents`
- `packages/pi-better-background-tasks`
- `packages/pi-better-goal`

The root package exposes all three extension entrypoints through its `pi.extensions` manifest, so it can be installed as one Pi package. For local development, symlink the package directories into `~/.pi/agent/extensions/` and run `/reload` in Pi.

## Development

```sh
npm install
npm run typecheck
npm test
```

## Local Pi Links

```sh
ln -sfn "$PWD/packages/pi-better-subagents" ~/.pi/agent/extensions/pi-better-subagents
ln -sfn "$PWD/packages/pi-better-background-tasks" ~/.pi/agent/extensions/pi-better-background-tasks
ln -sfn "$PWD/packages/pi-better-goal" ~/.pi/agent/extensions/pi-better-goal
```