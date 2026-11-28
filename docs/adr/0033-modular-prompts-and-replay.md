# Modular Harness prompts and replay

## Status

Accepted 2026-11-28. [Epic #945](https://github.com/1aboveio/pi-better-harness/issues/945) and [PR #956](https://github.com/1aboveio/pi-better-harness/pull/956) delivered the initial module, revision and replay operations. The product amendment below sets the order for the maintainer interfaces. First ship prompt management in both the Pi TUI and a local browser. Then add replay and evaluation to those same interfaces.

## Why this belongs in Harness

A writing skill is easy to edit and try. To tell whether an edit helped, a maintainer needs the request that produced the original answer. Asking the agent to rewrite that answer supplies different evidence. Conversely, an established rule that should guide every task needs to reach the model even when a skill was never opened. Harness already owns a startup addendum with a tested compaction lifecycle. It will own the edit and replay loop for those rules as well.

## Authoring and loading

Keep an ordered template of Markdown modules. The package owns each bundled original and its position. The local user owns their own modules, the per-bundled-module text overrides and the inclusion choices. Give each module a stable identifier. The same sources and order produce identical rendered text. Render the active revision into the existing Harness-owned block in global `<agent-dir>/APPEND_SYSTEM.md`. Harness instructions remains opt-in. Use the existing CLI, settings and block writer. Preserve user text outside the markers and the effective precedence of saved prompt text, custom source files and the bundled default. A user can explicitly adopt the modular default from an existing override.

Pi selects the effective addendum. A trusted project's `.pi/APPEND_SYSTEM.md` or an explicit `--append-system-prompt` can supersede global discovery. Inspection and replay must identify the source actually loaded. Ordinary turns, compaction and model switches retain the loaded global text. A fresh process or explicit resource reload picks up the installed revision. All models share one module set. Keep revision IDs, timestamps and experiment state in the revision store and replay results. [Startup and cache contract](0021-prompt-prefix-stays-cached.md)

Seed the modules with concise, previously validated principles for communication, engineering, verification, ownership, decision making and collaboration. Keep provenance, examples and scoring notes alongside the sources. For example, a status answer should disclose outstanding verification when the user is deciding whether to close delivery. A narrow question about a single run can be answered with that run's result.

Skills remain a fast way to try uncertain wording, and continue to own domain knowledge and multi-step workflows. Project-specific conventions stay in project instructions such as `WRITING.md` or `CONTRIBUTING.md`. Once a rule shows value across projects, promote its stable core into one module. Skills may then reference that core and keep their procedures and examples. Replay makes a separate experimental writing skill optional. [Subagent skill exposure](../../packages/pi-better-subagents/docs/adr/0005-catalog-skill-exposure.md)

## Bundled and user prompts

A module’s catalog origin and the author of its effective text are separate facts. The original decision in [#961](https://github.com/1aboveio/pi-better-harness/pull/961) protected the shipped source. This amendment lets local maintainers edit every module in place and retains that source as the reset target. Web, Pi TUI and authorized agent edits use the same candidate and ownership rules.

| Module | Local editing | Reset or recovery |
| --- | --- | --- |
| Bundled | Edit the effective text in its existing package position. The first text change stores a user-owned override keyed by the stable bundled ID. Read the original and its package version alongside it. Enable or disable the module independently. | **Reset to original** removes only the selected override in the working draft. The editor and included preview range immediately resolve to the exact shipped bytes from the draft’s package snapshot. |
| User | Create, edit, order and remove local modules. An identically named user module has its own origin-qualified ID and revision history. | Recover a previous user-authored version through revision history. A user-only module has no package default. |

For each bundled slot, resolve text from the local override when present, otherwise from the pinned original. Treat an intentionally empty override as present. Include the result exactly once in package order when enabled, followed by user modules in user order. Disabling a slot retains its override. Re-enabling it restores the same effective text. Reset works while disabled and leaves it disabled. Editing or resetting changes only the draft until save and explicit publication. Other modules, previously saved revisions, installations and loaded sessions retain their own state.

Preserve the original bytes, shipped version or digest, the override’s base digest and exact local bytes separately. The shared mutation path used by Web, Pi TUI, `prompt_edit` and `prompt_propose` accepts scoped override edits and resets at an expected revision. It protects package bytes, package ordering, origin and upstream evidence from writes. The whole-text global override and the global instructions switch remain separate settings.

On package upgrade, existing local overrides and toggles follow the stable bundled IDs. Show when the package original changed since an override was authored. An up-to-date draft resets to the new package default. A historical revision keeps its pinned original and effective bytes for exact replay and rollback. Existing revisions without overrides continue to render as before. Preserve legacy user content and independent same-name modules without guessing an override from a name match.

Package validation is attached only to the shipped original and its tested scope. Local override text is user-authored. Replay and evaluation bind each arm to its exact revision, bundled originals, inclusion state, override presence and effective content. A reset can restore the shipped text while the local composition and revision pair still have their own evidence.

## Candidate, active and loaded revisions

1. An agent uses `prompt_list` and `prompt_read` to inspect the effective source and its modules. `prompt_edit` targets one user module or one named bundled override at an expected revision and returns an immutable candidate ID, parent and diff. Further edits can branch from that candidate. The active revision is the one selected for installation. A session records the revision or digest it actually loaded.
2. `prompt_replay` runs the selected original input with the baseline and candidate. `prompt_compare` connects both outputs, the comparison rubric and the judgment to those exact revisions. Record the effective context, provider, model, settings and run identity needed to interpret the result. Missing inputs, changed settings and inconclusive evidence are visible outcomes.
3. `prompt_promote` requires explicit authority for the evaluated revision and checks its expected active base. `prompt_rollback` explicitly restores a known prior rendering. Apply the revision selection and block update so a stale editor cannot overwrite a newer choice and an interrupted operation can be retried. An experiment cannot enable a disabled block or silently replace a custom prompt. A running session adopts an activated change at the resource boundary above.

The maintainer's existing direct settings editor remains an intentional settings action. The candidate and evidence requirements govern the new agent-driven path. Store revision history separately from global preferences. [Settings ownership and persistence](0014-global-harness-defaults.md)

## The maintainer's prompt manager

The local Web console and Pi TUI use the same selected agent directory (`PI_CODING_AGENT_DIR`). A maintainer can edit and save with no active conversation, managed daemon or model provider. The browser serves the local maintainer on loopback and verifies that mutations come from its authorized UI. [Local console decision](0023-unified-server-runtime.md#本地-web-管理页) · [Launcher implementation #970](https://github.com/1aboveio/pi-better-harness/issues/970)

| Starting point | Action | Landing |
| --- | --- | --- |
| Terminal, working on prompts | `pi-better-harness instructions web` | Opens **Prompts → Edit** in the default browser. The CLI prints a private local URL. Set `BROWSER=none` to open that URL manually. Keep the CLI running while using the page. |
| Terminal, managing the server | `pi-better-harness web` | Opens **Server** in the same console. Select **Prompts** to reach **Edit**. |
| Active Pi TUI | `/harness-settings → Prompt manager → Open in browser` | Opens **Prompts → Edit** using the TUI’s agent directory. The existing TUI manager remains accessible from the same menu. |

Opening the page is independent of granting access to session captures. For single-response Replay, the maintainer chooses **Connect browser** in the owning Pi session and selects that session and request in the browser. Entering a view never starts a model request. The prompt workflow is **Edit → Save → optional Replay**, with only **Edit** and **Replay** in the workspace navigation.

| Local user action | Product behavior in both interfaces |
| --- | --- |
| Inspect the prompt | Show the selected global source (Off, modular, saved text or custom file), the active revision, each module’s origin and enabled state, and the rendered preview. Report what a named Pi session actually loaded when available. A standalone browser shows that session state is unavailable until one is connected. |
| Prepare a change | Start from the active revision or a saved candidate. Toggle bundled modules, edit or reset bundled overrides, or add, edit, order or remove user modules in the candidate, then preview the complete prompt. Review changes inline as needed. Save creates an immutable local revision with its parent, even offline. Saved candidates from either interface or the agent are discoverable after restart. |
| Review and publish | Review a draft or reopen a previously saved candidate. Show the baseline and comparison target, bundled selection changes, local override edits or resets and user-module text or order changes before the user confirms local publication. Record the explicit human review and the actual revision transition in history. Opening, editing and publishing here require zero model requests. |
| Recover | Show past activations and allow an explicit rollback. A stale editor keeps its candidate and identifies the newer active base. Preserve the installed block under Off or an override. Show when a session needs a reload to adopt a published revision. |

Use one catalog and one implementation of version checks, installation and history across the TUI, Web and agent tools. Existing revisions and activation records remain readable. Discover older agent-created candidates from the existing store. Keep selection stable when the user moves between interfaces. Read or refresh on open, an explicit refresh or a relevant change, within the performance rules in [ADR 0032](0032-runtime-performance-design.md).

Human publication is an explicit local user operation, like saving in the existing settings editor. It records a manual review of the selected diff. Model-driven promotion still requires evaluation evidence for the exact revision pair and maintainer confirmation. History identifies which action occurred. Neither path silently enables the block or converts an existing override.

## Replay and evaluation from a selected revision

Save creates a local, immutable candidate. It works without a provider, capture, suite or connected session. It makes no model request. The maintainer can stop at Save and return later, including from the other interface. A just-saved candidate starts as **Untested**. Activation remains a separate explicit operation.

Replay takes two saved revision IDs, a baseline and a candidate. **Single response** reruns one captured request from its owning session for both versions. **Case suite** runs both versions against reviewed cases and evaluates their responses against rubrics. Either mode can run independently. Evaluation is the act of judging outputs. It can cover one pair of responses or a suite. Response, turn and task describe reconstruction depth.

At Run, pin both revision identities, their original and effective module bytes, the exact capture or suite, provider/model, settings and samples. Record each result and judgment against that pair. A later edit or save cannot retarget existing evidence. Record unavailable inputs or an unsupported provider as a run outcome. The user can return to Edit at any time.

## Web workspace for a selected revision

This amendment refines the interfaces delivered for [#958](https://github.com/1aboveio/pi-better-harness/issues/958) and [#959](https://github.com/1aboveio/pi-better-harness/issues/959) in [#962](https://github.com/1aboveio/pi-better-harness/pull/962). The workflow is **Edit → Save → optional Replay**. The Prompt Manager navigation contains exactly **Edit** and **Replay**. [Screen designs and state transitions](../design/local-server-web/prompt-manager.md)

| View | Interaction |
| --- | --- |
| Edit | Select a module, edit its effective Markdown or reset a bundled override. Keep the complete composed draft visible. Selection or typing reveals the exact module range by origin-qualified ID and keeps the editor caret in place. Excluded modules have an omission notice. Review the diff inline if desired. **Save revision** persists the candidate and shows its ID alongside the active revision. The editor stays open. **Replay saved revision** opens Replay with that candidate selected. |
| Replay | Select a saved baseline and candidate, including historical revisions. Choose Single response or Case suite and start the run explicitly. Display both arms, their provenance, run status and any judgment here. Navigating with pending edits preserves the draft and clearly identifies the saved pair used for the run. |

The TUI, Web and agent tools share saved identities, rendering and the evidence store. Manual local publication retains its diff confirmation and expected-active-base check. Evaluated promotion retains its exact-pair evidence and confirmation requirements. Existing sessions pick up an installed revision on reload.

## What each replay reconstructs

| Level | Starting point | Evidence and isolation |
| --- | --- | --- |
| Response (P0) | The input immediately before the selected assistant response, including any earlier tool results already in context | Generate baseline and candidate with independent provider continuation state. Keep tool definitions consistent and execute no tools. Record a tool request as an outcome. The old answer is a labeled reference and is excluded from both inputs. |
| Turn (P1) | The input before the original user turn is processed, plus that user turn | Run the bounded tool loop with recorded or isolated tool results. Report the first unsupported divergence, actions taken and the terminal result. |
| Task (P2) | The original task and a reproducible starting workspace checkpoint | Run each revision in its own restored workspace. Compare resulting diffs and original acceptance checks. Identify missing inputs and unsupported external effects. |

Across all levels, vary just the selected prompt content in a paired comparison. Preserve project instructions, loaded skills and other context that actually reached the model. If the global block was shadowed or the input cannot be recovered, report that limitation. Use an isolated replay identity and keep the source transcript, workspace and foreground continuation intact. Equivalent inputs allow a fair comparison even when model outputs vary.

## Delivery and verification

The original implementation milestones were as follows.

- P0 delivers the template, first principles, revision lifecycle, agent edits and response comparison. Prove the entire loop with one writing case. Use the existing Pi request fixture to verify exact-once presence across compaction and adoption after reload.
- P1 adds a tool-using turn and portable, sanitized historical cases. Report both improvements and regressions against paired examples, with settings and sample counts.
- P2 adds task replay and opt-in learning from selected cases. Learning may propose and evaluate candidates. Activation uses the same explicit promotion path.

Verify the product amendment with two independent journeys.

1. With no provider configured, edit a bundled override in the TUI, switch the module off and on, and edit a user module. In Web verify that the override survives both toggle changes, reset just that slot, verify the exact shipped bytes and save. Reopen that candidate in Web, inspect the selection and text changes and explicitly publish it. After a Pi reload, verify the selected revision was loaded. Roll back from the other interface and recover the prior rendered bytes.
2. Save a candidate offline without visiting Replay. Later run Single response and Case suite against the same two saved revisions with a supported fixture. Reopen the evidence and judgment in the other interface. Save another edit and verify it starts untested while the original pair retains its results. Exercise activation separately.

Template rendering runs when its sources or selection change. Replays and evaluations run on demand. Ordinary turns and compaction incur no extra history scan, provider request or template rewrite. [Runtime performance principles](0032-runtime-performance-design.md)
