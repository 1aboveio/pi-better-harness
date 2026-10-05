# Harness settings and next-prompt suggestions

## Status

Accepted. User approved a Harness settings hub, package-owned shortcuts, and
opt-in next-prompt inference. Verification accompanies the implementation.

## Decision

Keep Pi's built-in `/settings` unchanged. `/harness-settings` uses native TUI
settings components, provides the Harness prompt-suggestion control, and opens
settings contributed by loaded packages through a trusted runtime event bus.
Sandbox, Subagents, and Goal retain their normal commands and own the same
settings openers, validation, persistence, and confirmations. No standalone
package depends on installing Harness. Do not run an agent turn to open a screen.

Suggestions are off by default and enabled only through a user-confirmed,
user-owned preference. Generate one bounded candidate after a successful
user-originated interaction fully settles. The auxiliary request uses the
active physical model, recent user/assistant text, no task tools, and no retries.
It cannot authorize task execution. This is provider transport in the trusted
runtime described by ADR 0007, independent of task Network access.

The candidate exists only in render state until Tab or Right Arrow inserts it
as an undoable edit. Enter alone never accepts it. Input changes, model/session
boundaries, compaction, new work, and shutdown cancel requests and invalidate
late output. Suggestions yield to navigator and dialog input. Unsupported
editor implementations retain their existing behavior.

Shared input-ownership and factory-chain markers let the navigator wrap the
native editor transparently. An incompatible replacement disables the old
adapter and reports a status reason.
Unknown factories are not recreated to probe their editor type, preserving
opaque modal state. Only the stock native editor and declared transparent
decorators are supported.

The provider single-flight guard survives
extension reload and remains held until the public response stream settles,
even when local cancellation rejects before an abort-insensitive provider ends.

Use the public model transport available on the running Pi version. Skip
providers that cannot honor the request bounds instead of using private runtime
objects, hardcoded HTTP, or another model. The inspected stock Codex and Bedrock
transports and virtual-model routes are ineligible. Cache reuse and fixed dollar
cost are not promised. Auxiliary usage metadata is separate from Pi totals;
unreported usage/pricing is unknown, not zero. No remote telemetry is added.

## Verification

Run native-editor tests for acceptance/submission separation, undo, draft edits,
callback rewiring, wide-character preview, and foreign editors. Exercise
discovery order, conflicts, cleanup, and identical settings ownership through
direct commands and hub callbacks. Use a real TUI journey with a recording fake
provider for package navigation, explicit enabling, generation without tools,
and ghost-only Enter. Engine/transport tests cover opt-out, timeout, cancellation,
stale output, cooldown, auth headers, output validation, and unsupported APIs.

Implementation policy and primary-source evidence are in
[the design](../plans/prompt-suggestions-design.md) and
[the research](../research/claude-code-prompt-suggestions.md).