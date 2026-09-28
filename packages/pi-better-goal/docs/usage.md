# pi-better-goal

`pi-better-goal` is a Pi package that provides a `/goal` runtime with background-aware continuation for async subagents.

It ships one extension that:

- reads `pi-better-subagents` durable run metadata from the temp registry
- treats current-parent `running` and `orphaned` subagents as active background work
- owns `/goal` plus the `get_goal` and `update_goal` tools; only `/goal <objective>` can create a goal
- shows the current goal with active and elapsed clocks in a right-aligned widget above custom footers such as `pi-observability`
- pauses the active goal on `escape` (while still interrupting a running agent turn), keeps it paused while you talk to the agent, resumes it on a clear go-ahead, and never pokes a paused goal
- tells the agent, right after a blocking `ask_user_question` is answered, which background work finished while the question was pending
- publishes a typed activity snapshot on `pi.events`
- adds goal-aware prompt context while background work is active, so foreground idleness is not confused with goal completion
- sends a hidden follow-up when active background work drains to zero, including `callback:false` subagent runs
- provides a `/better-activity` command and `get_background_activity` tool for inspection

Goal state is stored as `pi-better-goal` custom entries in the Pi session. Existing `pi-codex-goal` entries are read for compatibility, but new state is written by this package.

## Commands And Tools

```text
/goal
/goal <objective>
/goal /skill:name <objective>
/goal /template <objective>
/goal pause
/goal resume
/goal clear
/goal complete
/better-activity
```

Model-callable tools:

- `get_goal`
- `update_goal`
- `goal_resume` (only while a goal is paused by `escape`)
- `get_background_activity`

## Pause With Escape

Press `escape` to pause the active goal. The goal moves to `paused`, its
active clock stops, and any pending or future automatic continuation pokes
are cancelled: a paused goal is never poked. While the agent is still
streaming, `escape` also interrupts the turn, preserving its built-in
meaning. `escape` without an active goal does nothing.

A paused goal stays paused while you talk. Your messages are ordinary
conversation: the agent answers questions and discusses options, but the
goal's work loop does not restart. Anything else that aborts the running turn,
such as `/compact` while streaming or switching sessions, pauses the same way.
The status line shows `goal paused · say "go" or /goal resume`.

To resume an `escape` pause, say so plainly ("go", "continue", "ok do it",
"approved, proceed"), or answer a decision the agent explicitly asked you for.
While the goal is paused, the agent has a `goal_resume` tool and is told to
call it only for such a clear go-ahead, never for questions, "why...", "what
about...", "let me think", or discussion. `goal_resume` resumes exactly as
`/goal resume` does. You can always resume yourself with `/goal resume` or the
`alt+g` hotkey. On a macOS terminal without Option-as-Meta, `alt+g` types `©`
instead; use `/goal resume` there.

To stop the loop until you say otherwise, use `/goal pause`. Only you can undo
it, with `/goal resume` or `alt+g`: the agent's `goal_resume` refuses it, and
its status line reads `goal paused · /goal resume`. A goal paused because its
bound command or workflow is unavailable follows the same rule. A later
`escape` never softens an explicit pause. Pi's built-in commands (`/settings`, `/model`, `/session`,
and so on) and extension commands never change goal state; note that Pi only
recognizes a built-in by its exact text, so `/settings session` is sent to the
model as an ordinary message.

## Blocking Questions And Background Work

A blocking question tool such as `ask_user_question` holds the whole turn until
the user answers. Background completions that arrive meanwhile cannot reach the
agent: Pi drains steering messages only after the tool batch, and subagent
callback batches are follow-ups that wait for the entire run. When a question
that started while background work was running is answered, the extension
steers one hidden message into the same turn listing the work that finished
while the question was pending, so the agent harvests it together with the
answer instead of after the rest of the run. While the question is open the
status area shows `N background done; waiting on your answer`. When background
work is running at the start of a turn, the prompt context also tells the
agent to harvest finished results before asking and to ask only when the
answer is needed.

