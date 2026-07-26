# Issue #47 — Incremental plan (implement-and-pr step 4)

Unit: #47 Add two-press close behavior to the subagent navigator
Branch: `issue-47-close-subagent-navigator` (stacked on `origin/issue-46-detail-subagent-navigator` @ `6e7607d`)
TDD: yes (AC-backed). RED first per slice, then GREEN.
Out of scope: #48 hardening/docs beyond required #47 evidence docs.

## Slice map (AC → slice → surface → level)

| AC | Slice | Surface (@covers) | Level |
|----|-------|-------------------|-------|
| First `x` on running arms Close + footer `x again to stop <name>` | S1: arm state + confirm hint pure seams | navigator.close | unit |
| First `x` on terminal arms Close + footer `x again to dismiss <name>` | S1 | navigator.close | unit |
| First `x` never mutates run metadata or process state | S1/S2: arm path calls no stop/dismiss | navigator.close | unit |
| Second `x` within 3s acts only if same run still selected | S2: same-id + window gate | navigator.close | unit |
| Second `x` after arming window does not stop/dismiss | S2: expired arm is non-acting (re-arms) | navigator.close | unit |
| Changing selection disarms Close | S3: up/down clears arm + footer confirm | navigator.close | unit |
| List↔detail return, overlay close, session teardown disarm | S3: leaveDetail/enterDetail/close/dispose | navigator.close | unit |
| Immediately before acting, reread metadata + effective status | S4: `executeNavigatorClose` rereads via deps | navigator.close | unit |
| Closing running → stop process group, killed, dismiss | S4: stopRun then dismissRun | navigator.close | unit |
| Closing terminal → dismiss only, preserve terminal status | S4 | navigator.close | unit |
| Finish-during-confirmation → terminal dismissal on 2nd `x` | S4: effectiveStatus terminal → dismiss only | navigator.close | unit |
| Dismissed disappear from navigator/footer; tools still see by id | S5: refresh rows + footer; tool handlers still resolve | navigator.close (+ registry/tools pin) | unit |
| Tests cover all of the above | `tests/navigator_close.test.mjs` | navigator.close | unit |

## Notes

- Pure seams stay in `navigator.mjs` (no pi imports). Confirmation window is exactly
  `CLOSE_ARM_MS = 3000`. Inject `now` / `setTimeout` / `clearTimeout` for tests.
- Footer confirm uses a dedicated status key (`CLOSE_CONFIRM_STATUS_KEY`) so it
  coexists with the existing `← subagents · N` (`NAVIGATOR_STATUS_KEY`) mechanism.
- Close action reuses #44 `stopRun` + `dismissRun` — no second persistence model.
- Overlay owns arm state; index.ts injects `closeRun` / `onCloseConfirmHint` /
  `onClosed` (footer count refresh) / clock+timer seams.
- `x` works in list (selected row) and detail (viewed run). Entering/leaving
  detail disarms. Successful close refreshes visible rows and leaves detail.
- Widget paths and non-TUI isolation unchanged.

## Status

| Slice | RED | GREEN | Notes |
|-------|-----|-------|-------|
| S1 arm + hints | pass (missing exports) | pass | `closeConfirmHint` / `applyCloseConfirmFooter` / arm seams |
| S2 second-press window / same-selection | pass | pass | overlay `x` + `CLOSE_ARM_MS` exclusive window |
| S3 disarm paths | pass | pass | selection, list↔detail, escape, dispose |
| S4 execute close (running/terminal/finish-during) | pass | pass | reuses stopRun/dismissRun; reread effectiveStatus |
| S5 visibility + tool compatibility | pass | pass | navigatorVisible* + registered tool handlers |
