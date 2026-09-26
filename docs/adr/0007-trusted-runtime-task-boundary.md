# Trusted Pi runtime and confined task execution

## Status

Accepted. Supersedes the whole-child startup boundary in ADR 0005. Implementation verification is tracked with this change.

## Problem

Reading Pi settings and authentication takes sibling filesystem locks. Confining the entire Pi child to an Outside project = Read profile prevents those reads before the task begins. Enumerating lock exceptions couples the sandbox to every runtime storage backend and gives task processes permissions intended for Pi itself.

## Decision

Pi is the trusted runtime. It owns configuration and authentication locking, provider transport, session persistence, and runtime bookkeeping. Main and Subagents permissions govern model-requested task operations. The six-row permission table and its defaults remain unchanged, including Outside project = Read.

A sandboxed subagent starts through a native launcher that imports the complete task guard before invoking the installed SDK's CLI entry point. The guard is a mandatory final inline extension. Import or initialization failure terminates the child. Default built-in activation is disabled; the guard activates the supported subset of the requested tools before the task starts. The launch policy is validated, copied, frozen, and stored in a runtime-owned directory protected from task writes. Relative agent-directory configuration and runtime control paths are resolved to canonical paths in the parent before changing the child's working directory. Main refuses an enabled profile when a task-writable symlink can retarget its already-open runtime configuration; the operator must restart Pi with a canonical agent-directory path.

A shared task execution module installs the built-in tool implementations in both Main and Subagents. Bash uses the operating-system sandbox. Read, write, and edit retain the SDK's schemas, rendering, edit semantics, and mutation queues, but perform filesystem operations in a fixed, kernel-confined worker. Paths and data travel as JSON, never executable source. Canonical checks provide useful errors; the kernel remains authoritative if a symlink changes between checking and accessing a path.

The fixed file worker may start when Run commands & applications is Off: starting that implementation helper does not grant the model a command interpreter. Similarly, Network Off restricts task commands and adapters, while Pi's provider connection remains available. Stored credentials governs task access to credential files; Pi can still authenticate and refresh its own credentials.

Shell execution starts the kernel wrapper directly with a minimal launcher environment. The task's environment and shell initialization run inside confinement. Linux discovers Bubblewrap only in `/usr/bin` or `/bin`, requiring a root-owned executable without group/world write permission; task-controlled PATH entries cannot select the launcher. The adapter uses the active SDK's bounded output drain and detached-process tracking so cancellation, output collection, and Pi shutdown retain their lifecycle behavior.

Task commands receive a private scratch directory through the standard temporary-directory environment variables. For Outside project Read or Read/write, the default runtime compatibility policy additionally permits `/tmp` (canonical `/private/tmp` on macOS), the current user's macOS temporary directory, and that user's Security.framework MDS cache directory. These are explicit runtime exceptions, not a general outside-write grant. Outside Off does not expose them. Credential-file and runtime/control protections still take precedence. A protected anchor prevents renaming or replacing the private scratch root; retirement removes the owned scratch directory.

The task-call gate admits installed guarded implementations, verifies their host-owned source paths and distinct parameter-schema identities, and rejects tools without a verified execution adapter. A replacement cannot gain admission by copying a guarded schema. Tool visibility and a familiar tool name are insufficient evidence of confinement. Unsupported extension execution must fail closed. Task-requested extensions without adapters are not loaded into a sandboxed child merely because their tools were requested. Provider extensions remain trusted runtime dependencies. Inherited extension discovery and project-local runtime configuration are disabled for confined children.

Runtime code, installed dependencies, configuration, policy files, and control directories remain protected from task writes even under broad file grants. Both Main and Subagents protect the shared subagent and background-task registries, including when their tools are not admitted. Disposable task workspaces are separate from runtime metadata, so granting workspace writes does not grant control-file writes. A runtime protected path takes precedence over a broad Project files or Outside project grant.

## Trust and limitations

This boundary does not sandbox Pi itself or user-installed provider/extension code. That code is part of the trusted runtime, as are SDK parsing and rendering. Its initialization and runtime hooks are not an operating-system security boundary. A task tool can only be admitted when its implementation confines its task effects; arbitrary extension tools, direct SSH effects, and scripting bridges are unsupported until an adapter establishes that contract.

The credential-files scope from ADR 0005 remains unchanged. Inherited environment tokens and OS credential services are not controlled by the Stored credentials row. The current-user MDS runtime exception restores CLI Keychain compatibility; it does not enforce read-only Keychain APIs and permits writes to that user's MDS cache databases. No global writable `~/.pi`, cross-user `/private/var/folders`, or `*.lock` allowance is added. See [the compatibility map](../sandbox-default-compatibility.md) for the historical behavior and regression gate.

The native launcher requires Pi SDK 0.82.1 or newer and the active SDK's CLI. A different `pi` executable on PATH is rejected instead of silently launching a different runtime. Missing operating-system backends also reject confined launches.

## Verification contract

Use synthetic settings and credentials to prove actual Pi RPC startup succeeds with Outside project = Read and task commands/network disabled. Exercise the SDK's real tool dispatcher to prove permitted project writes, outside and runtime-control denials, immutable policy snapshots, rejection of unknown tools before their bodies execute, and rejection of replaced built-ins. Kernel tests must cover credential-file precedence, read-only projects, symlink escapes, and unavailable backends on supported platforms. Packaging tests must prove both consumers contain the shared task module and the subagent package contains the native launcher and guard.
