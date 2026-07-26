# Product

## Register

product

## Users

Active Pi users working in the TUI while background work is running. They need to stay in flow, spot work that needs attention, and inspect or stop tasks without losing context.

## Product Purpose

pi-better-harness improves Pi's operational ergonomics for subagents, background tasks, and goal continuation. The background work navigator exists to make concurrent work visible, scannable, and controllable from the TUI without turning the interface into a dashboard or debug dump.

Success means the user can quickly distinguish healthy running work from failed, lost, stale, or stoppable work; inspect the evidence behind a state; and take safe action with minimal friction.

## Brand Personality

Compact, precise, composed. The feel should be close to Raycast: keyboard-first, dense, crisp, and immediate, while still feeling native to Pi's terminal interface.

## Anti-references

Avoid debug-dump interfaces where raw metadata dominates the main path. Avoid large dashboard cards, decorative operational charts, modal-first management, chat-transcript rows, and verbose prose in list surfaces.

## Design Principles

1. Triage first: surface the status, name, age, and next action before secondary evidence.
2. Progressive detail: keep the list dense, then expose logs, process metadata, and health evidence in a structured drill-in view.
3. Safety without ceremony: destructive or interrupting actions need clear confirmation, but should remain keyboard-fast.
4. Native restraint: use Pi's theme vocabulary, terminal alignment, and predictable keybindings instead of decorative chrome.
5. State must be legible without color alone: status text, grouping, and affordances carry meaning alongside semantic colors.

## Accessibility & Inclusion

Target WCAG AA contrast for semantic colors where the host theme allows it. Use color plus text labels for status meaning. Avoid motion and flicker; state changes should be stable, predictable, and usable with reduced-motion preferences.