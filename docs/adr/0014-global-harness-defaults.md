# Global Harness defaults

## Status

Accepted. The user requested persistent defaults across installs for all Harness
packages, specifically including tool output. This supersedes ADR 0013's
session-only tool-output decision and its separate callback preference file.

## Decision

Store Harness-owned defaults in global `<agent-dir>/settings.json` under the
`piBetterHarness` namespace. Keys are `toolOutput`, `subagents`, `callbacks`,
`goal`, `sandbox`, `sandboxPermissions`, and `sandboxDenyRules`. Each package
continues to validate its own payload and own its settings UI.

Use a shared vendored storage module so standalone packages need no installed
Harness bundle. Pi's public SettingsManager exposes only Pi-owned setters; do
not import the private FileSettingsStorage. Use proper-lockfile with Pi's lock
path and options, read current settings inside the lock, and atomically replace
the file while preserving unrelated Pi fields and namespace keys. Invalid global
JSON or namespace shape must never be replaced by a preference save.
Preserve a symlinked settings.json by replacing its resolved target rather than
the link itself; refuse to replace dangling links.

Migrate legacy preference files only when the corresponding global key is absent
and only after package validation. Leave the old files untouched. Existing global
values win. Resetting deny rules records a sentinel so a legacy override is not
silently restored. The package-local Subagents config remains a shipped fallback,
not a writable preference store.

Tool-output changes persist both the active branch choice and the future-session
default immediately. Existing session branch entries still win on restore.
Other settings retain their existing explicit-save and confirmation policies.
Do not move plans, SSH session profiles, run state, logs, or catalog definition
files into settings.json. Runtime control-plane write protection is unchanged.

## Verification

Test migration, precedence, malformed-data preservation, sibling-key preservation,
concurrent processes, Pi SettingsManager compatibility, and atomic readers. Test
fresh-session tool-output restoration and rollback on failed persistence alongside
the package-owned settings journeys.