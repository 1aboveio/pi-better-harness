# Harness-owned Outcome & Todo with a Goal lifecycle bridge

## Status

Accepted by the user. Supersedes the old standalone Plan
distribution as the shared session-outcome surface described in
[ADR 0013](0013-harness-settings-and-next-prompt-suggestions.md) and the Goal
prompt ownership implied by that arrangement. Does not make `pi-better-goal`
depend on `pi-better-harness`.

## Decision

`pi-better-harness` absorbs Plan as its **Outcome & Todo** runtime. The original
accepted decision made the runtime off by default behind one human-controlled
`/harness-settings` toggle. The human has since accepted separate display and
hook controls: **Outcome & Todo display** (`outcome-todo-display`) defaults On,
while **Outcome & Todo hooks** (legacy id `outcome-todo`) defaults Off. Saved v1
`enabled` remains the hooks authority; the new optional display preference
defaults to true. Installation and first load do not write session state,
settings, or outcome/todo records. Missing state produces no placeholder.

Harness owns the session's structured outcome and checklist. Canonical workflow
records remain unchanged: coordinator skills, `workflow-role: coordinator`,
workflow ownership, scheduler gates, and their plan records keep their existing
meaning and formats. The former standalone Plan package is no longer part of the
Harness bundle; this decision supersedes that distribution without moving Goal
under Harness or requiring Goal to import Harness code.

Goal keeps a compatibility trigger, not outcome authority. Its stored
`snapshot.objective` remains the raw original trigger, including a bound command
or skill invocation, so `/goal resume` can re-enter the same work. When Harness
owns the structured outcome, that raw trigger is not the authoritative business
outcome. Goal continues to own `/goal`, goal status, clocks, pause and permission
holds, workflow gates, scheduler waits, and background-drain wakes. Existing
continuation messages may still repeat the original trigger to resume work.
Completing the Harness checklist does not complete the Goal; the existing
explicit `update_goal complete`, permission, and scheduler gates remain the Goal
completion authority.

In shared session state, Harness owns the outcome and checklist records. It reads
existing todo/plan entries and appends changes under their existing identities;
old session history is not rewritten. Legacy checklists are not inferred as a
business outcome. Goal state stays in its existing custom entries.

## Bridge Contract

Goal communicates through the synchronous, mutable event
`pi-better-harness:task-context`:

```ts
{
  action: "inspect" | "start" | "pause" | "resume" | "complete";
  goalId?: string;
  width?: number; // Current widget width for visual ownership inspection.
  objective?: string;
  enabled?: boolean;
  display?: boolean;
}
```

- Goal emits `inspect` before assembling a turn prompt.
- A new goal id emits `start` with the raw `objective` after the Goal entry is
  appended. Non-start actions never carry `objective`.
- A completed goal emits `complete`; a paused or budget-limited goal emits
  `pause`; a transition from a non-active goal to the same active goal emits
  `resume`.
- Clearing a goal emits `pause` for the current goal before the clear entry. It
  never deletes or completes the Harness outcome.
- A Harness runtime sets `request.enabled` to a boolean whenever it is present.
  This remains the hook and prompt authority. Hooks enable capture, matching
  lifecycle bridge writes, reminders, and automated cleanup; Harness writes
  lifecycle changes only for the matching bound `goalId`.
- On `inspect`, the optional response `display: true` means Harness actually
  displays the requested `goalId` and its runtime fits the requested widget width.
  Only then is the standalone Goal clock suppressed.
  Standalone Goal and hidden or unmatched fallback remain available; display and
  hooks are independent.
- With Harness present, regardless of `enabled`, Goal suppresses its duplicated
  business-outcome prompt text (`Pi Better Goal active objective...` and the
  workflow `Active objective...` line). Workflow instructions, permission and
  held-state guidance, background-completion guidance, and human-resume
  constraints remain. The paused prompt enforces human resume without repeating
  the raw objective.
- With no Harness runtime, `request.enabled` stays undefined and standalone Goal
  prompts and behavior are unchanged.

Goal does not import the Harness package, keeping the dependency direction free
of cycles. Harness consumes the public event contract and remains optional.

## Consequences

- Users get one Harness-owned outcome/checklist surface while Goal remains a
  standalone package with the same kickoff, pause/resume, permission, workflow,
  scheduler, and background-wake behavior.
- There is a short period where Goal's prompt and the Harness outcome may both
  describe the same work if a third party also injects objective text; Goal
  avoids its own duplication but does not rewrite other extensions' prompts.
- `/goal` does not enable Outcome & Todo hooks. A human must enable hooks in
  `/harness-settings`; saved outcomes and checklists display by default even with
  hooks off. Display off does not stop active hooks. `/todo` commands remain
  available with hooks off for explicit user control.
- The compact surface uses one Todo heading with its caret after Todo and the
  completion count on the left. Matching Goal status and its existing active-time
  clock appear on the right; outcome text is one muted, truncated subtitle. The
  collapsed view shows up to five relevant rows and the expanded view all rows;
  clicks toggle them. `/todo` shows the full objective, acceptance criteria,
  boundaries, and plan. No permanent status bar is added, and existing critical
  permission and paused notices remain unchanged.
- Runtime implementation, settings wiring, installation manifests, and the TUI
  journey are owned by the Harness workstream. Goal's contract is limited to the
  event above and the prompt-suppression rules recorded here.

## Legacy Package Retirement

The explicit installer removes `pi-better-plan` registrations in its selected
scope. Ordinary `pi install` and `pi update` do not run that installer, so the
Harness runtime also masks separately loaded legacy Plan extensions.

The adapter filters the public `DefaultResourceLoader.getExtensions()` result
after factories run and before Pi constructs its extension runner. A unique
Harness tool-schema identity scopes the filter to that loader result. The
legacy match uses the real entry file's nearest package manifest, not a tool name.
It returns a filtered copy without changing the loader's cached result or user
settings. No private extension-runner state is changed.

The retired record's shutdown handlers run with the real session context before
Harness restores its widget, releasing its factory listeners and timers. The
mask works in either load order, on reload, and while Outcome & Todo hooks are off.
Without Harness, the old package can load normally. Missing loader APIs or an
unexpected result shape produce a compatibility warning instead of an unsafe
mutation. No package files or session histories are deleted or rewritten.

## Verification

Focused Goal tests drive the real extension with an `EventEmitter` and the
contract listener: start/pause/resume/complete/clear actions carry the bound
`goalId`, only `start` carries the raw objective, replacement goals have distinct
ids, Harness on/off suppresses duplicated objective text while paused resume
constraints remain, and standalone prompts are unchanged. Existing Goal tests
continue to cover permission holds, workflow gates, scheduler waits, explicit
resume, and autonomous wake policy. The alias workflow test no longer imports
the removed legacy Plan package; its coordinator binding, handback, reload, and
resume assertions remain.
