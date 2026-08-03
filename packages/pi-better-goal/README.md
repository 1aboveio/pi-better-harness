# pi-better-goal

`pi-better-goal` is a Pi extension for goal tracking with background-aware continuation.

## Quick Answer

Use `pi-better-goal` when a Pi session should keep an explicit objective visible until the foreground work and registered background activity are both done. It tracks active versus elapsed time and wakes the foreground when background work drains.

## Screenshots

<p><img src="https://raw.githubusercontent.com/1aboveio/pi-better-harness/main/docs/images/package-gallery/pi-better-goal.png" alt="pi-better-goal rendered in Pi" width="49%" /><img src="https://raw.githubusercontent.com/1aboveio/pi-better-harness/main/docs/images/package-gallery/overview/pi-better-goal.png" alt="pi-better-goal package overview" width="49%" /></p>

## Core Features

- `/goal` runtime for starting, pausing, resuming, completing, and clearing the current objective.
- A compact goal widget that does not replace Pi's footer.
- Background activity tracking for subagents and other registered providers.
- A progress-aware follow-up loop that holds after repeated identical outcomes.
- An observable-progress stall state for active goals.

## Install

```sh
pi install npm:pi-better-goal
```

Try it for one run:

```sh
pi -e npm:pi-better-goal
```

## When To Use

Use this package for longer Pi sessions where subagents, background tasks, or other providers may still be active after the foreground message is idle.

Do not use it when you only need a note or checklist outside Pi's runtime state.

## Compatibility

| Requirement | Support |
|-------------|---------|
| Pi | Required |
| Install method | `pi install npm:pi-better-goal` |
| Background providers | Works with registered providers |
| Development runtime | Node.js 22+ |

## Update Or Remove

```sh
pi update npm:pi-better-goal
pi remove npm:pi-better-goal
```

## More Detail

- Repository: https://github.com/1aboveio/pi-better-harness
- Detailed notes: https://github.com/1aboveio/pi-better-harness/blob/main/packages/pi-better-goal/docs/usage.md
- License: https://github.com/1aboveio/pi-better-harness/blob/main/LICENSE
