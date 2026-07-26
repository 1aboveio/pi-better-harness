# pi-better-goal

`pi-better-goal` is a Pi package that provides a `/goal` runtime with background-aware continuation for async subagents.

It ships one extension that:

- reads `pi-better-subagents` durable run metadata from the temp registry
- treats current-parent `running` and `orphaned` subagents as active background work
- owns `/goal` plus the `get_goal` and `update_goal` tools; only `/goal <objective>` can create a goal
- shows the current goal with active and elapsed clocks in a right-aligned widget above custom footers such as `pi-observability`
- publishes a typed activity snapshot on `pi.events`
- adds goal-aware prompt context while background work is active, so foreground idleness is not confused with goal completion
- sends a hidden follow-up when active background work drains to zero, including `callback:false` subagent runs
- provides a `/better-activity` command and `get_background_activity` tool for inspection

Goal state is stored as `pi-better-goal` custom entries in the Pi session. Existing `pi-codex-goal` entries are read for compatibility, but new state is written by this package.

## Commands And Tools

```text
/goal
/goal <objective>
/goal pause
/goal resume
/goal clear
/goal complete
/better-activity
```

Model-callable tools:

- `get_goal`
- `update_goal`
- `get_background_activity`

## Goal Clock

Only `/goal <objective>` can create or replace a goal; there is no model-callable
goal creation tool. The right-aligned widget below the editor shows the objective,
status, active time, and total elapsed time. Active time stops while paused. Both
clocks freeze when the goal is completed and remain visible until the goal is
cleared or replaced.

The widget does not replace Pi's footer, so custom footer extensions such as
`pi-observability` retain ownership of their layout and lifecycle.

Set `PI_BETTER_GOAL_DISABLE_WAKE=1` to disable hidden background-drain wakeups.

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