# Sandbox permission table and credential-file scope

## Status

Accepted. Extends ADR 0003's shared enforcement mechanism and ADR 0004's opt-in Main/default-on Subagents policy.

## Decision

`/sandbox` presents one flat table with independent Main and Subagents columns. The rows are Sandbox, Project files, Outside project, Stored credentials, Run commands & applications, and Network access. File rows use Off, Read, and Read / write; the remaining rows use Off and On. Detail cells show a dimmed literal `-` when their column's Sandbox switch is Off. Inactive values are retained, never replaced by unrestricted values.

Defaults are Main sandbox Off, Subagents sandbox On, project Read / write, outside Read, stored credentials Read, commands On, network On. Human changes affect subsequent operations and launches. Save as defaults persists both columns; unsaved choices are session-local. Existing activation preferences migrate into the Main switch.

The permission table has no folder selectors, app integrations, or expandable groups. Existing protected-path rules remain stricter than broad file permissions.

## Credential scope

The user explicitly selected **credential files first** after enforcement review. Stored credentials covers known credential files and directories, including SSH, AWS, GitHub CLI, Google Cloud CLI, Azure, Kubernetes, Docker, npm, netrc, Git credentials, and Pi's file-based authentication. Credential-file rules override ordinary project/outside permissions. Canonical paths prevent a symlink alias from bypassing those rules.

OS credential services (including macOS Keychain/securityd and Linux Secret Service) and credentials already inherited in environment variables are **not** governed by this control. The UI and documentation must disclose that scope. File write denial cannot honestly be described as read-only OS vault access.

## Enforcement boundaries

The shared core owns file access decisions and OS wrapper rules. Main and Subagents use a shared task executor: read, write, and edit retain the SDK tool contract while filesystem syscalls and shell commands run under kernel confinement. The model cannot mutate the controller through a tool. Tools without a verified execution adapter are blocked.

[ADR 0007](0007-trusted-runtime-task-boundary.md) separates trusted Pi startup, configuration/authentication locks, provider transport, and session persistence from task execution. Commands Off and Network Off constrain task operations while Pi can still initialize and use its provider. Task access to `~/.pi` remains subject to Outside project and Stored credentials, with runtime control files protected from task writes. Unsupported combinations fail explicitly; the launcher never silently drops confinement.

Runtime system libraries and temporary paths need bounded allowances so the sandbox can execute at all. These allowances must be documented and must not grant a whole home directory or override credential-file restrictions. Linux backend limitations must be explicit and fail closed.

## Verification

Required evidence includes table keyboard behavior and width bounds; persistence and migration; matching file decisions and actual kernel enforcement; credential-file precedence; launch-time snapshots; and real-kernel checks using disposable synthetic files. No real credential values should be inspected by these tests.

Implementation verification includes a real Pi terminal save/reload test, real macOS kernel read/write/network checks, an actual Pi session writer confined to its private runtime directory, and single/batch default-profile subagent launches. Regression cases cover protected ancestor renames, Data-volume aliases, configured Pi auth paths, and Linux rejection of projects nested under stricter protected ancestors. Linux command construction is tested locally; its actual kernel behavior still requires a capable Linux runner.
