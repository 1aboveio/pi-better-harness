# Issue #67 — Surface subagent health in existing tools and passive UI

Parent epic: #60. Source: https://github.com/1aboveio/pi-better-subagents/issues/67
Upstream on this branch: #66 (`bd9dec1` observation seam), #65 (`ddc67c4` callbacks + result diagnostics).
Sibling (out of scope): #68 stop/close, #69 TUI navigator health.

## Design decisions (pinned)

- Reuse `#66` `observeRunHealth` / `compactFacts` and `#65` orphaned/lost result + notify paths.
  No parallel health model.
- Healthy/quiet stays low-noise: list row format unchanged when there are no
  actionable compact facts; widget lines unchanged when health is healthy/quiet.
- Degraded/actionable only: stale, compacting, long compaction, long tool,
  model error/retry, plus durable statuses `orphaned` / `lost` in list filters
  and status brackets.
- `subagent_list` accepts durable `orphaned` and `lost` in `status` filters and
  shows them as row statuses. Optional ` · fact1, fact2` suffix from compactFacts
  when degraded.
- `subagent_output` appends a `[health: …]` diagnostic for orphaned, lost, and
  degraded running runs; healthy/quiet running stays on the existing head.
- `subagent_result` keeps #65 orphaned/lost diagnostic bodies; may append compact
  health facts when present without changing completed/failed/killed happy path.
- Passive widget: healthy/quiet geometry and text unchanged. Degraded running (and
  orphaned) may show a short health suffix. Widget remains non-focusable
  (`setWidget` only; no editor/focus APIs).
- Human `ui.notify` on orphaned/lost transitions remains once-per-transition and
  independent of `callback` (owned by #65 health tick). `callback:false` still
  suppresses coordinator follow-up only.

## Slice map (AC → tests)

| AC | Proof |
|----|-------|
| list durable orphaned/lost statuses | `tests/health_surfacing.test.mjs` + list filter unit |
| list degraded/actionable health | health_surfacing degraded list row |
| healthy/quiet list low-noise | health_surfacing + existing format pin |
| output diagnostics orphaned/lost/degraded | health_surfacing output cases |
| result health/loss/orphan diagnostics | #65 result diagnostics + health_surfacing pin |
| widget healthy non-regression | health_surfacing + widget_flicker |
| widget degraded non-focusable | health_surfacing widget suffix + source pin |
| one-time human notify w/o callback:true | extension_health_lifecycle #65 cases |
| callback:false suppresses follow-up not TUI | extension #65 + widget visibility unit |
| tests cover the matrix | this file + health_surfacing.test.mjs |

## Non-goals

- Navigator health rendering (#69)
- Stop/restart actions (#68)
- New interactive widget controls
- Changing healthy completion callbacks

## Status

- [x] Plan written
- [ ] RED tests
- [ ] Implementation GREEN
- [ ] Close-out
