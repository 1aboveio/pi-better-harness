# Sandbox tool loading and permission to use tools

**Status** — Accepted. This is the current decision for Main, Subagents and Background tasks. Use this record for future sandbox changes. The earlier records linked below preserve the rationale, platform details and evidence for previous implementations.

## Decision

**Tool loading answers “What can this task call, and which implementation supplies it?” Permission answers “May that implementation perform this operation on this resource?”** The sandbox switch controls enforcement for its own scope. Turning it Off restores ordinary tool behavior. Turning it On selects the confined execution path and enforces the active profile. A loaded tool can still have a call denied. A permission grant alone cannot supply a missing implementation.

| | Sandbox Off | Sandbox On |
| --- | --- | --- |
| Tool selection | Resolve the task's normal tool set and providers. Ignore the retained sandbox detail settings, including Subagents · Tools checkboxes. | Start with the same task selection. Bind guarded tools to their verified adapters and admit selected trusted extensions under the active profile. |
| Tool use | Apply the tool's ordinary contract, OS permissions and any other active boundary. | Also enforce the applicable file, credential, application, shell, timeout, network, process and trusted-tool rules. |
| Failure | Identify a missing or incompatible provider as a loading failure. | Identify a missing required adapter as a loading failure. Identify a refusal by an active rule as a permission denial. |

### Tool loading

1. Resolve what the caller selected for this task: its role and defaults, explicit tool list, explicit exclusions, supported runtime and launch mode. Exclusions take precedence. A read-only task stays read-only. A frozen continuation retains its recorded tool and provider choices, subject to current admission.
2. For each selected tool, determine its implementation. Harness must supply the implementation for every supported default tool selected for that worker. Isolated extension discovery must preserve these defaults without requiring the operator to add a mapping. A configured provider mapping remains effective in ordinary mode. An optional extension still needs an installed, compatible provider. The worker loads the providers it needs.
3. Select a trusted implementation for the execution mode. With confinement active, establish adapter or trusted-package ownership **before loading code that can run in the trusted Pi process**. Discovering a tool name does not authorize importing arbitrary parent or project extensions. At dispatch, verify that the active registration still belongs to the admitted implementation.
4. If the launcher can already establish that an explicitly required implementation is unavailable, return the tool name and reason before reporting a successful launch. The worker still checks actual registration at startup. Report a later registration failure as a startup failure. A profile can refuse use of a known tool at admission or at dispatch. Report the scope and blocking rule in that case. Reserve “tool unavailable” for a tool the selected runtime cannot supply.

### Permission to use a tool

Each column in `/sandbox` has an independent switch. All three start Off in fresh settings. The UI dims retained detail settings while their column is Off. Edits affect the current session branch. **Ctrl+S** saves defaults for new sessions. Existing saved choices survive migration. A legacy missing Background profile starts from a separate copy of Main.

Main evaluates the current profile for the next eligible operation. A child or local background process keeps the confinement it started with. Changing a setting affects subsequent launches. Re-enabling a profile restores its retained rules. A caller may request additional confinement with `sandbox:true`. A caller's `sandbox:false` cannot override a human-enabled Subagents profile. An unsupported backend or unsafe root refuses a requested confined operation.

An active enclosing boundary still applies. For example, Main can deny the command needed to start a subagent whose own profile is Off. For a verified local Background launch, the Background adapter owns command admission and snapshots the Background profile. It must still be verified when Main is Off and Background is On. SSH launches require their own admission.

### Examples

| Tool | Loading | Permission on use |
| --- | --- | --- |
| `apply_patch` | Harness supplies it by default to an ordinary editable subagent, including an isolated worker with Sandbox Off and no custom mapping. With Sandbox On, the guarded checkbox selects the Harness adapter. | Off uses ordinary file access regardless of the saved checkbox. On applies the same file rules as `edit` and `write` to every target, including removal for a delete or move. A third-party tool with the same name cannot replace the guarded adapter. |
| `web_fetch`, `web_search` and other extension tools | Off uses the selected ordinary provider. On admits a trusted tool by name and canonical package. The two web tools are trusted by default. Explicit tool lists and builtins-only launches retain their meaning. | With Network Off in an active profile, known network tools are refused. Trusted extension code runs in the Pi process, outside guarded file operations. |
| `bash` and `run_application` | An active profile that permits applications and disables shell scripts exposes the direct executable-and-arguments adapter for command-capable tasks. | Application, shell and per-command time limits apply while the profile is On. With it Off, retained limits cannot deny or shorten an otherwise permitted command. |
| `process_list` | Main and Subagents use a fixed adapter on supported platforms. | With the profile On, Process access controls inventory. With it Off, a retained Process Off cannot deny an otherwise available query. The fixed current-user, bounded PID/name output and privacy limits always apply. |

