# pi-better-goal

`pi-better-goal` is a Pi extension for goal tracking with background-aware continuation.

## Quick Answer

Use `pi-better-goal` when a Pi session should keep an explicit objective visible until the foreground work and registered background activity are both done. It tracks active versus elapsed time and wakes the foreground when background work drains.

## Screenshots

<p><img src="https://raw.githubusercontent.com/1aboveio/pi-better-harness/main/docs/images/package-gallery/pi-better-goal.png" alt="pi-better-goal rendered in Pi" width="49%" /><img src="https://raw.githubusercontent.com/1aboveio/pi-better-harness/main/docs/images/package-gallery/overview/pi-better-goal.png" alt="pi-better-goal package overview" width="49%" /></p>

## Core Features

- `/goal` runtime for starting, pausing, resuming, completing, and clearing the current objective.
- `/goal settings` opens an interactive settings page in the TUI. Select a row with Up/Down and toggle with Space/Enter; changes save immediately, and Escape closes the page. All three controls default to `on`. Automatic continuation controls idle and background-drain wakes; conversational resume controls the agent's Escape-pause resume tool; **Pause on Esc** controls whether editor Escape pauses the active goal. Goal kickoff, `/goal resume`, and `alt+g` remain available with these controls off. For scripts or non-interactive sessions, use `/goal settings auto-continue on|off`, `/goal settings conversational-resume on|off`, and `/goal settings pause-on-escape on|off`; bare `/goal settings` prints the saved values outside the TUI.
- `escape` pauses the active goal by default, and it stays paused while you talk to the agent. With **Pause on Esc** off, observed editor Escape leaves the goal active while preserving native streaming interruption and menu/dialog cancellation. Automatic continuation remains independent. Hosts without terminal/focus inspection and unknown custom editors retain generic abort-to-pause behavior because they cannot identify Escape reliably. With conversational resume enabled, say "go" (the agent then calls `goal_resume`), or use `/goal resume` or `alt+g`. `/goal pause` resumes only through `/goal resume` or `alt+g`. The status line shows the available resume path, and paused goals are never poked. On a macOS terminal without Option-as-Meta, `alt+g` types `©`; use `/goal resume` there.
- Background work that finishes while an `ask_user_question` is pending is handed to the agent right after the answer.
- A compact goal widget that does not replace Pi's footer.
- Background activity tracking for subagents and other registered providers.
- A progress-aware follow-up loop with ten identical no-progress retries and linear backoff (60s through 600s by default), followed by a hold recoverable with `/goal resume`. Delays saturate at Node's timer limit, and observed background drains reset progress before callback turns can cancel the wake. Pi's network retry policy remains independent.
- An observable-progress stall state for active goals.

## Skill-Owned Workflows

Skills that own execution and their own task plan can opt in through `SKILL.md` frontmatter:

```yaml
metadata:
  workflow-role: coordinator
```

Invoke the skill with Pi's `/skill:name` command, or supervise it with `/goal /skill:name task`. The goal extension resolves the command against Pi's registry, persists its source, and expands the skill on kickoff and continuation (including after session resume). A bound command that disappears or changes source pauses the goal. `/goal /template task` also re-expands prompt templates on continuation; `/goal /extension-command task` dispatches the extension command once, then continues with ordinary goal supervision to avoid repeating side effects. Plain-language goals work as before. This command binding requires Pi 0.84.4 or later. Legacy slash-shaped goals without a binding pause on resume rather than running without the skill. `/workflow` shows a coordinator skill owner; call `release_workflow` after the workflow's completion audit (or use `/workflow clear` to release it manually). Completing an active goal also releases ownership.

A skill that is only an alias of a coordinator declares the target instead of a role:

```yaml
metadata:
  workflow-alias-of: rush-issues
```

Invoking the alias (`/skill:resolve-issues`, or `/goal /skill:resolve-issues task`) records the target coordinator, with the target's registered path, as the workflow owner, so its task plan, continuation instructions, and plan tools behave exactly as if the target had been invoked. The target must be a registered `workflow-role: coordinator` skill; an unregistered target, a non-coordinator target, or a chain of aliases is refused with a notice.

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
