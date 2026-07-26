# Issue #68 — Resolve orphaned subagents through stop and close cleanup

Parent epic: #60. Source: https://github.com/1aboveio/pi-better-subagents/issues/68
Upstream on this branch: #63 process identity, #65 orphaned/lost callbacks, #47 navigator close (on main).
Sibling (out of scope): #69 TUI navigator health, restart UX.

## Design decisions (pinned)

- **Single stop path.** `stopRun` remains the only mutator for stop/cleanup.
  Model `subagent_stop` and TUI Close both call it — no second kill/finalize path.
- **Process-group-only related work (ADR 0002).** Identifiable related work is
  the captured process group (`pgid`, falling back to `pid` for old metadata).
  Escaped / reparented / `setsid` descendants are **out of contract**. The issue
  wording mentions "descendants"; this slice interprets that as **group members
  that remain in the captured process group** (group-mates of the leader), not
  a process-tree crawl. No descendant scanner is added.
- **Orphaned stop branches:**
  1. Process-group alive → SIGTERM group (same helper as running stop) → durable
     `killed` + `lifecycleClassification: killed` + `endedAt`.
  2. No process-group evidence → reread complete log via `parseRunForLifecycle`
     → coherent terminal (`sawEnd` + no open tools) → `completed`;
     `sawEnd` + open tools → `failed` / `incomplete_open_tools`;
     else → durable `lost`.
- **Running stop unchanged in outcome.** Still SIGTERM + `killed`. Prefers
  recorded `pgid` so running and orphaned share one target rule.
- **TUI Close:** `running` and `orphaned` both go through `stopRun` first.
  Dismiss is applied only after a terminal status is written. If stop declines
  while still orphaned/running, Close returns `not-closed` and does **not**
  dismiss.
- **Confirm hint:** orphaned uses `x again to stop <name>` (same as running).

## Slice map (AC → tests)

| AC | Proof |
|----|-------|
| `subagent_stop` accepts orphaned when PG identifiable | `tests/orphaned_stop.test.mjs` tool + stopRun PG cases |
| Stopping orphaned terminates related work + durable killed | orphaned stop with process group / group members |
| Cleanup with no process rereads logs before status | cleanup with terminal evidence + lost cases |
| Coherent terminal evidence → completed/failed | terminal evidence suite |
| No evidence + no process → lost | orphaned cleanup to lost |
| Shares semantics with running stop | compatibility suite + running Close |
| TUI Close uses cleanup path | TUI Close suite |
| TUI Close does not dismiss until terminal written | hold-dismiss test |
| Tests cover PG / members / evidence / lost / running compat | this file + orphaned_stop.test.mjs |

## Non-goals

- Process-tree / escaped-descendant tracking (ADR 0002)
- Restart action
- Navigator health rendering (#69)
- Changing completion-callback delivery on kill (existing path)
