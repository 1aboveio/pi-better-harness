# Issue #63 — Record process identity and reconcile orphaned/lost subagents

Parent epic: #60. Source: https://github.com/1aboveio/pi-better-subagents/issues/63
Sibling units (NOT this slice): #64 event discovery, #65 orphaned/lost callbacks +
diagnostic results, #66 multi-dimensional health observations, #67 tool/UI health
surfacing, #68 stop/close cleanup for orphaned runs, #69 TUI navigator health.

## Design decisions (pinned before implementation; revised by accepted ADR 0002)

Authoritative contract: `CONTEXT.md` + `docs/adr/0002-process-group-only-subagent-health.md`
(accepted design re-entry after the #63 breaker routed the unit through
`/grill-with-docs`). #63 is **process-group-only**. Escaped/reparented
descendants are out of contract for this slice.

- New durable statuses: `orphaned` (non-terminal, operationally unhealthy
  immediately) and `lost` (terminal unknown outcome — not failed), added to
  `RunStatus`. All new `RunMeta` fields are **optional** so old metadata reads
  with no migration.
- New identity fields recorded at spawn (best-effort, where available):
  - `pgid?: number` — process group id (`process.getpgid`).
  - `pidStartTime?: string` — opaque process-start identity token
    (Linux: `/proc/<pid>/stat` field 22; elsewhere: `ps -o lstart=`). Equality is
    the only operation ever performed on it; it is an identity token, not a clock.
- Supervised ⇔ recorded PID exists AND (no start token recorded OR probe token
  unavailable OR probe token === recorded token). A token that is *different*
  proves the PID was recycled; an *unavailable* token proves nothing, so it never
  demotes a live run.
- Related work for a gone PID is **live process-group evidence only**:
  - process group members alive (`kill(-pgid, 0)`; EPERM counts as alive — the
    safe direction, since `lost` is the harsh verdict); uses recorded `pgid`,
    falling back to `pid` (detached children are group leaders, pgid == pid).
    The legacy `pgid = pid` fallback is explicit and conservative: it may delay
    `lost`, but never manufactures completion or failure.
  - **No descendant / process-tree scan.** `ProcessProbe` has no `descendants`
    method; `scanDescendants` and `orphaned-descendants-alive` are removed.
    Absence of process-group evidence does not stay orphaned just because a
    descendant scan would have found something.
- Transitions (per health tick, current-parent runs only):
  - `running` + supervised → `running` (and reset `probeMisses`).
  - `running` + unsupervised + process-group evidence → `orphaned` (durable,
    `orphanedAt`).
  - `running` + unsupervised + no process-group evidence:
    - new metadata (has `pgid` or `pidStartTime`) → `lost` immediately.
    - old metadata (neither) → `probeMisses += 1`; `lost` only at
      `probeMisses >= 2` (confirmed across health ticks by evidence quality,
      not file age).
  - `orphaned` + process-group evidence (or a still-supervised child) → stays
    `orphaned` (never auto-reverts to `running`).
  - `orphaned` + no process-group evidence → `lost`.
  - `lost` / `completed` / `failed` / `killed` → untouched; `lost` never reverts.
- Periodic reconciliation runs only while current-parent `running`/`orphaned`
  runs exist (`needsMonitoring` predicate); the ticker self-stops when none
  remain. No auto-kill anywhere in this slice.
