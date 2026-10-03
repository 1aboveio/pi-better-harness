# Catalog launch lifecycle

Catalog launches use the existing `spawnSubagentRun` path. There is no second scheduler, registry, or navigator. Model and effort rules are in [agent-model-resolution.md](./agent-model-resolution.md).

## Selectors

`subagent_spawn`, batch `shared`, and each batch job accept optional `agent`, `role`, and `alias`.

- `role` takes a role's short name (`role: "developer"`). It is trimmed and case-insensitive, and the stored id (`role.developer`) also works. A bare name only ever selects a role, never an `agent.*` named agent. An unknown name fails and lists the valid role names. `agent` ids are trimmed and lowercased the same way.
- A `role` or `agent` that is present but blank (`role: "  "`) is rejected before any launch. Only an absent field means no selector.
- A per-job `agent` or `role` replaces the shared selector pair. It does not combine `shared.agent` with `job.role`.
- `model` and `thinking` still merge per field. Per-job wins.
- One agent or one role is a normal launch. Both, or more than one role id, asks the UI to choose one or split into separate runs.
- With no UI, that call returns `clarification-needed` and starts no child.
- Two jobs with different role ids are valid and stay independent.

Calls with no `agent` or `role` keep the previous name and the previous model chain: invocation, then configured `defaultModel`, then the foreground model. Explicit `thinking` still wins over a model `@effort` suffix.

## Refresh and resolution

A single launch loads the catalog immediately before resolution. A batch loads it once, before capacity admission, and every job in that batch uses that same snapshot. Later edits apply to the next launch, not to jobs already admitted. `/agents reload` is only the inspection command.

Each selected job calls `resolveModel` before `spawnSubagentRun`. The runtime does not read the task text for a model or effort. The coordinator copies an authoritative workflow or skill choice into structured `model` and `thinking` first. Quoted names and comparisons are not selections.

The child prompt is the effective role or agent instructions, then the task. Spawn still owns capacity, partial batch failure, sandbox, extensions, nesting, callbacks, logs, and stop. Catalog resolution does not grant tools or permissions.

## Provenance and names

The first `meta.json` write stores the launched `model` and `effort` plus a JSON `catalog` object: snapshot digest, definition identity (`catalog.identity.label` is the same display name as `name`), effective field sources, and `modelSelection` / `effortSelection`. That write happens before the exit callback is attached. Later status, result, and stop writes keep that snapshot and that name; they do not fill in a missing catalog or replace it with a stale one. Catalog-free runs omit `catalog`.

A named agent displays its defined name. A direct role asks `allocateCatalogLabel({ roleId, roleName, alias })` when that module is present. `roleName` is the slug (`developer`), not `role.developer`. The label is allocated in the local run registry. An explicit `alias` (or the legacy `name` when `alias` is omitted) is the alias; collisions are the allocator's numeric suffix. Batch-generated `job-N` labels are not aliases.

Navigator rows keep the display name, model, and effort. Details include the run id and, for catalog runs, the short role name (`developer`). The full `roleId` stays in `meta.json`.

## Tier candidates

`config.json` `tierPolicy` is passed through `tiersForLaunch`, which calls `configureTierPolicy`. Setting candidates only on the resolver is not enough for a launch. Built-in candidate lists stay empty until this config names them. A candidate must be a tier member. Another provider also needs `crossProvider: true`.

## Inspection

The extension registers `/agents` and `agents_catalog` through `createAgentOperations`. The launch enricher calls `assessCatalog` / `assessSelection` with the current model registry, project trust, and user catalog root. It reports the existing spawn controls and `grantedByCatalog: false`. If the registry or snapshot is not the one just loaded, launchability stays unknown instead of being reported as launchable.

## Session Settings

`createAgentSessionSettings` restores model and effort overrides from the active
Pi session branch. The extension restores before catalog-dependent work and on
`session_start` and `session_tree`; switch and shutdown clear transient state
without appending reset entries. Edits survive reload, resume, and fork, while
new sessions start from catalog defaults.

The catalog host supplies a live `getSessionSettings` getter so inspection
reflects edits made while the overlay is open. `loadLaunchSnapshot` reads that
getter once and freezes the overlay for each batch. Later edits cannot alter
already-admitted jobs. Model choices come from the current Pi model registry.

Ctrl+S saves only the selected definition's own preferences, never flattened
inherited settings. Bundled roles are copied to user scope; existing user and
project definitions are saved in their own scope with the store's trust,
validation, and atomic-write checks. Plain `loadCatalog` remains disk-only so
saving selects the current winning definition rather than a stale overlay.

Headless callers can inject a session controller or immutable
`CatalogHost.sessionSettings`. Hosts without these hooks retain inspection-only
UI and the prior launch behavior.
