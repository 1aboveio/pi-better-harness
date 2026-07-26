# Issue #46 — Incremental plan (implement-and-pr step 4)

Unit: #46 Add live detail view navigation to the subagent navigator
Branch: issue-46-detail-subagent-navigator (stacked on origin/issue-45-minimal-subagent-navigator @ 5c9fb9d)
TDD: yes (AC-backed). RED first per slice, then GREEN.
Out of scope: #47 two-press close/dismiss, #48 docs/hardening (except #46 evidence docs).

## Slice map (AC → slice → surface → level)

| AC | Slice | Surface (@covers) | Level |
|----|-------|-------------------|-------|
| Enter on selected run opens detail view | S1: list→detail mode transition on enter | navigator.detail | unit |
| Detail shows effective status, model, elapsed, current/used tools, spend, parsed output | S2: `buildNavigatorDetail` + `buildDetailLines` pure seams | navigator.detail | unit |
| Detail refreshes once per second while open | S3: injectable interval; tick reloads detail + requestRender | navigator.detail | unit |
| Running detail transitions to terminal without close/reopen | S3: getDetail reread each tick; same view, new status/output | navigator.detail | unit |
| `←` in detail returns to list | S4: leaveDetail, stop timer, restore mode=list | navigator.detail | unit |
| Escape in detail closes navigator | S4: dispose + done(null) from detail mode | navigator.detail | unit |
| Returning to list preserves selection for viewed run when still visible | S4: selectById after optional getRows refresh | navigator.detail | unit |
| Detail timers disposed on back, Escape, overlay close, session teardown | S5: dispose() clears interval; openTrackedNavigator sync onComponent capture + disposeTrackedNavigator on session_shutdown (Pi custom()→done(null), never component) | navigator.detail | unit |
| Narrow terminal truncates safely | S2: every detail line through truncate(line, width) before style | navigator.detail | unit |
| Tests cover all of the above | `tests/navigator_detail.test.mjs` (+ #45 enter-key expectation update) | navigator.detail | unit |

## Notes

- Pure seams stay in `navigator.mjs` (no pi imports). Detail tick uses injected
  `setInterval`/`clearInterval`/`tickMs` so tests drive refresh without sleeps.
- `getDetail(id)` is the live-data seam (index.ts: readMeta + effectiveStatus +
  parseRun + fmtElapsed/fmtSpend/shortModel). Overlay never imports registry.
- Optional `getRows()` refreshes the list snapshot when leaving detail so a
  disappeared run can clamp selection sensibly.
- List help line gains `enter open`. Enter is no longer an ignored key (#45 test update).
- Active overlay `dispose()` is tracked via `openTrackedNavigator` (sync
  `onComponent` capture) and invoked by `disposeTrackedNavigator` on
  session_shutdown. Pi's `ui.custom()` resolves to `done(null)`, not the
  component — never capture dispose from the custom() promise (fix round 1:
  `navigator.detail.timer-lifecycle`).
- Settlement cleanup of the dispose slot uses `Promise.resolve(opened).then(clear, clear)`
  (not `.finally`) so a rejected `custom()` does not create an unhandledRejection
  when callers discard the returned promise (fix round 2).
- Widget paths untouched. Non-TUI isolation unchanged (`isNavigatorUiAvailable`).

## Fix rounds

| Round | Theme | Closed by |
|-------|-------|-----------|
| 1 | `navigator.detail.timer-lifecycle` — `showNavigator().then(component => …)` never saw dispose under Pi custom() semantics | `openTrackedNavigator`/`disposeTrackedNavigator` + Pi-compatible custom() fakes + regression tests proving session_shutdown clears active detail timer |
| 2 | `navigator.detail.timer-lifecycle` — `Promise.resolve(opened).finally(...)` rethrows rejection into a second promise; `void` does not consume it → unhandledRejection on Pi custom() setup failure | `.then(clear, clear)` handled settlement cleanup; rejection-path unit + runtime-smoke prove slot cleared and zero unhandledRejection when return is discarded |
