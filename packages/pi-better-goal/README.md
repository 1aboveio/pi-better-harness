# pi-better-goal

`pi-better-goal` is a Pi extension for goal tracking with background-aware continuation.

## Quick Answer

Use `pi-better-goal` when a Pi session should keep an explicit objective visible until the foreground work and registered background activity are both done. It tracks active versus elapsed time and wakes the foreground when background work drains.

## Screenshots

<p><img src="https://raw.githubusercontent.com/1aboveio/pi-better-harness/main/docs/images/package-gallery/pi-better-goal.png" alt="pi-better-goal rendered in Pi" width="49%" /><img src="https://raw.githubusercontent.com/1aboveio/pi-better-harness/main/docs/images/package-gallery/overview/pi-better-goal.png" alt="pi-better-goal package overview" width="49%" /></p>

## Core Features

- `/goal` runtime for starting, pausing, resuming, completing, and clearing the current objective.
- `escape` pauses the active goal; paused goals are never poked.
- A compact goal widget that does not replace Pi's footer.
- Background activity tracking for subagents and other registered providers.
- A progress-aware follow-up loop that holds after repeated identical outcomes.
- An observable-progress stall state for active goals.

## Skill-Owned Workflows

Skills that own execution and their own task plan can opt in through `SKILL.md` frontmatter:

```yaml
metadata:
  workflow-role: coordinator
```

Invoke the skill with Pi's `/skill:name` command, or supervise it with `/goal /skill:name task`. The goal extension resolves the command against Pi's registry, persists its source, and expands the skill on kickoff and continuation (including after session resume). A bound command that disappears or changes source pauses the goal. `/goal /template task` also re-expands prompt templates on continuation; `/goal /extension-command task` dispatches the extension command once, then continues with ordinary goal supervision to avoid repeating side effects. Plain-language goals work as before. This command binding requires Pi 0.84.4 or later. Legacy slash-shaped goals without a binding pause on resume rather than running without the skill. `/workflow` shows a coordinator skill owner; call `release_workflow` after the workflow's completion audit (or use `/workflow clear` to release it manually). Completing an active goal also releases ownership.

When `pi-better-plan` is installed, it defers its prompt, checklist, and `update_plan` tool to a skill-owned task plan. Skills without this metadata retain normal goal and plan behavior. The skill itself owns its planning format and worker policy; the harness does not enumerate skills or impose a shared workflow schema. The former `pi-better-plan-workflow: coordinator` metadata remains supported for installed skills.

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
