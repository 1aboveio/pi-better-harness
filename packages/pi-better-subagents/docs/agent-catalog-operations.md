# Catalog operations

Commands, the read-only discovery tool, and the Codex importer for `pi-agent/v1`. The native file format and inheritance rules are in `docs/agent-catalog.md`. This unit does not register them in `index.ts`. Lifecycle attaches `createAgentOperations()`.

## Commands

`/agents` is one Pi command. Dialogs use `ctx.ui.select`, `confirm`, `input`, and `editor`. `ctx.hasUI` is false in print and JSON mode. When a choice or confirmation is required there, the command returns `clarification-needed` and writes nothing.

In an interactive TUI, `/agents`, `/agents list`, and `/agents show` open a focused catalog view instead of leaving the listing in a persistent widget. Rows align name, effective model, source, and launch state; narrow terminals retain name and model. The model is the resolved actual model when available, otherwise the requested or inherited preference, or `not resolved`. Type to filter by id, name, description, or base role; use Up/Down and Enter to inspect. The detail view puts launchability and its reason first, then source, inherited/overridden settings, and diagnostics. Press `p` in detail to read the complete effective instructions (role plus agent in add mode, agent text in replace mode); this is not the task-specific launch prompt. Up/Down scrolls detail or prompt; Left or Escape returns to detail, then list, clears the filter, then closes. `/agents show <id>` opens that definition directly. Print/JSON callers still receive the complete text and structured result; bare `/agents` still returns help outside the custom TUI.

### Model and effort edits

When lifecycle supplies `sessionSettings`, press `e` in detail to edit Model or Effort. Up/Down selects the setting and Enter opens its choices. Model choices come from the foreground registry, plus the current preference if unavailable; type to filter model names. Effort choices use the existing catalog effort levels. Escape cancels an unselected choice. Only these two fields are editable; instructions, base role, tier, and execution controls are unchanged.

A selected value immediately appends a custom entry to the current session branch. It does not write a catalog file. Reloading the extension or session restores the active branch's edits. Branches share their common ancestor settings but subsequent edits do not cross to siblings. Role edits flow into named agents that inherit that field. Choosing `Inherit` removes the selected definition's own value, including a saved agent override, instead of storing an explicit null preference. For a role with no parent, that removes its default. Later role/file edits remain live.

Ctrl+S in list, detail, or settings (or Enter on Save as defaults) explicitly saves the selected definition's own model and effort changes. It never copies inherited role fields into an agent. Existing personal/project definitions stay in their winning scope; a bundled definition becomes a personal whole-definition shadow copy, leaving the package file untouched. Project trust, duplicate/invalid-definition checks, validation, and atomic catalog writes still apply. Both successful and failed saves leave branch edits intact. A failed save reports the error without changing the catalog defaults.

