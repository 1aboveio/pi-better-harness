# Next-prompt suggestions

Status: research-backed proposal; not implemented or approved for delivery.

## Confirmed scope

The user selected **next-prompt suggestions**, not completion while typing, and
**opt-in model calls**, not enabled-by-default inference. The audience is a Pi
user choosing what to ask after a completed response. Visitor mode: Operate.
Inherit Pi's editor, theme, borders, typography, and keyboard-first restraint.
Do not redesign the editor or introduce a suggestions panel.

## Reference behavior

[Claude Code's current docs][claude-interactive] describe gray next-prompt text
after a response. Tab or Right Arrow places it in the input; Enter subsequently
submits. Typing dismisses it. Generation is a short, billable background request
to the session model. Startup examples selected from git history are a separate
behavior. Setting defaults and effective availability differ because of feature
flags, providers, and telemetry. See the [cited evidence](../research/claude-code-prompt-suggestions.md)
for gates, historical input/cache bugs, and unresolved details.

Adopt the two-step interaction. Do not copy Claude's telemetry requirements,
assume suggestions are free, or infer undocumented generator settings.

## Interaction

Illustrative editor content, using the existing Pi chrome:

```text
Before acceptance (empty buffer; text is gray):
| Run the focused tests for the sandbox permissions change

After Tab or Right Arrow (normal editable buffer):
Run the focused tests for the sandbox permissions change|
```

The vertical bar illustrates the cursor, not a new UI glyph.

| Situation | Behavior |
| --- | --- |
| Suggestion ready; empty, focused editor | Show one gray, single-line preview at the cursor. No box, transcript entry, carousel, spinner, or added footer row. |
| Tab or unmodified Right Arrow | Insert the complete suggestion as one undoable edit, move cursor to its end, and clear ghost state. Never submit. |
| Enter with only ghost text | Delegate normal empty-input behavior. Never accept, submit, or queue the suggestion. |
| Typing, paste, history recall, external-editor edit, or programmatic draft change | Cancel pending inference and dismiss the suggestion. Preserve the user's input exactly. Do not bring it back when the buffer is cleared. |
| Esc | Dismiss a visible suggestion only when the editor owns focus and no higher-priority interaction is active. Otherwise preserve host behavior. This is a proposed Pi addition, not verified Claude parity. |
| Navigator, autocomplete, modal editor mode, or dialog owns keys | Suppress ghost text; the owning interaction wins. Never intercept its Tab, arrows, Esc, or Enter. |
| Resize or theme change | Re-render preview within available terminal columns; retain cursor/focus geometry. |
| Timeout, invalid output, unsupported provider, or no useful continuation | Remain quiet; no suggestion is a valid outcome. Status command exposes the reason. |

Preview at most one visual line; truncate at terminal-column boundaries and use
an ellipsis only when needed. Bound accepted text to 160 graphemes. Preserve CJK,
combining characters, and the host's IME cursor marker. A narrow preview may hide
the tail; acceptance inserts all validated text for review before Enter.
Suggestion text is never part of getText(), history, exports, or agent context
until accepted. Undo returns to the empty draft, not to ghost state.

## Generation policy

Proposed initial bounds, subject to latency/quality measurement:

- Disabled by default. Enable from an explicit user command, with a one-time
  disclosure that recent conversation text goes to the active provider and
  additional usage may be charged. Projects and model-issued tools cannot enable it.
- TUI main session only; no calls in print, JSON, RPC, or subagent children.
- Trigger after `agent_settled`, not `message_end` or `agent_end`. Schedule
  asynchronously so inference does not hold up the settlement handler.
- Generate only following a user-originated interaction with a successful final
  assistant response, empty draft, no attached images, and no queued messages.
  Do not generate after slash-command-only actions, aborted/error responses,
  unsettled goal continuation, permission holds, or solely automated callbacks.
- One attempt per settled interaction; one request in flight; a 300 ms quiet
  window; a 4-second wall deadline including auth/provider setup; no retries.
  Cancellation stops local work and rejects late output but cannot undo provider billing.
- Use the active session's provider/model, with no automatic alternate-model
  fallback. Request no optional reasoning where supported, cap output at 128
  tokens, and omit tools. Providers that cannot honor required bounds are ineligible.
- Send a standalone, bounded text context: recent user/assistant exchanges on
  the active branch, at most 8,000 characters including generator instructions.
  Preserve the newest user intent and final response; omit complete older
  exchanges first. Skip if essential context cannot fit. Exclude raw tool
  payloads, hidden reasoning, images, credentials, and new file/git scans.
  This reduces data exposure but is not a guarantee of secret-free conversation text.
- Ask for one plausible next user message in the user's language, or no
  suggestion. Prefer unfinished explicitly requested work or a response to a
  question; do not invent authorizations to publish, pay, delete, merge, or
  bypass restrictions. A generator instruction is not a security guarantee.
- Validate output: one plain-text line or an explicit no-suggestion result;
  no tool calls, terminal control sequences, bidi/invisible controls, multiline
  payloads, or leading `/`, `!`, or `@` command syntax. No space-count heuristic
  that rejects languages without spaces. Reject invalid/oversized output, rather
  than turning it into another meaning through aggressive cleanup.
- Following five displayed-but-unused suggestions, skip generation for the next
  three eligible interactions. Reset on acceptance. No telemetry or remote flags.

The bounded request intentionally **does not promise Claude-style prompt-cache
reuse**. Different context and omitted tools usually change the cached prefix.
The input/output limits bound request size, not a universal dollar ceiling or
all provider-side reasoning costs. Full transcript cache reuse is a later,
provider-proven optimization, not part of v1.

## Freshness and safety

Stamp requests with session, active branch leaf, model/provider, interaction
revision, and editor revision. Recheck eligibility at schedule, dispatch,
completion, display, and acceptance. Abort/invalidate on typing, input submit,
agent start, branch/session switch, compaction, model changes, disable, reload,
or shutdown. A queued callback that resumes work invalidates suggestions too.
Returning to an empty editor never revives an obsolete request.

Generation is trusted runtime provider transport under [ADR 0007](../adr/0007-trusted-runtime-task-boundary.md),
not a sandboxed task or a subagent. Give it no shell, filesystem, network task
tools, or continuation control. Task Network Off remains independent of Pi's
provider connection; disclose that distinction when enabling. Accepting text
confers no permission: submission still goes through normal task admission and
approval rules. Do not let generated text silently expand into a command.

## Settings and observability

Confirmed configuration entry point: **`/harness-settings`**, a Harness-owned
screen using Pi's native `SettingsList`. Leave the built-in `/settings` untouched;
Pi 1.0.0 has no public extension-setting registration API.

Initial local row: `Prompt suggestions`, values `off` / `on`, default `off`. Its
description discloses additional model usage and recent conversation sharing
with the active provider. Changing off to on requires explicit user confirmation;
cancelling leaves the setting off. Changing to off immediately cancels pending
inference and clears ghost text. Esc closes the screen and restores editor focus
without changing the draft. Do not add settings for unimplemented features.

Persist explicit preference using user-owned Harness configuration conventions;
session entries may record local overrides but cannot authorize global opt-in.
Do not edit the upstream Pi settings schema or enable via project configuration.
A separate status/detail view reports on/off, active model, last skip/error reason,
and auxiliary input/cache/output tokens and provider-reported cost when available.
Keep operational details out of the settings list. A dedicated
`/prompt-suggestions` command is not required for v1.
Label missing pricing or usage as unknown, not zero. Persist accounting metadata
without prompt/suggestion text or auth material; no analytics service.

Auxiliary usage must not appear as a fictional assistant/tool message. Verify
whether the supported SDK has a public auxiliary-usage accounting API; otherwise
keep an explicit Harness ledger and label it as separate from host totals.
Provider failures should pause automatic requests until re-enabled or the model
changes, avoiding repeated auth errors or rate-limit traffic.

## Package settings shortcuts

Confirmed: `/harness-settings` also provides shortcuts to settings owned by
loaded `pi-better-*` packages. Their existing commands and screens remain the
canonical entry points and continue working without Harness installed.

Use two native list groups: Harness-local options and package-settings links.
Links are actions, not duplicated on/off rows. Show the destination command as
secondary text so users can find it directly next time. Enter opens the package's
screen; returning to the hub restores its selected row and the untouched draft.
Closing the hub restores editor focus. Never automatically execute a toggle or
state-changing command just by following a settings link.

Verified current destinations:

| Link | Package-owned destination |
| --- | --- |
| Sandbox | `/sandbox` permissions UI |
| Subagents | `/subagents settings` |
| Goal | `/goal settings` |

Plan currently exposes `/plan` and display commands, not a dedicated settings
screen. Tool output exposes `/tool-output`, whose no-argument behavior toggles
state, so it is not a safe open-settings shortcut. SSH and Background Tasks have
no settings command in the inspected entry points. Do not fabricate destinations
or invoke model tools to simulate opening settings. Those packages can add their
own settings screens later and then contribute links. Read Aloud is optional;
show its link only if it supplies a real settings contribution.

Proposed small runtime contribution contract: stable package/id, label,
destination command for display, and an `open(ctx)` callback owned by the package.
Both the direct command and hub action call the same package-local settings
opener. Package code owns validation, persistence, live effects, and confirmation;
Harness owns discovery, list ordering, and navigation only.

Use `pi.events` for discovery/registration following existing inter-extension
patterns: request a snapshot after hub startup and respond to registrations in
both extension load orders. Clear registrations on reload/shutdown and ignore
stale callbacks. Namespace and deduplicate ids; detect conflicting registrations
rather than silently replacing another package's contribution. Registry messages
carry UI callbacks only inside the trusted runtime, not model-callable tools.
No package may import or require the Harness bundle. If a small shared helper is
needed, package it into each standalone consumer, preserving independent installs.

Only advertise available settings providers; never list unloaded packages or
make installation a prerequisite for using the hub. A standalone package need
not show a hub or register `/harness-settings` itself. Without Harness, its normal
command opens precisely the same settings and writes precisely the same store.
Settings changes through either entry point must immediately agree; no second
copy of package configuration is kept in Harness.

Before shipping, prove hub-first/package-first load order, reload/unload cleanup,
partial and standalone installs, correct settings routing, unchanged draft and
focus on return, and identical persistence/confirmation behavior through both
entry points. Opening each link must produce zero agent turns and no toggle or
task effects until the user makes a choice inside the destination screen.

## Pi integration findings

- `packages/navigator/index.ts:623` installs a factory that wraps the previous
  editor. Its empty-editor handler owns Left Arrow and navigator interactions.
  Do not replace this with an independently constructed editor. Extend this
  shared composition path with narrowly scoped suggestion render/input state;
  maintain the mounted/focused editor checks and restore only owned factories.
- Public editor APIs provide `getText`, `onChange`, `getCursor`,
  `insertTextAtCursor`, and `render`. Preserve callback chains, focus, application
  shortcuts, and undo; do not use a filled buffer as a fake placeholder.
- No public ghost-text method is exposed by the checked editor declaration.
  A small render adapter may be necessary; it must be restricted to the empty
  buffer case and covered by real TUI tests. Do not depend on private editor
  fields. Foreign custom editors without compatible focus/render semantics
  should disable suggestions rather than be overwritten.
- The checkout resolves Pi **0.82.1**. `agent_settled` exists, but its ModelRegistry
  does **not** expose the `streamSimple` method documented in globally installed
  Pi **1.0.0**. Verify a provider-neutral request path including auth, headers,
  environment overrides, custom providers, and cancellation against the minimum
  supported runtime. Prefer raising the declared minimum to the needed public
  API over hardcoded HTTP, private runtime access, or partial auth shims.

Local evidence inspected: checkout `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`,
`dist/core/model-registry.d.ts`; `node_modules/@earendil-works/pi-tui/dist/components/editor.js`;
global Pi `docs/extensions.md`, `docs/tui.md`, and `examples/extensions/modal-editor.ts`.
These are versioned local observations, not stable cross-version guarantees.

## Proof before shipping

1. Ghost-only Enter never submits; Tab/Right accepts without submitting; undo
   restores the previous draft. Typing/paste/history/programmatic edits are preserved.
2. Slow completion after any invalidation cannot overwrite or reappear over a
   draft. Queued input, goals, permission holds, compaction, branch changes,
   and background callbacks cannot race acceptance.
3. Navigator focus, slash/file completion, modal editors, extension shortcuts,
   Ctrl+C, and host Esc behavior retain priority, in both extension load orders.
4. Real TUI captures prove one-line layout, no extra vertical chrome, theme and
   resize behavior, cursor/IME placement, CJK/combining text, and narrow widths.
5. A recording fake provider proves opt-out makes zero requests; budgets,
   cancellation, no retries, no tools, output rejection, and cooldown hold.
   Installed-package tests cover the declared minimum SDK and current SDK,
   plus custom auth/provider headers and unavailable providers.
6. A small live opt-in evaluation measures useful follow-ups, latency, ignored
   frequency, and actual auxiliary usage. Acceptance is a usefulness signal,
   not a claim that the suggested action was safe or correct.

## Approval boundary

Research and design only. No runtime code, version changes, personal settings,
PR, publication, or release in this task. Before implementation, confirm this
proposal and resolve the minimum SDK/model-transport and usage-accounting path.
Startup git-derived prompts, predictive typing, alternative-model routing, and
remote telemetry are explicitly outside v1.

[claude-interactive]: https://code.claude.com/docs/en/interactive-mode#prompt-suggestions