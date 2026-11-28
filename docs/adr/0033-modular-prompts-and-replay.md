# Modular Harness prompts and replay

## Status

Accepted design, 2026-11-28. [Epic #945](https://github.com/1aboveio/pi-better-harness/issues/945) tracks delivery. The first milestone ends with a maintainer editing one module, replaying a response, comparing the results, promoting the candidate and rolling it back.

## Why this belongs in Harness

A writing skill is easy to edit and try. To tell whether an edit helped, a maintainer needs the request that produced the original answer. Asking the agent to rewrite that answer supplies different evidence. Conversely, an established rule that should guide every task needs to reach the model even when a skill was never opened. Harness already owns a startup addendum with a tested compaction lifecycle. It will own the edit and replay loop for those rules as well.

## Authoring and loading

Keep an ordered template and independently editable Markdown modules. Give each module a stable identifier. The same sources and order produce identical rendered text. Render the active revision into the existing Harness-owned block in global `<agent-dir>/APPEND_SYSTEM.md`. Harness instructions remains opt-in. Use the existing CLI, settings and block writer. Preserve user text outside the markers and the effective precedence of saved prompt text, custom source files and the bundled default. A user can explicitly adopt the modular default from an existing override.

Pi selects the effective addendum. A trusted project's `.pi/APPEND_SYSTEM.md` or an explicit `--append-system-prompt` can supersede global discovery. Inspection and replay must identify the source actually loaded. Ordinary turns, compaction and model switches retain the loaded global text. A fresh process or explicit resource reload picks up the installed revision. All models share one module set. Keep revision IDs, timestamps and experiment state in the revision store and replay results. [Startup and cache contract](0021-prompt-prefix-stays-cached.md)

Seed the modules with concise, previously validated principles for communication, engineering, verification, ownership, decision making and collaboration. Keep provenance, examples and scoring notes alongside the sources. For example, a status answer should disclose outstanding verification when the user is deciding whether to close delivery. A narrow question about a single run can be answered with that run's result.

Skills remain a fast way to try uncertain wording, and continue to own domain knowledge and multi-step workflows. Project-specific conventions stay in project instructions such as `WRITING.md` or `CONTRIBUTING.md`. Once a rule shows value across projects, promote its stable core into one module. Skills may then reference that core and keep their procedures and examples. Replay makes a separate experimental writing skill optional. [Subagent skill exposure](../../packages/pi-better-subagents/docs/adr/0005-catalog-skill-exposure.md)

## Candidate, active and loaded revisions

1. An agent uses `prompt_list` and `prompt_read` to inspect the effective source and its modules. `prompt_edit` targets one module at an expected revision and returns an immutable candidate ID, parent and diff. Further edits can branch from that candidate. The active revision is the one selected for installation. A session records the revision or digest it actually loaded.
2. `prompt_replay` runs the selected original input with the baseline and candidate. `prompt_compare` connects both outputs, the comparison rubric and the judgment to those exact revisions. Record the effective context, provider, model, settings and run identity needed to interpret the result. Missing inputs, changed settings and inconclusive evidence are visible outcomes.
3. `prompt_promote` requires explicit authority for the evaluated revision and checks its expected active base. `prompt_rollback` explicitly restores a known prior rendering. Apply the revision selection and block update so a stale editor cannot overwrite a newer choice and an interrupted operation can be retried. An experiment cannot enable a disabled block or silently replace a custom prompt. A running session adopts an activated change at the resource boundary above.

The maintainer's existing direct settings editor remains an intentional settings action. The candidate and evidence requirements govern the new agent-driven path. Store revision history separately from global preferences. [Settings ownership and persistence](0014-global-harness-defaults.md)

## What each replay reconstructs

| Level | Starting point | Evidence and isolation |
| --- | --- | --- |
| Response (P0) | The input immediately before the selected assistant response, including any earlier tool results already in context | Generate baseline and candidate with independent provider continuation state. Keep tool definitions consistent and execute no tools. Record a tool request as an outcome. The old answer is a labeled reference and is excluded from both inputs. |
| Turn (P1) | The input before the original user turn is processed, plus that user turn | Run the bounded tool loop with recorded or isolated tool results. Report the first unsupported divergence, actions taken and the terminal result. |
| Task (P2) | The original task and a reproducible starting workspace checkpoint | Run each revision in its own restored workspace. Compare resulting diffs and original acceptance checks. Identify missing inputs and unsupported external effects. |

Across all levels, vary just the selected prompt content in a paired comparison. Preserve project instructions, loaded skills and other context that actually reached the model. If the global block was shadowed or the input cannot be recovered, report that limitation. Use an isolated replay identity and keep the source transcript, workspace and foreground continuation intact. Equivalent inputs allow a fair comparison even when model outputs vary.

## Delivery and verification

- P0 delivers the template, first principles, revision lifecycle, agent edits and response comparison. Prove the entire loop with one writing case. Use the existing Pi request fixture to verify exact-once presence across compaction and adoption after reload.
- P1 adds a tool-using turn and portable, sanitized historical cases. Report both improvements and regressions against paired examples, with settings and sample counts.
- P2 adds task replay and opt-in learning from selected cases. Learning may propose and evaluate candidates. Activation uses the same explicit promotion path.

Template rendering runs when its sources or selection change. Replays and evaluations run on demand. Ordinary turns and compaction incur no extra history scan, provider request or template rewrite. [Runtime performance principles](0032-runtime-performance-design.md)
