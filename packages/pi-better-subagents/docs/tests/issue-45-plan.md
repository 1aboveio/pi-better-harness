# Issue #45 — Incremental plan (implement-and-pr step 4)

Unit: #45 Open a minimal subagent navigator from empty-editor Left
Branch: issue-45-minimal-subagent-navigator (stacked on origin/issue-44-navigator-visibility-stop @ cf2cb24)
TDD: yes (AC-backed). RED first per slice, then GREEN.
Out of scope: #46 detail view, #47 close/dismiss action, #48 hardening/docs.

## Slice map (AC → slice → surface → level)

| AC | Slice | Surface (@covers) | Level |
|----|-------|-------------------|-------|
| Footer hint `← subagents · N` while ≥1 visible run; clears at 0; uses default footer status (setStatus), never replaces footer | S1: `navigatorFooterHint` / `applyNavigatorFooter` pure seams + dirty-checked index.ts wiring | navigator.footer-hint | unit |
| Bare `←` on empty editor + visible runs opens overlay; `←` with text delegates to cursor-left; wrapper composes with any existing editor; reloads do not stack wrappers | S2: `wrapEditor` (delegating Proxy) + `installNavigatorEditor` (marked factory, deps refresh) | navigator.editor-wrapper | unit |
| Overlay lists visible current-parent runs newest first (running + terminal); row = name/ID · status · model · elapsed · spend; Up/Down move selection; Escape closes; focused overlay | S3: `buildNavigatorRows` + `createNavigatorState`/`moveSelection` + `buildNavigatorLines` + `createNavigatorOverlayFactory`/`showNavigator` | navigator.overlay | unit |
| Live widget stays passive/unchanged | regression: existing `tests/widget_flicker.test.mjs` must pass untouched; widget code paths not modified | widget.* (existing) | unit |
| Navigator inactive in non-TUI modes | S1/S2 guard seam `isNavigatorUiAvailable(ctx)` (hasUI) at every index.ts entry | navigator.footer-hint, navigator.editor-wrapper | unit |
| Tests | `tests/navigator_overlay.test.mjs` | all above | unit |

## Notes

- Pure seams live in `navigator.mjs` (no pi imports — mirrors widget.mjs), re-exported
  from `navigator.ts`. pi-tui functions (`matchesKey`, `truncateToWidth`) and
  `CustomEditor` are injected by index.ts, so unit tests run under plain node.
- Editor interception = composition, not replacement: the installed factory wraps the
  previously configured factory (`ctx.ui.getEditorComponent()`), or a `CustomEditor`
  when none. The factory is string-marked; a repeat install refreshes deps instead of
  stacking (pi resets the factory on session switch/reload, but session_start can
  re-fire in-process).
- Overlay = `ctx.ui.custom(factory, { overlay: true })` → pi focuses it automatically
  (`showOverlay` → `setFocus`). No timers in #45 (no live refresh — that is #46's
  detail view), so there is nothing to dispose.
- Footer count/list consume the #44 seams `navigatorVisibleRuns` /
  `navigatorVisibleCount`; spend/elapsed formatting reuses `parseRun` +
  `fmtSpend`/`fmtElapsed`/`shortModel` (widget.mjs) so rows match tool/widget output.
- Browser/E2E: N/A (pi TUI extension, no bootable browser app). Widget non-regression
  is pinned by the untouched existing suite.