### Execution boundaries

- **Files and credentials.** Project files and Outside project support Off, Read, Write and Write & delete. Write restricts removal, including rename-over-existing, with documented disposable-directory exceptions. Protected paths and credential rules take precedence, including through aliases and symlinks. Stored credentials supports Off, Read and Write & delete for known credential files. OS credential services and inherited environment values have separate boundaries. Fresh retained defaults give all scopes project Write & delete. Main and Background retain outside Read and credential Read. Subagents retain outside Write and credential Write & delete.
- **Runtime and backends.** Pi startup, provider transport, configuration locks and session persistence run in the trusted runtime. Guarded task tools use the shared task executor and the private `sandbox-core` mechanism. macOS uses Seatbelt and Linux uses Bubblewrap with the supported filesystem restrictions. Fail closed when the requested protection cannot be enforced. The fixed Darwin process-identity helper supports the documented PID/start-time query under Process Read. Its protected binary and limited arguments are part of its contract.
- **Background ownership.** Verify the Background registration's canonical source, schema identity and operation classification. Local launch/watch, registry reads and local stop have distinct contracts. A tool with a copied name or schema cannot claim the local-adapter exemption. A command timeout caps each watch check.
- **Diagnostics.** Collection is opt-in, local, bounded and redacted. Record confirmed policy refusals separately from OS errors and worker-reported observations. A permission report provides evidence to the agent. It neither grants access nor automatically pauses a Goal.

### Acceptance criteria

1. Start a real editable SDK worker with Subagents Off, no custom mapping and the ordinary default tools. Invoke `apply_patch` and verify the file contents. Repeat with the retained guarded checkbox checked and unchecked, and with an explicit request for the tool. An earlier test expecting a missing-mapping error in this scenario is superseded.
2. Exercise a second selected tool with a compatible extension provider. With Subagents Off, its retained trust checkbox cannot deny its ordinary use. In a separate case, remove the required provider and verify a loading error that identifies the missing tool.
3. Enable Subagents and use the guarded patch adapter. Verify an allowed project change, a denied change outside the permitted scope, and an unchanged target after denial. A conflicting extension must not take over the guarded name. Exercise a trusted tool with its canonical provider and a same-name replacement.
4. Exercise each scope with restrictive detail values saved. Switch it Off, then On. Verify actual operations and retained settings at both steps, independent admission in the other scopes, and stable confinement for work already running. Include explicit tool exclusions, a read-only task, and the fixed output limits of `process_list`.

These are acceptance criteria. Historical test counts do not establish that the current installation implements the full contract.

## Decision history

| Subject | Historical decisions |
| --- | --- |
| Scopes, defaults, settings and explicit Off | [Activation](0004-foreground-sandbox-opt-in.md), [permission table](0005-sandbox-permission-table.md), [explicit Off](0026-explicit-sandbox-off.md) |
| Shared enforcement and trusted Pi startup | [Shared core](0003-sandbox-core-shared-package.md), [task boundary](0007-trusted-runtime-task-boundary.md), [Linux backend](../../packages/pi-better-subagents/docs/adr/0001-linux-sandbox-bubblewrap.md) |
| File operations and credentials | [Removal rules and platform limits](0008-write-without-delete.md), [permission levels](0010-unified-file-permission-labels.md) |
| Tool ownership, commands and processes | [Guarded and trusted tools](0009-guarded-and-trusted-subagent-tools.md), [process inventory](0011-fixed-read-only-process-inventory.md), [application and shell controls](0019-application-and-shell-controls.md), [macOS process identity](0024-sandbox-process-identity-compatibility.md) |
| Local Background operations and diagnostics | [Background admission](0017-background-adapter-admission.md), [local diagnostics](0015-local-sandbox-diagnostics.md) |
