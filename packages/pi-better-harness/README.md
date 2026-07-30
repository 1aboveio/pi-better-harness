# pi-better-harness

Meta package for the core Pi Better Harness extensions.

Install it once to load:

- `pi-better-subagents` for detached, sandboxed subagent runs.
- `pi-better-background-tasks` for durable shell tasks and watchers.
- `pi-better-goal` for objective tracking that is aware of background work.

`pi-better-read-aloud` is intentionally not included yet.

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

## Update Or Remove

```sh
pi update npm:pi-better-harness
pi remove npm:pi-better-harness
```

## More Detail

- Repository: https://github.com/1aboveio/pi-better-harness
- Detailed notes: https://github.com/1aboveio/pi-better-harness/blob/main/packages/pi-better-harness/docs/usage.md
