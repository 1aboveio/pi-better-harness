# Issue #65 — Orphaned/lost callbacks + diagnostic results

Parent epic: #60. Source: https://github.com/1aboveio/pi-better-subagents/issues/65
Depends on: #63 (process identity + orphaned/lost reconciliation) — already on main.
Sibling (out of scope): #68 stop/close for orphaned, #67 UI health surfacing.

## Design decisions (pinned)

- Related work remains process-group-only (ADR 0002). No descendant tracking.
- `orphaned` is non-terminal/non-final, operationally unhealthy immediately.
- `lost` is terminal with unknown outcome — not failed.
- Stop/Restart are NOT implemented here; callback wording may name existing
  inspection tools (`subagent_result`, `subagent_output`, `subagent_stop`) and
  that the coordinator may wait / stop / retry.
- Coordinator model follow-up uses existing non-interrupting delivery:
  `{ deliverAs: "followUp", triggerTurn: true }` with distinct ATTENTION wording
  (not completion "has returned").
- `callback:false` suppresses model `sendMessage` only; `ui.notify` / TUI-visible
  state from #63 remain.
- Durable per-status markers on `RunMeta` (`orphanedCallbackSentAt`,
  `lostCallbackSentAt`) mean successful handoff only and dedupe across reloads
  and repeated health ticks. Recovery is independent of fresh transitions:
  persisted unmarked orphaned/lost (including lost after reload) are scanned
  until exactly one successful coordinator handoff (or intentional
  callback:false suppression) writes the marker. A crash/throw after attempt
  but before handoff success leaves the marker unset so the next tick/reload
  retries.
- `subagent_result` orphaned → non-final diagnostic + best-current artifacts.
- `subagent_result` lost → lost diagnostic + best-available artifacts.
- Neither path throws solely because status is orphaned/lost.
- completed/failed/killed result + completion-callback paths stay compatible.

## Slice map (AC → slice → tests)

| AC | Slice | State | Proof |
|----|-------|-------|-------|
| orphaned callback when callback:true | S1 delivery + health hook | done | `tests/extension_health_lifecycle.test.mjs` `#65` orphaned transition |
| lost callback when callback:true | S1 | done | same file, lost transition |
| orphaned wording (supervision lost, related may be alive) | S1 formatters | done | `tests/health_callback.test.mjs` + extension content |
| lost wording (no process, no coherent terminal) | S1 formatters | done | `tests/health_callback.test.mjs` + extension content |
| callback names inspection tools + wait/stop/retry | S1 formatters | done | `tests/health_callback.test.mjs` |
| dedupe survives reload + repeated ticks | S1 markers | done | multi-tick + pre-marked meta tests |
| persisted unmarked orphaned recovers after reload | S1 recovery | done | extension: orphaned-kept + missing marker |
| persisted unmarked lost recovers after reload | S1 recovery | done | extension: lost + missing marker |
| failed handoff not permanently suppressed | S1 handoff | done | extension: throw then reload success |
| callback:false suppresses model only | S1 | done | extension: notify yes, sendMessage no |
| non-interrupting delivery, distinct attention | S1 | done | followUp+triggerTurn; ATTENTION wording |
| subagent_result orphaned diagnostic + best-current | S2 tools/lifecycle | done | AC7 registered tool + `formatOrphanedResult` unit |
| subagent_result lost diagnostic + best-available | S2 | done | AC8 registered tool + `formatLostResult` unit |
| no throw on orphaned/lost | S2 | done | registered tool doesNotReject |
| completed/failed/killed compatible | S2/S3 | done | full suite `node --test tests/*.test.mjs` 348 pass |

## Status

- [x] Plan written
- [x] RED tests (formatters + extension lifecycle + result diagnostics)
- [x] Implementation GREEN
- [x] Docs/checklist/smoke/closeout
