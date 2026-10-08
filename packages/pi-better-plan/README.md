# pi-better-plan

`pi-better-plan` keeps a structured execution plan visible while Pi works.

![Pi Better Plan package preview](https://raw.githubusercontent.com/1aboveio/pi-better-harness/main/docs/images/package-gallery/pi-better-plan.png)

## What It Does

- Gives models one `update_plan` interface for checklist updates, workflow binding, and workflow transitions, plus `get_plan` for inspection.
- Supports dependency edges (`id` and `dependsOn`) so independent ready steps can run concurrently.
- Shows up to five relevant steps above the editor, prioritizing active work and marking omitted ranges with ellipses.
- Clicks fold or unfold the checklist in Pi's fullscreen TUI; `/plan expand` and `/plan collapse` provide keyboard alternatives.
- Persists plan state and display preferences on the active Pi session branch.
- Keeps a completed plan visible for 30 seconds, then clears it automatically.
- Opens the complete plan with `/plan`.

Plan progress is checklist progress, not an estimate of effort. The extension never infers completion from prose or successful tool calls.

## Coordinating Delegated Work

Use the plan as the foreground coordinator's milestone ledger. Delegate independent, sufficiently substantial work early with subagents, and use background tasks for long-running processes or repeated checks. Keep doing unblocked foreground work after launch; do not poll workers.

Before the first implementation milestone, check for independent work and follow
the active subagent delegation mode. Without `pi-better-subagents`, the plan uses
adaptive guidance. Manual keeps planned work in the foreground unless the user or
an active workflow explicitly requires delegation. Adaptive delegates substantial
independent work when useful. Coordinator consults current catalog roles and
delegates nontrivial role-owned work while retaining integration and final
verification in the foreground.

Independent foreground and delegated milestones may both be `in_progress` only
when both are actually underway. Use steps for distinct deliverables, not
individual worker processes; worker tools and the background-work navigator own
run status. Complete verification and the plan only after every relevant
delegated task is terminal and its result or failure has been inspected and
integrated.

For a DAG, assign stable ids to prerequisite steps and list those ids in dependent steps' `dependsOn`. Dependencies must exist in the same plan; cycles and starting or completing a step before its prerequisites are complete are rejected. `get_plan` reports pending steps whose prerequisites are complete as ready. Plans without edges keep their existing behavior.

When an explicitly invoked skill declares `workflow-role: coordinator` in its metadata, that skill's task plan takes precedence. The generic checklist stays persisted but is hidden, and `update_plan` refuses generic checklist updates until workflow ownership is released. `/plan` never opens a stale generic checklist during workflow ownership.

For any workflow using the shared task-plan contract (including `resolve-issues` and `rush-issues`), bind its plan through `update_plan` with the absolute `.resolve-issues/rush/<run-id>/task-plan.json` path and its persisted `planRevision`:

```json
{ "workflow": {
  "path": "/absolute/project/.resolve-issues/rush/run-1/task-plan.json",
  "revision": 12
} }
```

This binds the run to the session and shows its fleet stages and units in the widget, `/plan`, and `get_plan`. It does not rewrite the plan, increment its revision, or append a profiling event. The binding survives Pi session resume. Ownership release keeps the last bound plan visible as a read-only handoff; a generic checklist update or `/plan clear` replaces or dismisses it. Repeat this form to reload an externally saved checkpoint at its exact revision. `sync_workflow_plan` has been removed; migrate its old `{path, revision}` arguments into `update_plan`'s `workflow` object.

After binding, record every transition with `update_plan` and a `workflow` object instead of editing `task-plan.json` or the profiling log by hand:

```json
{ "workflow": {
  "event": "unit-validated",
  "revision": 12,
  "changes": [
    { "id": "1201", "set": { "stage": "done", "status": "in-flight", "worker": null, "headSha": "abc123" } },
    { "id": "C1", "set": { "status": "combining" } }
  ],
  "profiling": { "outcome": "succeeded", "wallMs": 540000 }
} }
```

You may include `path` and `revision` alongside `event` and `changes` in the first call to bind and save a transition together. A rejected transition does not activate a new binding. Every successful binding or transition requests a TUI refresh; there is no separate synchronization tool to call afterward.

Each issue row shows where it is between code and delivery: `●` while it is being built, `◐ implemented` once `stage` is `done` with a `headSha`, `◑ review passed` while `reviewedHead` equals `headSha`, and `✓` only at `status: succeeded`, when the change has landed on the target branch by a merged PR or a direct push. Only `✓` rows count as complete.

`changes` addresses units, components, and fleet stages by id (a change without an id sets run-level fields); all changes in one call are one transition. For a scope change, a change with `target` `unit` or `component` and an `add` row appends a new row; existing rows cannot be removed or renamed. The tool checks ids, dependencies (including cycles), worker slots, and status/stage values against the shared issue-resolution contract (a fleet status of `n/a` is saved as `not-applicable`), refuses a stale `revision`, appends an optional `decision`, then saves the plan atomically with `planRevision + 1` and a new `updatedAt`, and appends one profiling event with the same revision to the log the run already uses (`profiling/run.jsonl` or `profiling.jsonl`). A rejected update changes nothing. The event is appended before the plan is renamed into place, so a crash between the two can leave the log one revision ahead; the next update notices, reuses that revision, and marks its event with `logAheadRevision`.

The binding records the active workflow's name, which is shown in the plan view. A different active workflow cannot read or update that binding; a new invocation invalidates it. After ownership release, the prior binding remains available for read-only inspection but cannot authorize writes. The skill name is not an allowlist: explicit binding opts a workflow into the shared schema and transition rules, while path confinement to `.resolve-issues/rush/<run-id>/task-plan.json`, run identity, size limits, and revision checks still apply. Workflows using other schemas or storage locations retain their own planning and must not bind incompatible state.

## Plan Display

Native and workflow-synced plans share a `plan` heading, completion counts, aligned identifiers and titles, and status colors. Completed rows use `✓`, active rows `●`, pending rows `○`, and blocked rows `!`. Active and blocked rows also carry text labels; failed workflow rows use `×` and `failed` rather than an active indicator.

Workflow identity, revision, and fleet progress sit on a secondary line that wraps on narrow terminals. `/plan` uses the same styling and shows workflow stage, raw status, worker, dependencies, and notes beneath each issue. Use ↑/↓ to move the selection and Escape or ← to return. The passive widget never captures editor arrow keys.

The folded widget shows at most five steps. Active steps take priority, with nearby steps filling the window; if more than five are active, the last five in plan order are shown. Early progress shows the head, late or completed progress shows the tail. Ellipses count omitted rows, while summary counts always cover the entire plan. Expanding reveals all steps without the detailed notes from `/plan`.

In Pi's fullscreen TUI, a plain left click on the visible plan toggles expansion without taking editor focus. Regular terminal mode keeps mouse events for terminal selection and scrollback; use `/plan expand` or `/plan collapse` there. Expansion and display preferences survive reload and follow the active session branch.

### Examples

The same eight-step plan at the start, in the middle, and near completion, followed by its expanded view. These previews use the actual widget renderer with demonstration state, not live-session captures.

**Just started:** the first five steps are visible.

![Compact plan at the start, showing steps 1 through 5](https://raw.githubusercontent.com/1aboveio/pi-better-harness/main/docs/images/package-gallery/plan-examples/start.png)

**In the middle:** the window follows the active step, with omitted steps counted on both sides.

![Compact plan in the middle, showing steps 2 through 6 with step 4 active](https://raw.githubusercontent.com/1aboveio/pi-better-harness/main/docs/images/package-gallery/plan-examples/middle.png)

**Near the end:** the last five steps are visible; progress still counts the whole plan.

![Compact plan near completion, showing steps 4 through 8 with step 7 active](https://raw.githubusercontent.com/1aboveio/pi-better-harness/main/docs/images/package-gallery/plan-examples/near-end.png)

**Expanded:** clicking the plan in fullscreen Pi, or running `/plan expand`, reveals every step. Click again or use `/plan collapse` to return to five rows.

![Expanded plan showing all eight steps](https://raw.githubusercontent.com/1aboveio/pi-better-harness/main/docs/images/package-gallery/plan-examples/expanded.png)

## Install

```sh
pi install npm:pi-better-plan
```

## Commands

```text
/plan
/plan clear
/plan hide
/plan show
/plan expand
/plan collapse
/plan pin auto
/plan pin on
/plan pin off
```

`pin auto` and `pin on` currently use the compact widget until Pi exposes a reserved right-rail extension interface. A floating overlay is intentionally not used as a substitute because it would cover transcript content.

## Development

```sh
npm run verify
```

From the repository root, run the real terminal journey with tmux:

```sh
node --import tsx --import ./scripts/isolate-registry.mjs --test scripts/plan-navigation.tui.e2e.test.mjs
```

Regenerate only the example screenshots, then check the gallery assets:

```sh
npm run gallery:render -- --plan-examples
npm run gallery:check
```

To also exercise fullscreen mouse dispatch on a mouse-capable Pi build:

```sh
PI_PLAN_TUI_CLI=/absolute/path/to/pi PI_PLAN_TUI_MOUSE=1 \
  node --import tsx --import ./scripts/isolate-registry.mjs --test scripts/plan-navigation.tui.e2e.test.mjs
```