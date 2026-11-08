---
status: accepted
date: 2026-11-08
---

# Skill exposure is a launch choice a catalog definition may carry

A subagent otherwise advertises the entire user-level skills catalog on every
run, even when its task names the one `SKILL.md` it needs by path. Pi's CLI can
already express the three useful states — discovery, `--no-skills`, and
`--no-skills --skill <path>…` — but nothing in a launch reached them, so the cost
was paid per attempt (#664).

We add one launch value, `skills`, resolvable from a `subagent_spawn` option, a
batch job or `shared` block, a catalog role/agent, or the global subagent config,
frozen in the saved launch recipe, and bounded above by an explicit launch
option.

## Why this does not reopen ADR 0003's execution boundary

ADR 0003 keeps tool selection, sandbox mode, extensions, workspace, and nested
delegation on the spawn path: a catalog file can preserve them but cannot use
them, because honoring a host control it cannot reproduce would make the file
look like enforcement. `skills` is different in exactly one respect, and that
difference is the test for adding a future field:

- The launcher reproduces it completely. Each of the three states maps to a
  fixed argv, with no discovery left to the child's own configuration, so a
  definition's value is the value that runs. Model and effort already pass that
  test; `tools` and sandbox modes currently do not, and stay blocked.
- It grants nothing. A skill list narrows the prompt; it cannot add a tool, an
  extension, a permission, or a sandbox exemption. The catalog's own instructions
  are already far more influential than a skill list.
- It is a preference, not a policy. Absence means inherit, exactly like model and
  effort, so a definition that says nothing about skills changes nothing.

The value is therefore read and serialized with `defaults` / `overrides`, next to
model, effort, and tier, but it is not a resolution `PreferenceKey`: model
resolution never sees it, and the launcher consumes it directly.

## Three states, not a boolean

`skills: []` means "none", `skills: ["/abs/path"]` means "exactly these", and an
absent key means "inherit". Collapsing absence and `[]` would make an empty list
silently widen to discovery, which is the failure the option exists to prevent.
Every layer keeps that distinction, including batch merging, the frozen recipe,
and the continuation conflict check.

An agent's explicit `skills: null` suppresses its base role's list and falls
through to the config default and then discovery, matching how a null model
override stops inheriting a role default.

## Alternatives and consequences

- **A hermetic mode comparable to `clean: true`:** rejected as a second concept
  for the same argv. `skills: []` already is the hermetic case, and it composes
  with `clean` instead of replacing it.
- **`exclude_skills`:** rejected. Pi cannot remove one entry from a discovered
  catalog without also taking over discovery, so the field would have to lie
  about what it honors.
- **Relative paths in definitions:** rejected. A catalog file has no workspace of
  its own, so a relative path would resolve differently per caller. Definitions
  require absolute paths; a launch option may stay relative and is resolved
  against the child's workspace before it is frozen.
- **Re-resolving skills on continuation:** rejected. The recipe freezes the
  choice, so a catalog or config edit cannot change a live conversation's prompt
  exposure; the same rule already applies to model, effort, and extensions.
- **Legacy recipes:** a recipe with no `skills` key keeps discovery. It is not
  read as "none".
