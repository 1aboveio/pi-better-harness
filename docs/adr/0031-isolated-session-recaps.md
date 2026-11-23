# Isolated session recaps

## Status

Accepted.

## Decision

Harness owns an optional Recap panel above the interactive editor. Enable **Session recap** in `/harness-settings` to allow a separate model request after a foreground run settles. Collection defaults to Off because it sends an additional request to the configured provider. The same settings page offers an editable **Recap prompt**, prefilled with the effective instructions. Clearing it restores the default. Save both preferences as user defaults. Only the auxiliary request receives this prompt. Editing it takes effect on subsequent recaps. Ordinary Pi conversations, including sessions without a Goal, Todo or workflow, use the same feature.

The request summarizes the current subject in the language of the conversation. Recap describes the result and preserves qualifications. Next is optional and describes a follow-up already agreed in the conversation. A displayed next step grants no authority to launch work, steer the agent or change Goal, Todo or workflow state.

Use the model that produced the final answer and the host's public, authenticated provider transport. Give the auxiliary request a fresh identity and independent continuation state. Supply bounded recent user and final assistant text from the current branch. Exclude system instructions, thinking, tool inputs, tool output, attachments and earlier recap records. The auxiliary model has no tools. An unavailable transport, missing model, timeout or invalid reply leaves the main session free to continue. Keep request and display text bounded. Record auxiliary usage separately from the foreground conversation when the provider supplies it.

Render only a validated result for the latest settled answer on the current branch. New work, navigation, shutdown and disabling Recap invalidate pending results. Save the result with its source answer ID in a Pi custom entry. Restore it from the active branch on return or reload. Rendering and restoration make no provider request.

The foreground system prompt, tool definitions, message history, provider session identity and continuation remain identical with Recap enabled or disabled. The panel never injects a custom message or demands a structured final answer. The provider controls cache residence and actual hit rates. Prompt-prefix stability remains governed by [ADR 0021](0021-prompt-prefix-stays-cached.md). The next-prompt proposal in [ADR 0013](0013-harness-settings-and-next-prompt-suggestions.md) remains deferred.

## Acceptance

1. A normal interactive conversation can display Recap and an optional Next after settlement. A restore reuses the matching branch entry. Work from a sibling branch, an interrupted answer or a late request cannot replace it.
2. Compare two foreground requests with and without an intervening auxiliary call. Observe the inputs and identity at the transport boundary, including the next foreground continuation. Check cache reads against a deterministic provider baseline. Keep provider cache eviction outside this guarantee.
3. A slow or failed provider, repeated settlement, cancellation, disabled collection and noninteractive modes leave the foreground usable. No raw tool data or model-generated terminal controls are displayed.
4. From `/harness-settings`, toggle Recap, edit or cancel an edit to its instructions, restore the default and reopen the settings. Inspect the auxiliary prompt and the foreground requests after each change.