## Goal Clock

Only `/goal <objective>` can create or replace a goal; there is no model-callable
goal creation tool. The right-aligned widget below the editor shows the objective,
status, active time, and total elapsed time. Multiline objectives stay intact in
stored state and `/goal` inspection, but the rail flattens them to one terminal
row so dock height stays stable. Active time stops while paused. Both clocks
freeze when the goal is completed and remain visible until the goal is cleared
or replaced.

The widget does not replace Pi's footer, so custom footer extensions such as
`pi-observability` retain ownership of their layout and lifecycle.

Setting or clearing a goal while the agent is streaming avoids chat `notify`
lines and confirm dialogs (both reflow the main-screen dock and can stack
`Working...` / bash `Elapsed` frames into scrollback). Mid-stream feedback goes
to the footer status instead, and height transitions force a full TUI redraw so
differential paints stay aligned.

Set `PI_BETTER_GOAL_DISABLE_WAKE=1` to disable hidden background-drain wakeups.

## Progress-Aware Continuation

An active goal remains self-sustaining: after an idle foreground turn, the
extension schedules a hidden continuation after the configured grace period.
It records a durable per-goal continuation state in the session so repeated
turns remain bounded across extension reloads and session resumes.

The extension fingerprints each completed turn from its tool names and
canonicalized arguments, tool results, and final assistant text. Call IDs,
timestamps, reasoning, usage, and provider metadata do not affect the
fingerprint. Only the SHA-256 digest and tool-name summary are persisted; raw
arguments and results are not copied into extension state.

When a turn produces the same fingerprint as the prior autonomous turn, it
counts as a no-progress retry. By default, the original turn plus ten
identical retries are allowed. Retries back off linearly: each identical
outcome waits one more grace period than the last (30s, 60s, 90s, and so on
with the default grace period). The next identical outcome keeps the goal
active but holds further automatic continuations and reports `waiting: no
progress` in the status area. It never marks the goal complete.

Any changed result, an interactive user input, `/goal resume`, or a
background-drained wake resets the retry ledger. Configure the number of
identical retries after the initial outcome with:

```sh
PI_BETTER_GOAL_MAX_NO_PROGRESS_RETRIES=10
```

Set it to `0` to hold after the first repeated identical outcome. Invalid or
negative values fall back to the default.

## Observable Progress

`get_goal` reports `Observable progress: healthy`, `quiet`, or `stalled` for
an active goal. Changed foreground evidence, interactive input, and a
background-drain transition advance its progress anchor. A running foreground
turn or active background work can be quiet but is not reported as stalled.

The shared defaults are quiet after 60 seconds and stalled after 5 minutes.
Set `PI_BETTER_STALL_QUIET_MS` and `PI_BETTER_STALL_MS` in milliseconds to
override them across the harness extensions.

## Install Locally

From this directory:

```sh
npm install
pi install .
```

For a one-off run:

```sh
pi -e .
```

## Event Contract

The extension emits these events on `pi.events`:

- `pi-better-goal:ready` with `{ version }`
- `pi-better-goal:activity` with an `ActivitySnapshot`
- `pi-better-goal:terminal-attention` when terminal or unhealthy background work needs attention

Other extensions can register providers by emitting `pi-better-goal:register-provider` with:

```ts
{
  id: "provider-id",
  label: "Provider label",
  getActivity(ctx) {
    return {
      providerId: "provider-id",
      label: "Provider label",
      items: [
        { id: "work-1", status: "running", active: true }
      ]
    };
  }
}
```

The built-in provider id is `subagents`.

## Status Semantics

For `pi-better-subagents`, active background work is:

- `running`
- `orphaned`

`orphaned` is active but unhealthy. `completed`, `failed`, `killed`, `lost`, and `exited` are non-active terminal states. Batches are represented as normal per-run items; batch metadata is display-only.

## Validation

```sh
npm run verify
```