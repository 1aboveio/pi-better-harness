# Harness-owned Outcome & Todo with a Goal lifecycle bridge

## Status

Accepted by the user. Supersedes the old standalone Plan
distribution as the shared session-outcome surface described in
[ADR 0013](0013-harness-settings-and-next-prompt-suggestions.md) and the Goal
prompt ownership implied by that arrangement. Does not make `pi-better-goal`
depend on `pi-better-harness`. Amended by [#679](https://github.com/1aboveio/pi-better-harness/issues/679)
to add the independent durable work ledger described below, and by
[#680](https://github.com/1aboveio/pi-better-harness/issues/680) to define its
explicit session association and recovery contract.

## Decision

`pi-better-harness` absorbs Plan as its **Outcome & Todo** runtime. The original
accepted decision made the runtime off by default behind one human-controlled
`/harness-settings` toggle. The human has since accepted separate display and
hook controls: **Outcome & Todo display** (`outcome-todo-display`) defaults On,
while **Outcome & Todo hooks** (legacy id `outcome-todo`) defaults Off. The
independent **Long-term work ledger** control (`outcome-todo-ledger`) also
defaults Off. Saved v1 `enabled` remains the hooks authority; the optional
display preference defaults to true and the optional ledger preference to false.
Installation and first load do not write session state, settings, or
outcome/todo records. Missing state produces no placeholder.

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

## Durable Work Ledger

Harness also owns a **durable work ledger** that is independent of a session and
of the LLM context. This is a storage ownership change, not a second editable
execution plan:

- Ledger records live outside session custom entries under the Pi agent directory
  (`PI_CODING_AGENT_DIR/work-ledgers/<project-key>/<ledger-id>.json`), scoped by
  the canonical project working directory. They are not stored in the repository,
  in `.resolve-issues` workflow runs, or in widget/display state.
- Each record has a stable ledger id, a monotonically increasing revision, the
  overall outcome, boundaries, overall status, and high-level items with stable
  ids. Items retain completion conditions, progress, next step, blocker and
  recovery condition, completion evidence, and timestamps.
- Every accepted revision appends one structured history entry. Completed items,
  their evidence, and cancelled or otherwise closed records remain in the record;
  items are never silently dropped or replaced by a partial update.
- The public interface is the existing **Todo work-plan** interface, not a second
  parallel tool. `update_todo` accepts an optional `ledger` payload for `create`,
  `update`, `attach`, and `detach`; `get_todo` accepts an optional `ledger`
  selector for `list` and `read`. Without those fields the legacy Todo and
  workflow behavior is unchanged. The typed `openWorkLedgerStore()` module API
  remains the storage boundary used by both paths.
- `update` requires the revision the caller last read. A mismatch is refused
  before any write. Writes serialize on a project ledger lock and replace the
  complete JSON record atomically, so competing writers cannot both accept the
  same revision. A partial update changes only the named item ids and fields.
- Completing an item requires evidence. Marking an item blocked requires both a
  blocker and a recovery condition. Completing the overall ledger is refused
  while items remain pending, in progress, or blocked; plan or item completion
  never completes the outcome automatically.
- The ledger extends `update_todo` and `get_todo` without changing workflow-owned
  canonical task plans, Goal lifecycle, permissions, or Outcome & Todo
  display/hooks. Creating or listing a ledger does not associate it with a
  session, inject old work, start a Goal, or execute anything. Explicit
  association, recovery reminders, detaching, and UI remain the separate
  contract in [#680](https://github.com/1aboveio/pi-better-harness/issues/680).
- Temporary widget visibility and cleanup remain separate from durable records.
  Hiding or clearing a display never deletes ledger history or completed evidence.

The **Long-term work ledger** setting is a third, independent Outcome & Todo
control (`outcome-todo-ledger`), default Off, alongside display and hooks. Turning
it off removes ledger views, selectors, mutations, and hints; it never deletes
records, clears the session reference, changes Goal pause/authorization state, or
disables ordinary Todo/workflow behavior. Turning it on restores the session
association and rebuilds hints from the stored record, but never adopts a ledger
in a fresh session. Enabling it does not enable hooks or display; those remain
separate gates.

### Explicit session association

A session may store an explicit reference to one ledger. The reference is an
ordinary custom session entry under `pi-better-harness:work-ledger` with either
`{version: 1, kind: "attach", ledgerId}` or `{version: 1, kind: "detach"}`. The
latest valid action on the active branch wins; malformed or unknown entries are
ignored rather than erasing an earlier valid reference. The entry contains no
ledger body, so restoring a session re-reads the same durable record and its
current revision. A clean new session has no reference: discovery through the
project ledger list is not adoption, and no session inherits a ledger from its
working directory. A fork or clone follows the copied branch, so it continues the
same record by explicit copy of the reference, still without copying the ledger.

The human controls association deliberately:

- `/ledger list` discovers this project's ledgers and marks the current one.
- `/ledger attach <id>` and `/ledger switch <id>` select an existing record.
  Selecting never copies the ledger; the session continues the same id, history,
  completed evidence, and revision sequence. `attach` refuses to silently replace
  a different current association; `switch` is the explicit replacement.
- `/ledger detach` removes only the session reference. `/ledger show` inspects
  the current record, including while hooks are off. `/ledger attach` and
  `/ledger switch` require the ledger setting to be on.

`update_todo({ledger:{action:"attach"|"detach"}})` is the model-facing form of
the same deliberate action. It must never infer association from the project
directory, existing files, a similar outcome, or the start of unrelated work.
The `ledger` payload is not accepted alongside outcome, Todo, or workflow changes
in one call, so a failed task operation cannot partially commit a ledger change.
`create`, `update`, `list`, and `read` remain unassociated.

While hooks and the ledger setting are on, Harness publishes a bounded recovery
reminder built from the durable record after compaction, resume, branch
restoration, explicit attach, or enabling either gate. The reminder carries the
overall outcome, totals, and at most a few unfinished items plus their progress,
next step, or blocker. It is reference only: it does not authorize work, resume a
paused Goal, change permissions, or supersede the workflow's canonical plan. A
context filter drops ledger reminders whose `details.ledgerId` no longer matches
the active reference, so detach, switch, hooks off, or ledger off remove stale
work instructions from the next model request. Display off hides the surface
without changing the reference.

Completing the session Outcome is refused while the associated ledger is active
and has pending, in-progress, or blocked items. Completing a Todo or workflow
execution plan still never completes the overall ledger or Outcome
automatically. Closing all ledger items does not complete the ledger; its overall
status remains an explicit update. A completed or cancelled ledger no longer
blocks Outcome completion. Starting a `newTask` is an explicit context switch and
appends a detach reference after the requested task operation succeeds; a failed
operation leaves the reference unchanged. Goal owns its lifecycle and completion
authority, so Goal events are neither blocked nor synthesized by ledger
association.

The existing Todo surface shows one compact ledger count line (completed/total,
open, blocked, and the next open item) when an association exists. This is an
additive summary in the existing widget, not a second editable plan or widget.
Workflow-owned rows remain the canonical execution rows: their item/stage/
status/delivery projection still comes from `workflow-plan.ts` and the canonical
task plan. The ledger adds context, not an engineering stage model or mirrored
execution state. Ordinary Todo items are not forced into implement/review/CI
stages. Association and restoration never start a Goal, enable hooks or display,
change preferences, or start an agent turn.

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
- Durable work ledgers survive session reload, compaction, and session deletion.
  A new session in the same project can discover them only through an explicit
  `get_todo` ledger list/read or id. Discovery is not adoption, and stale updates
  are refused rather than silently replacing newer progress.
- Resuming the same session restores its explicit ledger reference and the same
  durable record. A fresh session stays unassociated until the human runs
  `/ledger attach` or explicitly requests `update_todo` ledger attach; neither
  action copies the record or authorizes old work. Detach and switch remove
  stale context before the next model request.
- Long-term work ledger is Off by default and independent of hooks/display.
  Turning it off keeps stored records and the session reference while stopping
  views, ledger selectors/mutations, and hints; turning it on restores them from
  storage without adopting work in a fresh session.
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

Durable work ledger tests use a temporary project and agent directory. They
create a ledger, reopen it from disk, and prove project-scope isolation and that
no file is written into the project tree. Incremental updates prove that
untouched items, completed evidence, outcome metadata, totals, and per-revision
history survive; stale revisions are refused without changing stored state.
Two worker threads race the same revision through the real store and exactly one
is accepted. Unified-interface tests keep generic outcome/Todo state unchanged,
reload the extension from durable storage, and confirm that neither creation nor
reload associates the ledger with the session or writes session entries. They
also confirm the default-Off long-term ledger toggle blocks ledger payloads and
queries until explicitly enabled, while leaving the existing tools and workflow
writer unchanged. The existing task-context, workflow-plan, Goal, and
display/hooks suites remain the boundary regression.

Session-association tests drive the registered extension with real settings,
session entries, tool calls, and durable stores. They prove that an explicit
attach survives a same-session reconstruction while a fresh session with the same
project stays unassociated; resuming does not copy the ledger or add a second
association; and continuing in the selected session updates the same id, history,
and revision. Compaction tests remove the active reminder and prove a fresh
bounded reminder is rebuilt from the store (including newer external progress)
rather than the conversation summary, while the context filter removes reminders
for a detached or replaced ledger. Completion tests prove Outcome completion is
refused while associated items are open, that completing a Todo does not complete
the ledger, and that a new unrelated task detaches the old reference. Additional
integration coverage keeps a paused Goal, independent hooks/display controls, and
a workflow-owned canonical plan unchanged around association and reminder events.
The compact-header test proves the ledger count line stays within width and adds
no second widget. Toggle tests prove off removes views, hints, and ledger
operations without deleting records, and on rebuilds the current hint from the
new durable revision while restoring the same association. The root provider
schema test asserts the unified `update_todo` payload and `get_todo` selector and
confirms no separate public `work_ledger` tool is registered.
