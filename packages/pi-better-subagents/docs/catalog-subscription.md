# Repository catalog subscription

This repository is the publication source for a portable agent catalog.
Consumers such as Agentier subscribe directly to Git; no publishing server,
generated archive, or npm release is required. The subscriber is separate work
in [Agentier #2639](https://github.com/1aboveio/agentier/issues/2639), not an existing
capability provided by this package. The manifest and this contract must be merged
before Agentier can consume them from `main`.

## Discovery contract

Subscribe to repository `1aboveio/pi-better-harness`, ref `main`, manifest
`agent-catalog.yaml`. A subscriber may pin a commit instead of following a ref.
The manifest at the repository root contains:

```yaml
schema: pi-agent-catalog/v1
id: io.1above.pi-better-harness
name: Pi Better Harness
definitionSchema: pi-agent/v1
paths:
  roles: packages/pi-better-subagents/roles
```

`id` is the stable catalog identity; `name` is display text. Definition identities
are scoped by `(catalog id, definition id)`, not their names or filenames.
`paths.roles` is required. `paths.agents` is optional and uses the same directory
rules. It is omitted today because this repo ships no named agents. Adding named
agents later does not require a new catalog schema.

Paths are repository-relative directories with `/` separators, no absolute paths,
empty segments, `.` or `..` segments, or symlinks. Read regular `*.md` files one
level deep in each declared directory; do not recurse. A declared directory must
exist and contain at least one definition. Directory kind must match each file's
definition kind. IDs must be unique across the catalog, and every named agent's
base role must exist in the same revision. Do not fill missing definitions from
the subscriber's personal or project catalog.

Files use the existing [pi-agent/v1 format](agent-catalog.md). Preserve role
references, explicit overrides (including null), and instruction add/replace
mode. Do not publish or import flattened effective prompts. Unsupported manifest
or definition schema versions must not activate.

## Revisions and refresh

The publication revision is the full Git commit SHA. Resolve the subscribed ref
once, then fetch both the manifest and all files at that SHA, never through
separate moving-branch reads. The local catalog snapshot digest includes local
source information and is not the portable publication revision.

A push webhook can trigger a refresh. Periodic ref checks must recover missed
webhooks. Webhooks are notifications, not trusted definition payloads. Restrict
refreshes to configured repositories and refs; authenticate private repository
access using subscriber-owned credentials, never credentials in definitions.
Fetch source as data without running repository scripts, hooks, or installs.

Track the latest observed SHA separately from the active SHA. Fetch and validate
the complete candidate revision before atomically activating it. A failure keeps
the last good revision active and records the error; a failed first sync leaves
the subscription inactive. Repeated refreshes of the same active SHA are no-ops.
Unrelated repo commits may advance the source SHA without changing definitions.
Allow explicit pinning and rollback to a previously validated revision.

Removed definitions become unavailable for new selection, but historical
versions and run references remain. If a removal leaves an agent without its
base role, reject that candidate revision rather than partially activating it.

## Agentier boundary

Store subscribed definitions separately from Agentier-local customizations.
Map portable identities to org-scoped database identities explicitly. Sync must
not overwrite local overrides or unrelated definitions. Imports remain independent
copies; subscriptions are an explicit continuing source relationship.

Agentier owns model policy, credentials, tool access, eligibility, and runtime
authorization. A subscribed definition grants none of these. A new active
revision affects future effective snapshots only, through Agentier's existing
freeze boundary. Existing sessions and TaskRuns retain their frozen configuration.
See Agentier [ADR-0057](https://github.com/1aboveio/agentier/blob/main/docs/adr/0057-agentspec-live-base-role-inheritance.md).

## Author checks

Run `npm run catalog:check` after editing the manifest or published definitions.
The repository's `npm run verify` also runs this check.
The checker validates the repo source alone using the native definition parser;
it does not load personal definitions, project overrides, or session settings.
It reports the published file inventory and fails on invalid definitions,
duplicate IDs, unsafe paths, or missing base roles. It does not prove runtime
model availability or implement a network subscriber.