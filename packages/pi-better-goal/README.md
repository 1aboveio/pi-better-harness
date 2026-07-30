# pi-better-goal

Goal tracking for [Pi](https://pi.dev), with background-aware continuation.

It keeps the active objective visible, tracks active versus elapsed time, and prevents Pi from treating foreground idleness as completion while background work is still running.

## Core Features

- `/goal` runtime for starting, pausing, resuming, completing, and clearing the current objective.
- A compact goal widget that does not replace Pi's footer.
- Background activity tracking for subagents and other registered providers.
- A follow-up wake when active background work drains to zero.

## Install

```sh
pi install npm:pi-better-goal
```

Try it for one run:

```sh
pi -e npm:pi-better-goal
```

## Update Or Remove

```sh
pi update npm:pi-better-goal
pi remove npm:pi-better-goal
```

## More Detail

- Repository: https://github.com/1aboveio/pi-better-harness
- Detailed notes: https://github.com/1aboveio/pi-better-harness/blob/main/packages/pi-better-goal/docs/usage.md