- Stop/Restart user actions are out of #63 implementation scope (#68 / UI).
- Tool behavior (minimal, this slice only):
  - `subagent_result`: `running`/`orphaned` → non-final ("no final result yet",
    status named); `lost` → terminal result block with best-available artifacts
    (rich diagnostics are #65).
  - `subagent_list` / widget / concurrency / stop: unchanged (surfacing is #67,
    orphaned cleanup is #68).
- A transition to `orphaned`/`lost` fires a best-effort human `ui.notify`
  (TUI visibility), NOT a model callback (callbacks are #65).

## Slice map (AC → slice → tests)

| AC | Slice | Tests (tests/health_reconcile.test.mjs, tests/registry_identity.test.mjs) |
|----|-------|-------|
| 1 identity recorded | S1 registry fields + `captureProcessIdentity` | round-trip meta with pgid/pidStartTime; fake-probe capture; real-probe self |
| 2 old meta readable | S1 | parse meta JSON lacking new fields; reconcile treats as old metadata |
| 3 supervised def | S2 `reconcileRun` supervised | pid alive + token match/missing/unavailable → running; token differs → not supervised |
| 4 orphaned | S3 | pid dead + group alive → orphaned; recycled + group alive → orphaned; legacy pgid=pid fallback |
| 5 lost | S4 | pid dead + no process-group evidence + new metadata → lost immediately |
| 6 old-meta conservative | S4 | old metadata: tick1 → running (misses=1), tick2 → lost; reset when supervised |
| 7 orphaned non-terminal | S5 `isFinalResultStatus` + reconcile durability | orphaned ⇒ no final result; orphaned never reverts to running |
| 8 lost terminal | S5 | lost ⇒ final-result path; reconcile(lost) unchanged even if pid "reappears" |
| 9 periodic only while needed | S6 `needsMonitoring` | true for current-parent running/orphaned; false for terminal/foreign |
| 10 fake probes | all | every reconcile test injects a fake ProcessProbe (no descendants method) |
| 11 compat | S7 | completed/failed/killed untouched by reconcile; effectiveStatus passthrough; existing suites stay green |
| process-group-only contract | S3/S4 | no process-group evidence → lost (not orphaned); ProcessProbe has no descendants; source has no scanDescendants / orphaned-descendants-alive |

## Fix round 1 (review of 976d245, NEEDS_CHANGES)

Independent review findings → fixes (invariant classes, not just examples):

| Theme | Fix | Tests |
|-------|-----|-------|
| terminal-exit-dominates-health-reconcile | New single transition policy `canExitFinalize` (registry.ts): coherent child-exit evidence finalizes `running`/`orphaned`/`lost` (provisional), never overwrites `completed`/`failed`/`killed`; `finalizeRun` guards on it | `canExitFinalize` unit tests; deterministic interleavings in `tests/extension_health_lifecycle.test.mjs` (tick persists lost → real exit finalizes completed + callback delivered; tick persists orphaned → real non-zero exit finalizes failed) |
| spawn-identity-persistence-evidence (AC1) | Injectable spawn-time identity probe (`setIdentityProbeForTests`, ProcessProbe = kernel boundary); production keeps `realProcessProbe` | Extension-level `subagent_spawn` through real persistence: fake probe → meta.json carries recorded pgid/pidStartTime; real probe → capability-conditioned parity |
| health-ticker-production-wiring (AC9) | — (wiring already correct; evidence missing) | Extension-level fake-clock lifecycle: session_start starts the timer, tick 1 persists probeMisses, tick 2 persists lost + notify, self-stop proven by new monitored work NOT being reconciled afterwards |
| independent-probe-capabilities | — (test bug) | realProcessProbe self-test validates groupId and startToken independently; captureProcessIdentity partial-capability unit test |

Harness: `tests/extension_health_lifecycle.test.mjs` loads the real `index.ts`
with a fake ExtensionAPI and a PATH-injected fake `pi` binary. The host-provided
`@earendil-works/pi-ai` package (not installed in this repo) is stubbed via a
module resolve hook — schema builders only, an external boundary, never a
first-party module.

## Status

- [x] Plan written (pre-implementation)
- [x] S1–S6 RED tests (ERR_MODULE_NOT_FOUND for health.ts / isFinalResultStatus)
- [x] health.ts + registry.ts implementation (GREEN: 112 pass)
- [x] index.ts wiring (identity at spawn, health ticker, result gate, notify)
- [x] Runtime smoke vs real OS processes (tests/smoke_health_reconcile.mjs PASS)
- [x] Close-out: scope-class, ledger, lint-tests, checklist, scan-diff, PR
- [x] Fix round 1 plan (review themes above)
- [x] Fix round 1 RED (interleave tests + canExitFinalize fail pre-fix: both supersede tests fail with the old `status !== "running"` guard; import errors for the missing seams)
- [x] Fix round 1 GREEN (129 pass) + gates + checklist/contract updates
- [x] Fix round 2 (theme result-status-outcome-evidence): AC7/AC8 OUTCOME tests invoke registered `subagent_result` for orphaned/lost metadata + default `subagent_list` for orphaned; no production code change required
- [x] Fix round 3 (accepted design re-entry + theme descendant-evidence-survives-reparenting): process-group-only contract; remove descendant evidence entirely

## Fix round 2 (review of 598e951, NEEDS_CHANGES)

| Theme | Fix | Tests |
|-------|-----|-------|
| result-status-outcome-evidence (AC7/AC8) | — (tool branches already correct; evidence was helper-only) | `tests/extension_health_lifecycle.test.mjs` describe(AC7/AC8): invoke registered `subagent_result` for orphaned → non-final/no-final-result response; lost → terminal diagnostic + best-available artifacts; default `subagent_list` surfaces orphaned as `[orphaned]` |

## Fix round 3 (accepted design re-entry + breaker theme descendant-evidence-survives-reparenting)

Human-approved `/grill-with-docs` design narrowed #63 to process-group-only.
Descendant evidence is removed entirely for this slice.

| Theme | Fix | Tests |
|-------|-----|-------|
| descendant-evidence-survives-reparenting | Remove `ProcessProbe.descendants`, `scanDescendants`, and `orphaned-descendants-alive`. Orphan only via recorded pgid or legacy `pgid=pid` fallback + supervised PID identity. Keep conservative old/no-identity lost confirmation. Land ADR 0002 + CONTEXT.md glossary. | Replace descendant-orphaned / recycled-descendant tests; add process-group-only seam test (no descendants method + source static assert) and behavior test that no group evidence → lost (not orphaned). Smoke copy updated to process-group wording. |
