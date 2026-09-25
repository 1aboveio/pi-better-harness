# Catalog operations

Commands, the read-only discovery tool, and the Codex importer for `pi-agent/v1`. The native file format and inheritance rules are in `docs/agent-catalog.md`. This unit does not register them in `index.ts`. Lifecycle attaches `createAgentOperations()`.

## Commands

`/agents` is one Pi command. Dialogs use `ctx.ui.select`, `confirm`, `input`, and `editor`. `ctx.hasUI` is false in print and JSON mode. When a choice or confirmation is required there, the command returns `clarification-needed` and writes nothing.

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
