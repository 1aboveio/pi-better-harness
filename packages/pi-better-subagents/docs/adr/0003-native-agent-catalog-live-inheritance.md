---
status: accepted
date: 2026-09-23
---

# Native agent definitions with live role inheritance

Reusable local specialists must retain their relationship to a role and later be
usable in Agentier. A flattened copy of role defaults loses the distinction
between inherited values and deliberate customization. We choose a separate,
versioned native definition format, live single-role inheritance, and immutable
launch snapshots, while reusing the existing subagent execution lifecycle.

This records accepted design for DEV-23 / GitHub #289. It does not claim the
catalog or Agentier integration is implemented.

## Definition and execution boundaries

- Extend `pi-better-subagents` with internal catalog and resolution modules;
  retain the existing single/batch launch path, durable runs, callbacks, capacity,
  sandbox, tool/extension selection, and navigator. No new installable agent
  package, permission system, or run manager.
- Native definitions use Markdown instruction bodies and versioned YAML
  frontmatter parsed with a full YAML parser. Keep definition IDs separate from
  display names and filenames. Exact schema fields and locations belong in the
  implementation spec.
- Each named agent references exactly one base role. Store explicit overrides
  separately from inherited values. Removing an override restores inheritance.
  Agentier executable-role memberships describe eligibility and are not multiple
  inheritance parents.
- Instruction mode is explicitly `add` (default) or `replace`. Replacement must
  contain nonempty text and replaces role instructions only; model and effort
  continue to inherit unless overridden. Normal Pi instructions remain in place.
- Project definitions shadow whole personal definitions, which shadow bundled
  definitions. Missing fields do not merge from a shadowed agent. Resolve the
  base role by stable ID using the same source precedence, including for personal
  agents used within a project. Invalid higher-priority definitions and missing
  roles block affected launches instead of silently selecting a different source.

## Freshness and provenance

Check definitions before every launch. Refresh once at admission for a batch and
resolve every job against that catalog snapshot. Preserve effective definition,
model/effort, and selection provenance for each run; later edits and renames do
not rewrite active or completed run configuration. `/agents reload` remains
available but is not required for the next launch to observe file edits.

Create/import defaults to personal storage. Codex is the first external format
adapter: import suggests a base role for confirmation and discloses replacement
instruction mode. Imports are independent native copies with source provenance,
not synchronized views. Re-import previews replacement, including lost local
edits, and requires confirmation; retain stable identity. Unsupported execution
restrictions are preserved and block launch until resolved, without affecting
unrelated valid definitions.

## Model resolution boundary

The coordinator translates authoritative task/workflow instructions into launch
parameters; the runtime does not parse arbitrary prose for model choices.
Explicit per-run models override saved defaults. Default-model resolution follows
preferred → configured same-tier candidate → foreground; explicit unavailable
per-run models fail. Cross-provider candidates require explicit configuration.

Availability comes from the foreground registry. This deliberately accepts that
isolated child initialization can still fail; surface that lifecycle failure
without automatic retry or post-start model failover. For unsupported inherited
role/default effort, select the nearest supported level in the ordered sequence
`off < minimal < low < medium < high < xhigh < max`, breaking ties downward and
reporting the adjustment. Saved agent effort overrides and per-run effort choices
are explicit and fail when unsupported.

## Alternatives and consequences

- **Copied role templates:** rejected because later role improvements would not
  reach existing agents and explicit customization could not be distinguished.
- **Codex-native files with custom metadata or sidecars:** rejected in favor of a
  native contract that represents role identity and inheritance directly. Codex
  compatibility is an adapter with documented precedence differences, not full
  runtime emulation. Agentier's existing restricted YAML parser needs adaptation.
- **Multiple base roles:** rejected to avoid implicit instruction/model conflict
  rules. Ambiguous requests ask the user to choose one role or split the work;
  unattended calls return clarification-needed without an ambiguous launch.
- **Explicit reload only:** rejected so new launches see current definitions.
  Snapshotting once per batch keeps that freshness from changing sibling jobs.
- **Child-specific availability preflight or live inference probes:** not selected;
  foreground availability is the agreed boundary and does not guarantee success.

Native role references and overrides must survive future Agentier transfer.
Agentier remains responsible for org policy and AgentSpec/TaskRun execution;
remote model precedence, migration, and transport belong to DEV-39. The local
fallback chain does not establish a remote authorization or model policy.

## References

- [DEV-23 product PRD](https://linear.app/1above/issue/DEV-23/role-based-agent-catalog-for-pi-better-subagents)
- [GitHub #289 technical specification](https://github.com/1aboveio/pi-better-harness/issues/289)
- [DEV-39 Agentier alignment](https://linear.app/1above/issue/DEV-39/align-agentier-agent-definitions-and-live-role-inheritance-with-pi)
- [Agentier ADR-0037](https://github.com/1aboveio/agentier/blob/main/docs/adr/0037-agent-orchestrated-issue-execution-experiment.md)
