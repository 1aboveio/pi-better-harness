# Modular Harness prompts and replay

## Status

Accepted 2026-11-28. [Epic #945](https://github.com/1aboveio/pi-better-harness/issues/945) and [PR #956](https://github.com/1aboveio/pi-better-harness/pull/956) delivered the initial module, revision and replay operations. The product amendment below sets the order for the maintainer interfaces. First ship prompt management in both the Pi TUI and a local browser. Then add replay and evaluation to those same interfaces.

## Why this belongs in Harness

A writing skill is easy to edit and try. To tell whether an edit helped, a maintainer needs the request that produced the original answer. Asking the agent to rewrite that answer supplies different evidence. Conversely, an established rule that should guide every task needs to reach the model even when a skill was never opened. Harness already owns a startup addendum with a tested compaction lifecycle. It will own the edit and replay loop for those rules as well.

## Authoring and loading

Keep an ordered template of Markdown modules. The package owns bundled module content and ordering. The local user owns their own modules and chooses which bundled modules participate. Give each module a stable identifier. The same sources and order produce identical rendered text. Render the active revision into the existing Harness-owned block in global `<agent-dir>/APPEND_SYSTEM.md`. Harness instructions remains opt-in. Use the existing CLI, settings and block writer. Preserve user text outside the markers and the effective precedence of saved prompt text, custom source files and the bundled default. A user can explicitly adopt the modular default from an existing override.

Pi selects the effective addendum. A trusted project's `.pi/APPEND_SYSTEM.md` or an explicit `--append-system-prompt` can supersede global discovery. Inspection and replay must identify the source actually loaded. Ordinary turns, compaction and model switches retain the loaded global text. A fresh process or explicit resource reload picks up the installed revision. All models share one module set. Keep revision IDs, timestamps and experiment state in the revision store and replay results. [Startup and cache contract](0021-prompt-prefix-stays-cached.md)

Seed the modules with concise, previously validated principles for communication, engineering, verification, ownership, decision making and collaboration. Keep provenance, examples and scoring notes alongside the sources. For example, a status answer should disclose outstanding verification when the user is deciding whether to close delivery. A narrow question about a single run can be answered with that run's result.

Skills remain a fast way to try uncertain wording, and continue to own domain knowledge and multi-step workflows. Project-specific conventions stay in project instructions such as `WRITING.md` or `CONTRIBUTING.md`. Once a rule shows value across projects, promote its stable core into one module. Skills may then reference that core and keep their procedures and examples. Replay makes a separate experimental writing skill optional. [Subagent skill exposure](../../packages/pi-better-subagents/docs/adr/0005-catalog-skill-exposure.md)

## Bundled and user prompts

Ownership follows where a module is authored. Show **Bundled** and **User** separately in the TUI, Web UI and agent catalog. A person operating the local manager has the same authority in either interface, even when that person also maintains the package.

| Origin | What a local user can do | Who changes the text |
| --- | --- | --- |
| Bundled | Read the shipped text, inspect its version and validation evidence, and enable or disable each module independently | A Harness package maintainer changes the source through a reviewed repository change. Ship new or changed bundled text with replay or evaluation evidence identifying the exact content and scope tested. |
| User | Create, edit, order and remove their own modules, then review and publish their local selection | The user, or an agent acting on the user's editable candidate |

The global Harness instructions switch still controls the entire block. Each bundled toggle records a separate selection in the user revision. Re-enabling a module restores its shipped text. Render enabled bundled modules in package order, followed by user modules in user order. Use origin-qualified identities so a user module called `communication` can coexist with the bundled one. To replace a bundled rule locally, disable it and create a user module. The new text has user provenance.

Apply ownership checks in the shared mutation path, including `prompt_edit`, `prompt_propose`, and publication. A caller cannot relabel a user module as bundled, submit replacement bundled text or change bundled order. Manual publication changes only the local composition. The whole-text settings editor writes a user override.

Preserve package provenance and local history independently. On upgrade, carry forward per-module choices by stable bundled ID and retain user content. Snapshots keep enough data to reproduce the earlier rendering and identify its bundled versions. Preserve legacy revisions with edited or unidentifiable bundled text as user-owned historical content, keeping previously active bytes and rollback targets readable. Show an evidence link only for the packaged content or composition it actually covers. Older shipped content with no recorded evidence is labeled accordingly.

## Candidate, active and loaded revisions

1. An agent uses `prompt_list` and `prompt_read` to inspect the effective source and its modules. `prompt_edit` targets one user module at an expected revision and returns an immutable candidate ID, parent and diff. Further edits can branch from that candidate. The active revision is the one selected for installation. A session records the revision or digest it actually loaded.
2. `prompt_replay` runs the selected original input with the baseline and candidate. `prompt_compare` connects both outputs, the comparison rubric and the judgment to those exact revisions. Record the effective context, provider, model, settings and run identity needed to interpret the result. Missing inputs, changed settings and inconclusive evidence are visible outcomes.
3. `prompt_promote` requires explicit authority for the evaluated revision and checks its expected active base. `prompt_rollback` explicitly restores a known prior rendering. Apply the revision selection and block update so a stale editor cannot overwrite a newer choice and an interrupted operation can be retried. An experiment cannot enable a disabled block or silently replace a custom prompt. A running session adopts an activated change at the resource boundary above.

The maintainer's existing direct settings editor remains an intentional settings action. The candidate and evidence requirements govern the new agent-driven path. Store revision history separately from global preferences. [Settings ownership and persistence](0014-global-harness-defaults.md)

## The maintainer's prompt manager

Open **Prompt manager** from `/harness-settings` in Pi, or launch the local Web interface with `pi-better-harness instructions web`. Both operate on the selected Pi agent directory. The Web manager can open without a running conversation. It serves the local maintainer on loopback and verifies that mutating requests come from its authorized local UI. The shared local console links to this manager from Prompts. Its Server and Sessions pages use the daemon socket independently, so a stopped daemon still allows local prompt editing. [Local console decision](0023-unified-server-runtime.md#本地-web-管理页)

| Local user action | Product behavior in both interfaces |
| --- | --- |
| Inspect the prompt | Show the selected global source (Off, modular, saved text or custom file), the active revision, each module’s origin and enabled state, and the rendered preview. Report what a named Pi session actually loaded when available. A standalone browser shows that session state is unavailable until one is connected. |
| Prepare a change | Start from the active revision or a saved candidate. Toggle bundled modules or add, edit, order or remove user modules in the candidate, then preview the complete prompt. Save an immutable revision with its parent. A draft saved in either interface, or by the agent, can be found and continued in the other after restart. |
| Review and publish | Select a candidate from the list. Show the base and candidate, bundled selection changes and user-module text or order changes before the user confirms local publication. Record the explicit human review and the actual revision transition in history. Opening, editing and publishing here require zero model requests. |
| Recover | Show past activations and allow an explicit rollback. A stale editor keeps its candidate and identifies the newer active base. Preserve the installed block under Off or an override. Show when a session needs a reload to adopt a published revision. |

Use one catalog and one implementation of version checks, installation and history across the TUI, Web and agent tools. Existing revisions and activation records remain readable. Discover older agent-created candidates from the existing store. Keep selection stable when the user moves between interfaces. Read or refresh on open, an explicit refresh or a relevant change, within the performance rules in [ADR 0032](0032-runtime-performance-design.md).

Human publication is an explicit local user operation, like saving in the existing settings editor. It records a manual review of the selected diff. Model-driven promotion still requires evaluation evidence for the exact revision pair and maintainer confirmation. History identifies which action occurred. Neither path silently enables the block or converts an existing override.

## Replay and evaluation from a selected revision

After the manager can ship independently, add **Replay a response** and **Evaluate a case suite** to the selected candidate in both interfaces. Carry the displayed baseline and candidate IDs into the existing replay and evaluation operations. Let the maintainer select an available capture and its owning session for replay, or a reviewed suite and supported model for evaluation. The standalone Web interface needs a session connection for an in-memory capture. Explain a missing capture, disconnected session, shadowed prompt or unsupported provider at the action that needs it. The catalog and editor remain usable.

Return to the same candidate with the paired responses, case-level outcomes, rubric and judgment. Save the evidence against the exact two effective revisions, including bundled content versions, enabled bundled IDs and ordered user-module versions. It can be reopened in either interface and used for a later promotion of that pair. Display upstream validation separately from the result of replaying this user's selection. A changed toggle or user edit yields a different comparison target. Running an experiment never activates a revision. Response replay and suite evaluation are the first two product journeys. Turn and task replay retain the capture and isolation contracts below.

## Web workspace for a selected revision

Follow-up design to [#958](https://github.com/1aboveio/pi-better-harness/issues/958), [#959](https://github.com/1aboveio/pi-better-harness/issues/959) and their implementation in [#962](https://github.com/1aboveio/pi-better-harness/pull/962). The local Web console presents four views within Prompts. The active baseline, working draft or saved candidate, and observed session-loaded revision stay visible when the user changes views. A saved candidate has an immutable ID. Edits to it begin another draft. Keep its parent and the currently active baseline distinguishable when they diverge. Existing Pi TUI and CLI users share the revision and evidence stores. [Screen designs and state transitions](../design/local-server-web/prompt-manager.md)

| View | Decision |
| --- | --- |
| Edit | Show an ordered module index beside a single Markdown reading or editing pane. Bundled modules expose their source, scoped package evidence and per-module inclusion switch. User modules support create, edit, reorder and remove. A rendered preview and explicit Save candidate are available offline. Switching views with unsaved text preserves the draft or asks before discarding. |
| Review | Group bundled selection, user text and user order changes. Offer the full rendered result, comparison with the parent or active base and activation history. Manual publication and rollback require a separate confirmation naming the affected revisions. Show the reload boundary and keep a conflicting draft available. |
| Replay | From a saved candidate choose the owning Pi session and a readable captured request. Show the input once, place the two generated responses alongside each other and identify the reference answer separately when present. Keep the exact revision pair, model, rubric, outcome and maintainer judgment with the result. Explain missing captures, shadowing and unsupported transports where the action would run. |
| Evaluate | Choose a reviewed suite, supported model and sample count. Present a case list and an inspector with paired responses, rubric and recorded judgment. Report regressed, improved and tied cases separately from unsupported or incomplete cases. Show the scored denominator. An evaluated promotion checks the precise pair and current active base. |

A successful save makes the candidate available to both interfaces. Running an experiment stores evidence and returns to the same candidate. A new save creates a new comparison target. Prior evidence stays with its original pair. The browser reads through the existing manager and provider operations. Local authoring and manual publication remain available without a provider or capture. At small widths the module list and comparison arms stack in reading order while keeping revision labels visible. The Web views described here do not prescribe a new TUI layout.

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

1. With no provider configured, turn off one bundled module and edit a user module in the TUI. Reopen that candidate in Web, inspect the selection and text changes and explicitly publish it. After a Pi reload, verify the selected revision was loaded. Roll back from the other interface and recover the prior rendered bytes.
2. From a selected candidate, run a captured response replay and a reviewed case suite on a supported provider fixture. Reopen the resulting evidence in the other interface and verify the exact revision pair. Record a judgment and explicitly choose whether to promote.

Template rendering runs when its sources or selection change. Replays and evaluations run on demand. Ordinary turns and compaction incur no extra history scan, provider request or template rewrite. [Runtime performance principles](0032-runtime-performance-design.md)
