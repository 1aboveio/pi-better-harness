# pi-better-goal

`pi-better-goal` is a Pi package that provides a `/goal` runtime with background-aware continuation for async subagents.

It ships one extension that:

- reads `pi-better-subagents` durable run metadata from the temp registry
- treats current-parent `running` and `orphaned` subagents as active background work
- owns `/goal` plus the `get_goal` and `update_goal` tools; only `/goal <objective>` can create a goal
- shows the current goal with active and elapsed clocks in a right-aligned widget above custom footers such as `pi-observability`
- pauses the active goal on `escape` by default (while still interrupting a running agent turn), keeps it paused while you talk to the agent, resumes it on a clear go-ahead, and never pokes a paused goal
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
/goal settings
/goal settings auto-continue on|off
/goal settings conversational-resume on|off
/goal settings pause-on-escape on|off
/better-activity
```

Model-callable tools:

- `get_goal`
- `update_goal`
- `goal_resume` (only while a goal is paused by `escape` and conversational resume is enabled)
- `get_background_activity`

## Pause With Escape

With **Pause on Esc** enabled (the default), press `escape` to pause the active goal. The goal moves to `paused`, its
active clock stops, and any pending or future automatic continuation pokes
are cancelled: a paused goal is never poked. While the agent is still
streaming, `escape` also interrupts the turn, preserving its built-in
meaning. `escape` without an active goal does nothing.

Idle and between-turn Escape is observed without consuming or rewriting the
key. Completion menus, built-in selectors, and extension dialogs/custom screens
retain Escape for cancellation and do not pause the goal. The observer is
attached at TUI session start and removed at shutdown/reload. It requires Pi's
public focused-component API (available in the supported Pi 0.84.4 runtime);
older hosts retain the existing running-turn abort fallback. Turning **Pause on Esc**
off leaves an observed editor Escape's active goal unpaused, both idle and
streaming. Pi still receives the original key and interrupts streaming normally.
Automatic continuation remains governed independently by `auto-continue`, so an
interrupted active goal can continue after its normal grace period.

For custom editors, idle Escape observation is limited to components exposing
the standard `CustomEditor.onEscape` and `isShowingAutocomplete` methods. Unknown
editors and visible overlays are left untouched. Hosts without terminal input or
focused-component inspection, non-TUI modes, and unknown custom editors cannot
reliably distinguish Escape from other abort sources. On those paths, an actual
turn abort still pauses the goal even with **Pause on Esc** off; the setting does
not disable the generic interrupt safety fallback. Menu/dialog Escape cancellation
remains unchanged.

A paused goal stays paused while you talk. Your messages are ordinary
conversation: the agent answers questions and discusses options, but the
goal's work loop does not restart. Anything else that aborts the running turn,
such as `/compact` while streaming or switching sessions, pauses the same way.
With conversational resume enabled, the status line shows
`goal paused · say "go" or /goal resume`; when disabled it shows
`goal paused · /goal resume`.

To resume an `escape` pause, say so plainly ("go", "continue", "ok do it",
"approved, proceed"), or answer a decision the agent explicitly asked you for.
With conversational resume enabled, while the goal is paused the agent has a `goal_resume` tool and is told to
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

## Persistent User Controls

All three controls default to `on`, preserving the existing behavior. `/goal settings`
opens the interactive settings page in the TUI and reports values and the
preference-file location outside the TUI, even with no goal. `/goal` and
`get_goal` also report all three values. Configure them independently:

```text
/goal settings auto-continue off
/goal settings conversational-resume off
/goal settings pause-on-escape off
```

Use `on` to enable any control again.

- `auto-continue` controls automatic idle continuation and background-drain
  wakes. Turning it off cancels a pending wake and prevents an in-flight wake
  audit from sending a continuation. The goal stays active, its clocks and
  background activity remain observable, and background drains still reset
  non-held progress ledgers. Turning it on while an active goal is idle schedules a
  continuation after its normal grace/backoff period, unless it is held for
  no progress or background work is running. It does not resume a paused goal.
- `conversational-resume` controls the model's `goal_resume` after an Escape
  pause. Turning it off removes the tool from the active tool list, refuses
  stale/direct calls, and removes the conversational resume invitation from
  the prompt and status. The agent can still answer ordinary conversation,
  but a message such as "go" cannot resume the goal. Turning it on offers the
  tool again for an Escape-paused goal; it does not resume it by itself and
  never makes an explicit `/goal pause` agent-resumable.
- `pause-on-escape` controls whether an observed editor Escape pauses the active
  goal. Off preserves native streaming interruption without pausing the goal,
  including that Escape's abort signal and aborted final assistant message.
  Its exemption is scoped to the current session, run, and goal generation and
  does not carry into later interrupts. Changing the setting does not pause or
  resume a goal. `/goal pause`, unrelated interrupts, and unavailable-command
  or workflow safety pauses still work. Completion menus and dialogs retain
  Escape cancellation with either value.

None of these settings disables `/goal <objective>` kickoff, `/goal resume`, or
`alt+g`. An explicit resume queues one continuation even when automation is off;
later idle turns still respect `auto-continue`. Question-result harvesting and
other extensions' callback delivery are unchanged.

Changes are saved atomically to
`~/.pi/agent/settings.json` under `piBetterHarness.goal`, or under
`$PI_CODING_AGENT_DIR/extensions` when set. They apply immediately in this
session and are loaded on session start/reload in other sessions. They are
user-wide preferences, not goal state or project settings. A missing file or
missing control in a version-1 file uses the enabled default. Read/validation
errors are reported without overwriting the file; the session retains its
current settings (enabled defaults for a fresh extension). A failed save
does not change the active settings.

```json
{
  "version": 1,
  "autoContinue": true,
  "conversationalResume": true,
  "pauseOnEscape": true
}
```

`PI_BETTER_GOAL_DISABLE_WAKE=1` or `PI_BETTER_EXTENSION_DISABLE_WAKE=1`
still overrides automatic wakes for the process, even with `auto-continue on`.
Inspection identifies that environment override. Neither environment switch
disables goal kickoff, explicit resume, or conversational resume.

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

For a Goal bound to a coordinator skill (including an alias), `release_workflow`
pauses the active Goal and clears coordinator ownership after the final handoff.
The objective, incomplete status, and read-only workflow plan are retained;
pending wakes are cancelled. Reinvoke the skill explicitly before `/goal resume`
to restore ownership and writable planning. Synthetic continuation messages do
not restore ownership. Releasing an unrelated workflow does not pause an ordinary
Goal.

Setting or clearing a goal while the agent is streaming avoids chat `notify`
lines and confirm dialogs (both reflow the main-screen dock and can stack
`Working...` / bash `Elapsed` frames into scrollback). Mid-stream feedback goes
to the footer status instead, and height transitions force a full TUI redraw so
differential paints stay aligned.

Use `/goal settings auto-continue off` to disable automatic wakes persistently,
or `PI_BETTER_GOAL_DISABLE_WAKE=1` for the process.

## Progress-Aware Continuation

With automatic continuation enabled, an active goal remains self-sustaining: after an idle foreground turn, the
extension schedules a hidden continuation after the configured grace period.
It records a durable per-goal continuation state in the session so repeated
turns remain bounded across extension reloads and session resumes.

The extension fingerprints each completed turn from its tool names and
canonicalized arguments and tool results. Assistant text participates only
when the turn contains no observable tool action or result: rewording a summary
of unchanged actions is not progress. Call IDs,
timestamps, reasoning, usage, and provider metadata do not affect the
fingerprint. Only the SHA-256 digest and tool-name summary are persisted; raw
arguments and results are not copied into extension state.

When a turn produces the same fingerprint as the prior autonomous turn, it
counts as a no-progress retry. By default, the original turn plus ten
identical retries are allowed. Retries back off linearly: each identical
outcome waits one more grace period than the last (60s, 120s, 180s, and so on
with the default grace period). The next identical outcome keeps the goal
active but holds further automatic continuations and reports `waiting: no
progress` in the status area. It never marks the goal complete.

Any changed result, an interactive user input, `/goal resume`, or a
background active-to-idle transition resets the retry ledger **before the
retry limit is exhausted**. Once held, conversation, changed callback results,
background drains, settings changes, and reload preserve the hold. Only
`/goal resume` or `alt+g` reopens it without replacing the objective.
`/goal resume` does not restart a non-held active or completed goal, and
`goal_resume` remains restricted to escape-paused goals.

For non-held goals, the background-drain reset is persisted as soon as the transition is observed,
even during a foreground turn or while automatic wakes are disabled. Cancelling
the delayed wake does not undo that progress. Each new active-to-idle cycle can
reset the ledger, including repeated cycles with the same task identity. Paused
goals remain paused; background activity cannot resume them. The reset is
committed before activity listeners run. Cached pre-drain evidence is invalidated;
only a fresh completed turn establishes the next baseline. Late collections and
in-flight wake audits cannot act on a replaced goal, turn, or session.

The bound applies to automatic Goal continuations, not other extensions'
callback delivery: a held Goal may still receive and inspect background results,
but those turns do not reopen its autonomous loop.

Configure the number of identical retries after the initial outcome with:

```sh
PI_BETTER_GOAL_MAX_NO_PROGRESS_RETRIES=10
```

Set it to `0` to hold after the first repeated identical outcome. Invalid or
negative values fall back to the default.

Configure the base delay with `PI_BETTER_GOAL_IDLE_CONTINUATION_DELAY_MS`.
Calculated delays saturate at Node's timer limit, 2,147,483,647 ms, so a large
base or multiplier cannot overflow into an immediate retry. A zero base keeps
immediate continuations enabled.

These are outer Goal continuations, not model-request retries. Pi completes its
own network retry loop before Goal evaluates a settled turn. Goal does not
change Pi's retry configuration or request timeouts; a new outer continuation
receives a fresh Pi retry budget.

### Permission Holds

Actionable structured permission reports from the registered parent-owned
`subagent_result` and `subagent_output` tools pause the goal with
`pauseReason: "permission-blocker"`. Goal validates only
`tool_result.details.permissionBlockers` with the shared version-1 contract.
It does not parse EPERM prose, child tool errors, or assistant claims. The
producer must be registered from the canonical entry of the subagent package,
or the known `pi-better-harness` wrapper at `extensions/subagents/index.ts`.
The wrapper must contain only the shipped literal default re-export, resolving
to the canonical subagent package entry. Arbitrary wrappers, dynamic imports,
and a familiar tool name from another extension are not sufficient. Foreground
reports are not adopted until a guarded producer establishes that transport.
The parent owns actionability: this is not escalation of every first child
tool error.

The hold has a separate append-only session history of compact blockers,
human releases, and consumed retries. Ordinary questions, unrelated background
drains, settings changes/publication, workflows, and reload do not reset it.
`get_goal` reports the hold, retained worker/policy references, and record count.
The latest references for the same logical operation replace its current
evidence, not the earlier history. Agent-reported blockers remain distinct
from runtime-observed refusals. Raw command lines and credential paths are not
copied into these records.

`/goal resume` or `alt+g` explicitly releases **one bounded retry** of the held
operation and scope, with no extra confirmation dialog. It does not grant model
permissions, erase blockers, establish success, switch execution to the
foreground, copy credentials, or change authentication. Changed worker settings
require a fresh worker using the same logical operation identity. `goal_resume`
remains interrupt-only and cannot release a permission hold. Automatic wakes
remain disabled for that goal during the released retry. An unchanged denial
re-holds immediately; settling the released turn without a new report also
returns to the hold rather than inferring recovery from unrelated success or
an unknown remote outcome. Incident recovery remains the diagnostics producer's
separate responsibility. Existing explicit goal-completion controls are unchanged.

A release is not a replayable dispatch ticket: reload returns an outstanding
release to the hold without resending it. There are at most 32 retained logical
blockers and 128 authority records per goal, with capacity reserved for closing
a retry and recording incomplete scope. Malformed permission-authority records
for the matching goal make its scope incomplete while retaining valid evidence;
neither malformed releases nor later valid releases can reverse that gap.
Records for other goals and generic history do not affect the hold. A malformed
record with an unknown or missing goal id cannot be attributed to this goal.
A full history or incomplete scope refuses further release rather than dropping
evidence and authorizing a broader retry. Clear or
replace a goal only through the existing explicit human commands.

These bounds govern autonomous continuation turns. They do **not** enforce
at most one command inside a model turn, cancel already running children, or
provide a new task-execution security boundary. Retry-scope constraints are
passed to the model; the existing task guard remains responsible for actual
permissions.

## Observable Progress

`get_goal` reports `Observable progress: healthy`, `quiet`, or `stalled` for
an active goal. Changed foreground evidence, interactive input, and a
background-drain transition advance its progress anchor until its no-progress
hold is exhausted. Held ledgers retain their anchor until explicit resume. A running foreground
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