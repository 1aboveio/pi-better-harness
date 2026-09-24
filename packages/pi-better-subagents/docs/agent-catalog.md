# Native agent catalog (`pi-agent/v1`)

Portable role and named-agent definitions for `pi-better-subagents`. This is the local contract for DEV-23 / GitHub #289. It is not an Agentier importer, a Codex runtime, or a second launch path.

Normative behavior is DEV-23 and the accepted ADR `docs/adr/0003-native-agent-catalog-live-inheritance.md`. Field names below are the engineering schema those decisions require.

## Document shape

A definition is Markdown. YAML frontmatter holds the versioned data; the body is instruction text.

```markdown
---
schema: pi-agent/v1
kind: role
id: role.developer
name: Developer
description: Implements a requested change in the existing system.
defaults:
  model: openai/gpt-6-sol
  effort: high
  tier: balanced
---
Instruction text.
```

A named agent references exactly one base role:

```markdown
---
schema: pi-agent/v1
kind: agent
id: agent.payments-developer
name: Payments Developer
roleId: role.developer
instructions:
  mode: add
overrides:
  effort: high
---
Look at payment edge cases before editing.
```

`instructions.mode` is `add` (default) or `replace`. `replace` must have nonempty body text and replaces role instruction text only. Model, effort, and tier still inherit unless `overrides` sets them.

## Stable identity

| Field | Rule |
| --- | --- |
| `id` | `role.<slug>` or `agent.<slug>`. Slug is lowercase `[a-z0-9]+` segments separated by `.` or `-`. Max 128 characters. |
| `name` | Display text. Changing it does not change `id`. |
| Filename | Not an id. Discovery reads every `*.md` file in the scope directory, one level deep. |

`kind` must match the id prefix. `roleIds`, `baseRoles`, `inherits`, and a list of roles are rejected. Agentier executable-role memberships are eligibility data, not extra inheritance parents, and are not accepted as additional `roleId`s.

## Portable preferences vs host controls

`defaults` (roles) and `overrides` (agents) accept only:

| Key | Meaning |
| --- | --- |
| `model` | `provider/model`. No `@effort` suffix. |
| `effort` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `tier` | Catalog-policy label (`balanced`, `efficient`, `frontier`, or another short label). Not a benchmark claim. |

A missing key inherits. A present key, including `null`, is an explicit value and does not inherit. Removing an override means deleting the key. Writers must not copy effective inherited values back into `overrides`. Agents must not store a `defaults` object; that mapping is kept only so it is not discarded, and it is not promoted into overrides.

These preferences do not grant tools, sandbox behavior, extension loading, or nested delegation. Launch keeps the existing subagent controls. A role name or a prompt that says "read-only" is not enforcement.

Host execution keys (`sandbox`, `sandbox_mode`, `tools`, `permissions`, `mcp`, `mcpServers`, `extensions`, `network`, `filesystem`, and the other names in `HOST_EXECUTION_CONTROL_KEYS`) are preserved. A required restriction blocks launch until it is removed. `honored: true` in the file is not proof that Pi enforced it. Optional restrictions (`required: false`) are warnings. Cosmetic `metadata` and unknown non-execution fields are preserved and do not block launch.

Credential-like keys (`token`, `apiKey`, `password`, `connectionString`, and similar) are redacted, not stored, and block launch.

## Sources

Precedence is project, then personal, then bundled. The higher source replaces the whole definition. Omitted agent fields inherit from the effective role, not from the shadowed agent.

| Scope | Path |
| --- | --- |
| Project | `<cwd>/<CONFIG_DIR_NAME>/agents/roles/*.md` and `.../agents/agents/*.md`. `CONFIG_DIR_NAME` defaults to `.pi`. Pass Pi's export from the host. |
| Personal | `$PI_CODING_AGENT_DIR/agents/roles/*.md` and `.../agents/agents/*.md`. Default root is `~/.pi/agent`. |
| Bundled | `roles/role.*.md` in this package. Immutable. |

Project files are read and written only when the host sets `projectTrusted` from `ctx.isProjectTrusted()`. Otherwise the project catalog is reported as suppressed and personal/bundled definitions are used. Create/save defaults to the personal root. `scope: "project"` is explicit. Writes are atomic (temp file, fsync, rename) and refuse symlink escapes inside the catalog root.

Same-scope duplicate ids produce a diagnostic and no filesystem-order winner. That duplicate blocks lower sources for the same id. An invalid higher-priority file that still has a readable id also blocks that id. A broken file that has no id does not hide valid siblings. `.codex/agents` is not scanned.

Role references use the same precedence. A missing or unusable role leaves the agent listed and not launchable.

