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
- A progress-aware follow-up loop with ten identical no-progress retries and linear backoff (60s through 600s by default), followed by a sticky hold recoverable with `/goal resume` or `alt+g`. Conversation, changed callback results, and background drains do not reopen an exhausted hold. Delays saturate at Node's timer limit, and observed background drains reset non-held progress before callback turns can cancel the wake. Pi's network retry policy remains independent.
- An observable-progress stall state for active goals.

## Optional Harness-Owned Outcome & Todo

When `pi-better-harness` is installed, its optional **Outcome & Todo** runtime owns the session's structured outcome and checklist. Goal keeps its own objective, clocks, pause and permission holds, workflow gates, background wake behavior, and continuation policy; it also sends lifecycle requests to the Harness runtime so a bound outcome starts, pauses, resumes, and completes with the Goal. When the runtime is present, Goal stops adding its own active-objective text to avoid duplicating the Harness-owned outcome, whether Outcome & Todo is enabled or off.

`/goal` does not install, enable, or configure Outcome & Todo. Install Harness and enable **Outcome & Todo** in `/harness-settings` if you want that shared outcome and checklist. Without Harness, this package keeps its standalone prompts and behavior unchanged. The stored Goal objective remains the raw original trigger (for example, a bound command invocation) so `/goal resume` can re-enter the work; it is not the authoritative business outcome when Harness owns one.

## Settings Storage

Goal preferences are saved only in Pi's global `~/.pi/agent/settings.json` under
`piBetterHarness.goal` (or `$PI_CODING_AGENT_DIR/settings.json` when overridden).
The payload retains `version: 1` and the boolean `autoContinue`,
`conversationalResume`, and `pauseOnEscape` fields; omitted controls default to
`true`. Updates preserve other Pi settings and other `piBetterHarness` keys.

On first read, an existing `extensions/pi-better-goal-preferences.json` in the
agent directory is validated and migrated when the global Goal key is absent.
An existing global key is authoritative, and subsequent changes write only
`settings.json`. Invalid preferences report an error instead of being replaced
with defaults.

## Skill-Owned Workflows

Skills that own execution and their own task plan can opt in through `SKILL.md` frontmatter:

```yaml
metadata:
  workflow-role: coordinator
```

Invoke the skill with Pi's `/skill:name` command, or supervise it with `/goal /skill:name task`. The goal extension resolves the command against Pi's registry, persists its source, and expands the skill on kickoff and continuation (including after session resume). A bound command that disappears or changes source pauses the goal. `/goal /template task` also re-expands prompt templates on continuation; `/goal /extension-command task` dispatches the extension command once, then continues with ordinary goal supervision to avoid repeating side effects. Plain-language goals work as before. This command binding requires Pi 0.84.4 or later. Legacy slash-shaped goals without a binding pause on resume rather than running without the skill. `/workflow` shows a coordinator skill owner. When the workflow is done, complete the goal (`update_goal`), which also releases ownership. When it hands back unfinished work, call `release_workflow`, or use `/workflow clear` to release ownership manually. `release_workflow` also pauses an active Goal bound to that coordinator as a handback, preserving its objective and incomplete status. Resuming that Goal (`/goal resume`, `alt+g`, or, with conversational resume on, the user's go-ahead such as "continue") rebinds the coordinator it was created with, provided the skill is still registered at its original source; automatic continuation and synthetic input never reacquire ownership. Unrelated ordinary Goals are unchanged.

A skill that is only an alias of a coordinator declares the target instead of a role:

```yaml
metadata:
  workflow-alias-of: rush-issues
```

Invoking the alias (`/skill:resolve-issues`, or `/goal /skill:resolve-issues task`) records the target coordinator, with the target's registered path, as the workflow owner, so its task plan, continuation instructions, and plan tools behave exactly as if the target had been invoked. The target must be a registered `workflow-role: coordinator` skill; an unregistered target, a non-coordinator target, or a chain of aliases is refused with a notice.

After every successful context compaction (Pi's `session_compact` event) while a coordinator owns the session, the goal extension re-injects the skill so the model sees it before its next step; the compaction summary keeps run state but not the skill's rules, and the summary itself is left unchanged. If the skill directory ships `scripts/rehydrate.mjs` (checked first) or `rehydrate.mjs`, it runs as `node <script> --cwd <session cwd>` (no shell, 10-second timeout, stderr ignored) and its trimmed stdout becomes the message; empty output injects nothing, so the script decides whether a run is in progress. Without a script, or when it fails or times out, the message is: "Your context was just compacted while you coordinate the `<name>` workflow. Before your next step, read `<SKILL.md path>` in full, with no line limit." The message is a `workflow-rehydrate` custom message: inside a running agent loop (or before an overflow retry) it steers the next model call; otherwise it is appended without starting a turn.

### Scheduler-backed workflow gates

A coordinator that ships the resolve-issues scheduler (`scripts/next-actions.mjs` in its skill directory, or in a sibling `resolve-issues` skill) keeps its Goal from ending while the run still has work. The extension first runs `node next-actions.mjs --run <run dir> --slots 1 --peek --json` (read-only, 20-second timeout), where the run directory is the folder of the task plan bound through `update_plan`. For completion and handback only, if the sole due action is `sync`, it reruns with `--sync` to obtain a fresh issue tree. This live check has a four-minute timeout to accommodate the tree fetcher's network attempts and follow-ups. Because `--peek` suppresses scheduler bookkeeping but not issue-tree cache writes, the live check uses a temporary copy of the scheduler's plan, tree, bookkeeping, review, and result inputs; it does not write the bound run. Heartbeat probes never request live synchronization. A failed or incomplete tree fetch that produces `sync` still refuses completion or handback; cached evidence is not treated as live. Every gate retains its fail-open behavior for execution failures: if the scheduler is missing, errors, times out, prints bad output, or no plan is bound yet, the call proceeds and its result carries a warning, so nothing deadlocks.

- **Completion.** `update_goal` complete is refused, with each due action (action, unit, first 200 characters of detail), unless the scheduler reports `finish` and nothing else is due (an empty due list means workers are still running, so it is refused too). The Goal stays active.
- **Pause.** `release_workflow` is refused unless every unfinished unit is quiet (nothing due for it) or blocked `human-decision` with `humanItem` 2-5. A unit blocked `retry-ci` or any other reason the run retries itself, or a `human-decision` item 1, is named in the refusal and the Goal stays active.
- **Auto-bind.** Invoking `/skill:rush-issues` or `/skill:resolve-issues` with no active goal (none, or a completed one) creates and activates a Goal whose objective is the invocation text, exactly as `/goal <invocation>` would, without sending the command a second time. A paused or active Goal is left alone.
- **Wait timer.** When the scheduler's only due action is `wait` with a "next automatic attempt is at <ISO time>" detail, the next automatic continuation is scheduled for that time (at most the maximum timer delay, at least 5 seconds) and the wake-up is not counted as a no-progress retry. Other due work, or an unparseable time, uses the ordinary retry schedule. `autoContinue` off disables this timer.

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
