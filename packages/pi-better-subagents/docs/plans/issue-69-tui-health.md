# Issue #69 — Show health state in the TUI navigator and detail view

Parent epic: #60. Source: https://github.com/1aboveio/pi-better-subagents/issues/69
Upstream on main: #66 observation, #67 list/widget surfacing, #68 orphaned close,
#45/#46/#48 navigator.

## Design decisions (pinned)

- Reuse `#66` `observeRunHealth` / `compactFacts` and `#67` surface helpers.
  No parallel health model and no hot-path log reparse beyond the existing
  size/mtime cache (`observeWidgetHealth` / `healthLogCache`).
- Navigator row scan order (epic #60):
  `name/id · model [· effort] · elapsed [· tool] [· spend] · status [· ≤2 facts]`
  Status moves to the end (was previously second) so health appends without
  disrupting the name/model scan habit.
- Effort is shown when metadata exposes it (`effort` / `modelEffort`); optional
  per epic out-of-scope note when Pi does not provide it.
- Healthy/quiet: no health facts (reuse `isActionableHealth` + surfaceable facts).
- Degraded: at most two compact facts after status via
  `formatNavigatorHealthFacts` (does not repeat orphaned/lost labels).
- Semantic status colors: completed→success, failed/lost→danger,
  killed/orphaned→warning, running→accent. Color applied to the status token
  only; selected-row accent colors the `> ` prefix so status color is preserved.
- Width safety: `visibleWidth` / `truncateToVisibleWidth` ignore ANSI and test
  theme markers; overlay falls back when host truncator is byte-naive.
- Detail view sections (separate): header, process/liveness, activity,
  compaction, active tool, model, log, thresholds, callbacks, output.
- Close help treats `orphaned` as stoppable (aligned with #68).

## Slice map (AC → tests)

| AC | Proof |
|----|-------|
| name/id first; model next; effort adjacent | `tests/navigator_health.test.mjs` row order |
| elapsed/tool/token/spend order preserved | same + formatNavigatorRowText |
| status at end; ≤2 health facts | health-fact cap test |
| semantic status colors | statusThemeColor + overlay colorize |
| width-safe colorization | visibleWidth assertions + truncate helper |
| healthy low-noise; degraded facts | healthy/degraded cases |
| detail sections + compaction≠tool≠model | detail health sections |
| tests cover matrix | this file + navigator_health.test.mjs |

## Non-goals

- Changing list/widget health contracts (#67)
- Stop/restart UX beyond existing orphaned close (#68)
- Inferred long_model_call without #64 evidence
- Machine-global health monitoring

## Status

- [x] Plan written
- [x] RED tests
- [x] Implementation GREEN
- [ ] Close-out