## Snapshots

`loadCatalog` / `refreshCatalog` read the disk every time and return a new frozen snapshot. `digest` / `revision` is a sha256 of the canonical entries, unused sources, and snapshot diagnostics. `loadedAt` is not part of the digest. Callers must reuse one snapshot for every job in a batch. Later file edits do not mutate a snapshot already taken. `/agents reload` is an inspection operation owned by the operations unit; it is not required for the next `loadCatalog` to see edits.

File diagnostics for an id live on that catalog entry. `snapshot.diagnostics` carries directory, trust, duplicate, and no-id failures. `resolveSelection`, `listCatalog`, and `inspectCatalog` are the launchability view; `schemaLaunchable` does not yet know whether an agent's role exists.

Model availability, same-tier fallback, and nearest-effort adjustment are not decided here. Saved agent effort overrides are marked `explicit: true` so a later resolver can fail them when unsupported, while role defaults stay non-explicit.

## Approved bundled roles

| Id | Name | Model | Effort | Tier |
| --- | --- | --- | --- | --- |
| `role.researcher` | Researcher | `openai/gpt-6-sol` | medium | balanced |
| `role.explorer` | Explorer | `openai/gpt-6-luna` | medium | efficient |
| `role.product-manager` | Product Manager | `openai/gpt-6-sol` | medium | balanced |
| `role.developer` | Developer | `openai/gpt-6-sol` | high | balanced |
| `role.reviewer` | Reviewer | `openai/gpt-6-astra` | medium | frontier |
| `role.architect` | Architect | `openai/gpt-6-astra` | high | frontier |

The product table's short model names are the model ids. The provider prefix is `openai`, matching explicit `provider/model` ids already used at launch. No cross-provider substitute is implied. Tier candidate lists are not invented here.

## Parser

The `yaml` package parses full YAML 1.2 with the core schema, unique keys, and merge keys enabled. Anchors and aliases are valid. They are limited to 50 alias expansions, 2,000 nodes, and depth 32, with a 512 KiB file cap. Custom executable tags are not loaded. Duplicate keys are errors. The serializer writes canonical YAML and does not preserve comments or anchor syntax; it does preserve values, explicit nulls, restrictions, provenance, and unknown fields.

## Internal API

Other units import these modules directly. `index.ts` is not wired in this slice.

- `catalog-schema.ts` — `parseDefinition`, `serializeDefinition`, `setAgentOverride`, `removeAgentOverride`, `updateAgentOverrides`.
- `catalog-store.ts` — `loadCatalog`, `refreshCatalog`, `createDefinition`, `saveDefinition`.
- `catalog-resolver.ts` — `resolveSelection`, `listCatalog`, `inspectCatalog`.

`resolveSelection({ agentId, roleId })` rejects both selectors with `ambiguous-selector` and does not pick a winner. `inspectCatalog` reports identity, role, winning source, shadowed sources, inherited versus overridden fields, launchability, restrictions, and that the catalog grants no capabilities.

## DEV-39 mapping and limitations

DEV-39 owns Agentier adaptation, migration, remote model policy, credentials, and TaskRun gates. This package does not import Agentier, write a database, or accept remote credentials. The local file keeps the distinctions a future AgentSpec has to preserve:

| Local field | What Agentier must not flatten later |
| --- | --- |
| `id` | Stable identity, distinct from `name`, filename, and run id. |
| `roleId` | Exactly one live base role. Membership lists are not parents. |
| `instructions.mode` + body | `add` appends; `replace` swaps instruction text only. |
| Missing override vs `overrides.<field>` | Absence inherits the current role. Presence, including null, is explicit. Deleting the key removes the override. |
| Role `defaults` | Live source for the next resolution. Not copied onto the agent at save time. |
| `provenance` | Import origin of an independent copy. Not a subscription to the external file. |
| `executionRestrictions` | Required restrictions stay visible and blocking until a real host control exists. |

Limitations, so this schema is not over-claimed:

- Agentier is not claimed to accept this Markdown, Codex TOML, or `agents/openai.yaml`.
- Codex import, confirmation, and re-import preview belong to the operations unit. Those directories are not auto-discovered.
- Role inheritance is not a Codex field. Codex model/effort precedence differs from DEV-23; invocation and workflow choices win on Pi.
- No remote authorization, model policy, or TaskRun behavior is decided by a local fallback.
- The catalog does not enforce sandbox, tool, MCP, or permission settings and does not add presets.
- Wiring into `spawnSubagentRun`, navigator labels, and batch admission is a later unit. A snapshot's digest is what that unit should persist with the run.
