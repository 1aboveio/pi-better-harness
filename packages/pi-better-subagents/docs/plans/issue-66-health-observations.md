# Issue #66 — Compute multi-dimensional subagent health observations

Parent epic: #60. Source: https://github.com/1aboveio/pi-better-subagents/issues/66
Upstream: #63 (process-group reconcile on main), #64 (child event evidence on main).
Sibling units (NOT this slice): #65 callbacks/diagnostics, #67 tool/UI health surfacing,
#68 stop/close cleanup, #69 TUI navigator health.

## Design decisions (pinned)

- Pure observation seam separate from durable status reconciliation (`reconcileRun`).
  Observation never writes meta.json and never auto-kills.
- Scope: current-parent **supervised (`running`)** and **orphaned** runs. Terminal
  statuses still accept observation for diagnostics, but activity classification is
  residual only when the run is non-terminal live work.
- Event vocabulary from #64 NOTES + fixtures — parsed JSON only for meaningful activity.
- Dimensions (independent):
  1. `process` — supervised | orphaned | lost | terminal (from durable status + probe facts)
  2. `activity` — healthy | quiet | stale (from last **meaningful** event age + thresholds)
  3. `compaction` — idle | compacting | long_compacting (+ last end detail)
  4. `tool` — idle | running | long_running (+ active tool name/id, startedAt)
  5. `model` — ok | error | retrying (+ last error message/history); **no** `long_model_call`
     unless explicit lifecycle events exist (#64: they do not → field omitted / unsupported)
  6. `lastMeaningfulAt` — max time among meaningful event classes
  7. `rawLog` — mtime/size diagnostic only; never promotes activity to healthy
- Stale is **residual**: only when activity age ≥ stale threshold AND no open tool,
  not compacting, and not in active model-error/retry phase that explains silence.
- Model-error **compact/list** warning clears after successful model/tool/assistant
  activity; `detail.modelErrorHistory` retains the last error(s).
- Fatal model errors that terminate the child remain compatible with durable `failed`
  (observation does not overwrite status; reports model dimension + process terminal).
- Thresholds configurable via optional `HealthThresholds` argument (defaults constant);
  optional config.json keys `healthQuietMs` / `healthStaleMs` / `healthLongToolMs` /
  `healthLongCompactionMs` when loading defaults from config (no spawn API expansion).

## Slice map (AC → tests)

| AC | Behavior | Tests |
|----|----------|-------|
| meaningful events update lastMeaningfulAt | extract facts | quiet-to-stale setup + fixture parse |
| raw log write is diagnostic only | rawLog noise ≠ healthy | raw-log-noise |
| activity healthy/quiet/stale | thresholds | quiet-to-stale |
| compaction separate | compacting not stale | compaction-not-stale |
| long compaction distinct | long_compacting | long-compaction |
| active tools separate | tool running | tool-running |
| long tool distinct | long_running | long-tool |
| recoverable model/network error separate | model error/retrying | model-error recovery |
| model-error clears compact after good activity | list facts drop warning; history keeps | model-error recovery |
| fatal model errors + failed status compatible | observation on failed meta | model-error fatal |
| long_model_call only if explicit evidence | unsupported without events | long_model_call-unsupported |
| configurable thresholds | override quiet/stale/long_* | thresholds |
| test matrix | all named cases | tests/health_observation.test.mjs |

## Non-goals

- #67 list/navigator rendering wiring beyond exporting compact facts helpers
- #65 callback delivery
- Auto-kill, stop/restart
- Inferred long_model_call

## Status

- [x] Plan written
- [x] RED tests
- [x] Implementation GREEN
- [x] Close-out
