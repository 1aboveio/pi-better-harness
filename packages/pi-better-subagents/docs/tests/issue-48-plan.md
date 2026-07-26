# Issue #48 — Incremental plan (implement-and-pr step 4)

Unit: #48 Harden subagent navigator rendering, reload behavior, and docs
Branch: `issue-48-hardening-subagent-navigator` (stacked on `origin/issue-47-close-subagent-navigator` @ `ed82be11889ac7546662dd43d423073e7e284530` / `ed82be1`; merge-base confirmed)
TDD: yes (AC-backed). Prefer characterization of existing seams; runtime fixes only for contract gaps.
Out of scope: redesign of #44–#47 semantics; new slash commands; model-facing navigator tools.

## Slice map (AC → slice → surface → level)

| AC | Slice | Surface (@covers) | Level |
|----|-------|-------------------|-------|
| List rendering truncates safely in narrow terminals (post style-strip) | S1: list width contract characterization | navigator.hardening | unit |
| Detail rendering truncates safely in narrow terminals (post style-strip) | S1: detail width contract characterization | navigator.hardening | unit |
| Selection stable across status refreshes when selected run still visible | S2: `applyNavigatorRows` / `selectById` keep-by-id | navigator.hardening | unit |
| Selection clamps when selected run dismissed/disappears | S2: keep-by-id miss → clamp | navigator.hardening | unit |
| Footer restored after close / dismiss / stop / reload / teardown | S3: footer + confirm clear/republish paths | navigator.hardening | unit |
| Editor wrappers do not stack across reloads | S3: install mark + refresh (characterization) | navigator.hardening | unit |
| Overlay timers + transient confirm cleared on every close/teardown path | S3: dispose/escape/close/session_start | navigator.hardening | unit |
| Passive live widget + flicker protections unchanged | S4: existing `widget_flicker` suite still passes | widget.* (existing) | unit |
| Non-TUI modes remain tool/API only | S4: `isNavigatorUiAvailable` + RPC source pin | navigator.hardening | unit |
| User-facing docs for ← / list-detail / two-press x / dismiss / tools | S5: README navigator section | docs | n/a (docs) |
| Full unit suite + integration smokes valid | gates | — | — |

## Notes

- Prefer pure seams in `navigator.mjs` (no pi imports). Index wiring stays thin.
- Hardening gap closed if found: `refreshRows` must keep selection by id (not bare index) when the visible set reorders or shrinks — extract `applyNavigatorRows` for testability.
- Reload hardening: `session_start` disposes any tracked overlay and clears the close-confirm status before reinstall/republish (defensive if host skips shutdown).
- Do not change stop/dismiss/widget/non-TUI contracts from #44–#47.
- Widget non-regression pinned by existing `tests/widget_flicker.test.mjs`.

## Status

| Slice | RED | GREEN | Notes |
|-------|-----|-------|-------|
| S1 narrow list/detail | pass (char) | pass | list+detail post style-strip; existing #45/#46 pins retained |
| S2 selection stability/clamp | pass (applyNavigatorRows missing) | pass | `applyNavigatorRows` + overlay `refreshRows` keep-by-id |
| S3 footer/timers/reload/wrappers | pass (session_start missing dispose) | pass | session_start dispose + confirm clear; editor dedupe char; registered reload path in navigator_reload_extension_path.test.mjs (behavior, not source scan) |
| S4 widget + non-TUI | pass (char) | pass | widget.mjs isolation + isNavigatorUiAvailable + widget_flicker suite |
| S5 docs | pass (README missing) | pass | README Subagent navigator section + docs pin test |