New launches and `agents_catalog` discovery use the same session overlay. Explicit per-run model/effort choices still win, a batch retains one immutable snapshot, and active/completed runs do not change. Role effort remains an inherited default with the existing nearest-supported adjustment; named-agent effort remains explicit and blocks when unsupported. The lifecycle wiring required to enable this surface is in [agent-catalog-lifecycle.md](./agent-catalog-lifecycle.md#session-settings-integration).

| Invocation | Effect |
| --- | --- |
| `/agents list` | Fresh read of project, personal, and bundled definitions. One bad file does not hide the others. |
| `/agents show <id>` or `/agents inspect <id>` | Identity, role, winning source, shadowed files, inherited versus explicit fields, validation, restrictions, and launchability. |
| `/agents create` | Named agent. Personal storage unless `--scope project`. Stores `roleId`, instruction mode, and only the overrides that were set. |
| `/agents reload` | Inspection refresh. The next launch reads files again without this command. |
| `/agents import-codex <file.toml>` | Explicit import of one Codex TOML file. Does not scan `.codex/agents`. |

`--scope project` is refused when `ctx.isProjectTrusted()` is false. `--scope user` and the default are the personal catalog under `$PI_CODING_AGENT_DIR/agents` (`~/.pi/agent` when unset).

Create and import ask for a missing role, name, or path only when `hasUI` is true. Two `--role` values ask the user to choose one role or split the work. The result never has two base roles. Split does not write a multi-parent agent and does not launch.

## Inspection and launchability

`definitionValid` means the file parsed. `catalogLaunchable` means the catalog resolver found no blocking role, shadow, or execution-restriction diagnostic. Neither field means a child can start.

`launchable` stays `unknown` until lifecycle injects a `LaunchEnricher` from the model resolver. That enricher supplies availability, requested and actual model, requested and actual effort, and its launch decision. If the catalog already blocks the id, enrichment cannot flip it to launchable. This module does not call the model registry and does not implement fallback.

Effective capabilities stay the existing spawn controls: tool selection, extension loading, skills setup, sandbox and workspace, and nested delegation. `grantedByCatalog` is false. No tool preset or permission is added. A prompt that says read-only is not enforcement.

## Codex import

The parser is `smol-toml`. Required fields are `name`, `description`, and `developer_instructions`. Optional supported fields are `model` and `model_reasoning_effort`.

`agents/openai.yaml` is skill metadata. It is rejected and not stored.

Import suggests one base role and requires confirmation. Instruction mode is `replace`: the Codex instructions replace role instructions and are not appended. Model and effort inherit unless the user explicitly saves the supported Codex values as overrides. A bare model id is not given a provider prefix. Missing inherited values are not copied into `overrides`.

The native file is a new copy. `provenance.format` is `codex-toml` and `provenance.sourceRef` identifies the source file. Editing the TOML later does not change the copy.

Importing the same stable id again shows the actual previous and next values, including lost local instruction lines, role, and instruction mode. The user must confirm. The write replaces the definition and keeps the id. It does not merge.

### Precedence difference

Codex applies the agent file's model and `model_reasoning_effort` ahead of the conversation default. Pi does not. Structured invocation parameters, then applicable task or workflow instructions, override named-agent overrides and role defaults. The importer records that difference. It does not resolve or launch a model.

### Execution settings

`sandbox_mode`, MCP servers, skills configuration, and other host execution keys are preserved on the native definition with `honored: false`. They block launch. The importer does not claim they are active. In particular, `sandbox_mode = "read-only"` is not enforced by the catalog or by the existing subagent sandbox. Cosmetic keys are warnings. Other definitions stay usable.

## Discovery tool

`agents_catalog` accepts `list` and `inspect` only. It uses the same inspection view as `/agents show`. It has no write path. Launch remains `subagent_spawn` or the batch tool, with at most one `agent` or `role` selector. Those selectors are lifecycle's wiring, not this tool.

A list line names a role by its short name (`role developer "Developer" …`), the form the `role` field takes; the inspect header, `identity.id`, and the structured `id` keep the stored id `role.developer`. Named agents show their full `agent.<slug>` id in both. Each list line and the inspect header end with the definition's default model and effort when one is set, such as `default openai/gpt-6.1-sol@high`: a role's own default, or a named agent's override or inherited role default. The structured view carries the same value as `defaults: { model, effort, label }`, or `null` when neither is set. A spawn that omits `model` and `thinking` uses it. When a catalog launch's model or effort differs from it, the launch line (and each batch job line) adds a note such as `model openai/gpt-6-astra@high (role developer default openai/gpt-6.1-sol@high)`; a named agent's note reads `agent default …`. Only the fields the definition sets are compared. The note names the cause: a fallback from an unavailable default reads `(role developer default openai/gpt-6.1-sol@high unavailable; foreground fallback)` (or `same-tier` / `configured-default`), and an effort the model cannot run adds `effort capped at <level> by the model`.

## Lifecycle attachment

```ts
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAgentOperations } from "./agent-operations.ts";

const operations = createAgentOperations({
  projectConfigDirName: CONFIG_DIR_NAME,
  enrich: (input) => resolveLaunchEnrichment(input),
});
operations.registerCommands(pi);
pi.registerTool(operations.createDiscoveryTool(Type));
```

Before a spawn whose context names two roles, call `operations.resolveRoleAssignment`. `clarification-needed` means no child and no write. Two jobs with different single roles are already resolved. `launched` and `wrote` from that helper are always false.
