# Harness settings and deferred next-prompt suggestions

## Status

Accepted for the settings hub. Next-prompt inference deferred by the user on
2026-10-05, pending [issue #426](https://github.com/1aboveio/pi-better-harness/issues/426)
and independent review before integration.

## Decision

Keep Pi's built-in `/settings` unchanged. `/harness-settings` uses native TUI
settings components and opens settings contributed by loaded packages through
a trusted runtime event bus. Sandbox, Subagents, and Goal retain their normal
commands and own the same settings openers, validation, persistence, and
confirmations. No standalone package depends on installing Harness. Do not run
an agent turn to open a screen.

Contributions publish `{ id, label, command, open }` on
`harness-settings:register` at load and on `harness-settings:request`. Harness
rejects malformed entries, deduplicates identical callbacks, removes conflicting
IDs, and cleans listeners on shutdown. Opening a package screen and closing it
returns to the hub with the same selection. Packages without a real settings
screen do not receive invented shortcuts.

Inline controls may publish `{ id, label, values, get, change }` on the same
trusted bus. Their owning extension retains runtime state and persistence;
Harness only renders the native selector and waits for successful changes.
Tool output contributes Normal/Minimal through this contract. The existing
`/tool-output` command uses the same change path, with session-only persistence,
branch restoration, and failed-save rollback. Callback Ctrl+S remains scoped to
callback defaults and does not save a tool-output default.

The user selected prototype B (inline context) and requested full expansion on
click on 2026-10-06. The visual studies are captured on the throwaway
`prototype/tool-output-exploration` branch at `53a0a14`. Production translates
that direction into quiet theme-colored tool names and inline arguments, not
browser icons or status badges. Newer fullscreen Pi mouse routing expands the
folded row into its original native rendering; expanded interaction is delegated
to Pi. Regular terminals retain native selection/scrollback, with Ctrl+O as the
keyboard alternative. No result payloads are rewritten.

Harness additionally owns the shared **Completions while busy** control.
Changes are branch-local session entries and take effect immediately for both
callback producers. Ctrl+S explicitly saves the current value as the user
default for future sessions; already-open sessions retain their initial default
when navigating to an unconfigured branch. The shared callback module owns validation,
atomic default persistence, session restoration, and runtime mode updates;
standalone callback packages consume the same defaults without depending on
Harness. Environment-variable mode selection is removed now that the control
is available in settings. Package-owned settings shortcuts remain unchanged.

## Inference Deferral

The proposed opt-in next-prompt experience requires a bounded auxiliary request
using the active physical model and its public provider transport. Pi 0.82.1 and
1.0.0 do not expose the loaded raw configuration for composed auth/header
resolution. Command-backed headers can synchronously block the event loop,
preventing cancellation and the four-second whole-request deadline. Inspecting
the current default models.json cannot certify a custom path or a stale loaded
snapshot. Private runtime fields and silent alternate-model fallback are not
acceptable substitutes.

A fail-closed implementation can certify only untouched native registrations;
the user chose deferral instead of shipping that reduced compatibility. This
version therefore contains no inference runtime, suggestion toggle, preference
store, or editor adapter. The original research/design remains available for
future work. Issue #426 defines header compatibility, deadline/cancellation,
usage accounting, eligibility, and independent-review gates before integration.

## Verification

Exercise discovery order, malformed entries, conflicts, cleanup, and identical
settings ownership through direct commands and hub callbacks. Use a real TUI
journey for package navigation and returning to the hub, proving settings never
invoke the model. Run the journey on the checkout and installed Pi CLI versions
and through a disposable npm-installed Harness bundle.

The future policy and primary-source evidence are in
[the design](../plans/prompt-suggestions-design.md) and
[the research](../research/claude-code-prompt-suggestions.md).
