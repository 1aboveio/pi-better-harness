# pi-better-server

A daemon that hosts several Pi `AgentSession`s behind one local Unix socket, so
sessions keep running when no client is attached and come back after a crash.

## Run

```sh
node src/cli.ts        # Node >= 22.18 runs the .ts directly
```

Files live under `~/.pi/agent/server/` (override with `PI_SERVER_DIR`):

- `pi-server.sock`, mode `0600`, the only listener. There is no TCP port.
- `sessions.json`, the index of sessions and whether each is `running` or `closed`.

The directory is created with mode `0700` and tightened if it already exists.
Each session's conversation is an ordinary Pi session JSONL in the usual
`~/.pi/agent/sessions/` tree.

### Session and daemon lifetime

An active session is an open session, not a connected client or a currently
generating model. Disconnecting does not close it. By default:

- A session expires after **24 hours of inactivity**, even if an idle client is
  attached. Expiry closes its runtime but keeps its transcript and index row.
  Reopen it from the Closed tab to continue; interrupted tools are not replayed.
- Executing models, tools, shell commands, compaction, and observable
  session-owned background work prevent expiry, including silent execution.
  A fresh inactivity window starts when execution finishes. Waiting for user
  input is idle; expiry cancels pending dialogs rather than approving them.
- A daemon with no active sessions shuts down after **30 minutes**. Polling,
  heartbeats, and idle browser connections do not keep it alive.

Configure independent millisecond durations in `PI_SERVER_DIR/lifecycle.json`:

```json
{
  "sessionIdleMs": 86400000,
  "daemonIdleMs": 1800000
}
```

`0` disables the corresponding timer. Precedence is programmatic daemon options,
then `PI_SERVER_SESSION_IDLE_MS` / `PI_SERVER_DAEMON_IDLE_MS`, then the saved file,
then defaults. Values must be non-negative safe integers. Changes take effect
on the next daemon start. The daemon owns the clocks; idle session deadlines
survive restarts and include time offline. Renaming, listing, reading snapshots,
and passive reconnect traffic do not refresh session activity.

The server directory also contains an exclusive `daemon-owner/` claim. A live
process owner is never evicted because a timer or connection attempt expired.
Crash recovery reclaims dead ownership before reading or resuming the session
index, preventing concurrent starters from creating competing transcript writers.

The current Subagents provider scopes work by session. Older providers without
ownership information are handled conservatively: process-wide active work can
keep other idle sessions alive too. If a caller supplies a custom resource loader
without activity observation, automatic expiry is disabled for that runtime;
manual close remains available. Unknown external processes are not treated as
observable session-owned work.

## Protocol

Strict LF-delimited JSON lines. A session command is a Pi RPC command (the
`RpcCommand` payloads from `@earendil-works/pi-coding-agent`) plus `sessionId`.
Daemon commands: `list_sessions`, `create_session`, `open_session`,
`close_session`. Control commands, each addressed to one `sessionId`:
`subscribe`, `acquire_control`, `release_control`, `extension_ui_response`.
Responses use Pi's `{ type: "response", command, success }` shape and echo `id`
and `sessionId`.

Events reach a connection only after `subscribe` (or, for the connection that
issued `create_session`, from the start). `open_session` loads a session but
does not stream. Each event is `{ type: "event", sessionId, seq, event }`, where
`seq` counts up per session. `subscribe { sessionId, sinceSeq? }` first replays
the retained events after `sinceSeq` (omit it for live only), then streams live;
its response reports `truncated: true` when some of those events are no longer
retained. Subscribing again on the same connection replaces the earlier
subscription.

An extension dialog (select, confirm, input, editor) is held until someone
answers it; it shows as `needsInput` in `list_sessions` and `get_state`.
`acquire_control` takes the single controller lease (it also ends when the
connection drops) and returns the pending dialogs; `release_control` gives it
back. Only the lease holder may send `extension_ui_response { sessionId,
requestId, value | confirmed | cancelled }`.

`steer` while a turn runs is delivered after the current tool calls and before
the next LLM call. `steer` on an idle session starts the next turn.
`new_session`, `switch_session`, `fork` and `clone` are refused: one session id
owns one session file.

## Handshake

A client may open with `hello { protocolVersion, piVersion?, extensionVersions?, capabilities? }`.
The daemon answers with its own versions and capabilities, plus the managed
`build` and daemon `instanceId` when available. Native clients supporting transport
replacement announce `runtime-reconnect-v1`; eligible daemons advertise
`safe-upgrade-v1`.
It rejects the client, with an error naming both sides, then closes the
connection, when the protocol versions differ or when a stated `piVersion` is on
a different Pi major.minor. Extension versions are reported, never enforced.
A client that skips `hello` is still served.

## Native remote client (`/remote`, experimental)

The native client provides an experimental VS Code Remote-style workflow:
start ordinary local Pi **1.2.0** with this package loaded at startup, then run
`/remote connect r5`. The terminal keeps Pi's native local UI while the remote daemon owns
the model, tools, workspace and session state. Your local conversation stays separate
unless you explicitly choose to move or copy it after connecting.

Connecting installs or stages the matching server build automatically, verifies
readiness and compatibility, and then opens the SSH tunnel. A registered runtime
keeps its agent and server directories. A new host uses `~/.pi/agent` and
`~/.pi/agent/server`. See [automatic server updates](#automatic-server-updates)
for busy sessions, older daemons and manual launcher overrides.

### Connect and disconnect

The opt-in extension is loaded through the normal `pi.extensions` package manifest
(`src/remote-client/extension.ts`), not a separate client launcher. Configure the
package before starting Pi: loading it later with `/reload` cannot capture the
startup bridge. Wait for local work, including `!` commands, to finish before
connecting.

```text
/remote
/remote list
/remote connect
/remote connect r5
/remote r5
/remote r5 --cwd /home/user/workspaces/project
/remote r5 --session <id-or-unique-prefix>
/remote r5 --remote-dir /home/user/.pi/agent/server
/remote disconnect
/remote sessions
/remote pull
/remote pull r5 --session <id-or-unique-prefix> --cwd /local/existing/project
/remote pull r5 --session <id> --copy
```

`/remote list` displays SSH aliases and previously entered hosts. Select a host
and press Enter to confirm a connection. `/remote connect` opens a host picker;
`/remote connect r5` connects directly. Root slash-command autocomplete shows
actions only. Host suggestions appear only after `connect`, with a complete
`connect <host>` completion value. `/remote r5` remains a supported shorthand.

While connecting, a native spinner shows the current stage: establishing SSH,
finding the remote server, opening the tunnel, or contacting the Pi daemon.
Escape cancels that attempt and returns to the local UI. It does not stop any
remote sessions or shared SSH connection. Connection failures retain their original
error message; the spinner does not imply that an unreachable host is available.

Connecting opens the server's session landing page, including when the local
session has history. Selecting an explicit `--session` attaches directly instead.
The landing page has **Active sessions** and **Closed sessions** tabs, with sessions
grouped by their full working folder. Move and Copy remain explicit actions when
a local conversation is available; connecting alone never authorizes a transfer.
The browser displays its keyboard shortcuts:

| Key | Action |
| --- | --- |
| Up / Down | Select a session |
| Tab / Shift-Tab / Left / Right | Switch tabs |
| Enter | Attach to the selected session; reopen it if closed |
| `x` | Close the selected active session; confirm if busy or waiting for input |
| F2 | Rename the selected session, including a closed session without reopening it |
| `n` | Browse remote folders before starting a new session |
| `r` | Refresh the list |
| `m` / `c` | Move / copy the local conversation; choose a destination folder and transfer scope first |
| Escape | Leave the server browser |

New Session opens a folder picker. Up / Down selects a folder, Enter opens it,
`s` chooses the current folder, and `n` creates a new child folder there. The
parent-folder entry navigates up; Escape returns to the same session selection.
Creating a folder navigates into it but does not start a session until you press
`s`. Existing folders, files, and symbolic links are never replaced. If the
default workspace root is missing, navigate to its parent and explicitly create
or select a directory; browsing does not create missing directories automatically.

Native loaders show progress while loading the browser, listing folders, creating
a folder, checking or installing extensions, and opening or starting a session.
Escape can dismiss a read-only wait. Writes that the daemon cannot cancel keep
their progress visible until the outcome is known. Folder browsing requires a
daemon advertising `folder-browser-v1`; older daemons can still list and attach
existing sessions and show update guidance when folder browsing is requested.

Fenced and moved sessions cannot be attached, closed or renamed from the browser.
While attached, `/remote` or `/remote sessions` returns to this host-level page
without stopping remote work. The local conversation remains separate.

The catalog deduplicates literal SSH `Host` aliases (including `Include` files)
and local `/remote` history. Wildcard and negated SSH patterns are not concrete
hosts and are omitted. Entered hosts are remembered even if the connection fails
or uses the default server directory; no credentials are recorded in this history.

`r5` is an SSH alias. The folder picker starts at the remote workspace root:
`PI_SERVER_WORKSPACES_DIR`, or `~/workspaces/` when unset. The landing page's Folder
line shows this starting context, not a filter on existing sessions. Existing
sessions remain visible and retain their own folders. Use an explicit `--cwd`
with another absolute path to change where folder browsing begins; it also refuses
attaching an existing session from a different workspace. You can navigate to
other directories accessible to the SSH user. `--session` selects a session
directly without changing its working directory.
`--remote-dir` selects the remote daemon's server directory and is saved per host
with its connection history. It is reused on later connections to that
host; otherwise the usual remote server-directory discovery applies.

`/remote disconnect` restores the original local history in a fresh local runtime.
After a handoff, that original history stays read-only; resume a returned transcript
using the path printed by `/remote pull`. Disconnecting releases the connection
without aborting the remote session or its work.
A lost connection disables remote commands; use `/remote disconnect` to return
locally, then connect again. There is no automatic server setup: provision the
remote daemon, workspace and provider credentials separately.

### Move or copy a conversation

Sending the local session is part of `/remote connect`; there is no separate
`/remote push` command. Choose move or copy, then the transfer scope and destination.
A final confirmation shows the session, source, destination, scope and ownership
outcome before a transfer begins.

The default is a **conversation-only handoff** into an existing folder. Project
files in that folder are untouched, and neither folder needs to be a Git repository.
Workspace files are optional and require a new or empty destination. A transfer
never merges existing conversations.

A handoff keeps the session ID and fences the source before taking its snapshot.
The source becomes read-only after the destination acknowledges ownership. If the
outcome cannot be determined, the source stays fenced and recovery guidance is
printed. Do not start another writer until that outcome is resolved. A copy gets
a new session ID, and both conversations remain independently writable.

`/remote pull` brings a remote session back. While connected it defaults to that
host and session; otherwise it offers host and session selection. `--copy` keeps
the remote source writable. `--with-workspace` includes files, and `--cwd` selects
the local destination. Pulling a handoff of the currently attached session also
disconnects that remote view. The result prints the local transcript path and its
`pi --session` command; retained older snapshots are not writable substitutes.

Native transfers gzip the archive **before sending it over the connection**.
Conversation entries are retained, not compacted; transcript metadata records the
destination folder and, for copies, the new ID. Decoded archives are limited to
1 GiB and checked before import. Both ends must advertise `session-transfer-v1`
and `compressed-bundle-v1`. Legacy raw archives remain readable. Provider
credentials and machine settings are not synchronized, but conversation text and
optional workspace files can contain secrets: review the scope before approving.

### Compatibility and controls

The native bridge in `src/remote-client/pi-1.2-bridge.ts` uses private Pi internals
and supports **exactly Pi 1.2.0** on the local client. This is narrower than the
daemon's general Pi compatibility. Client and daemon Pi major.minor versions must
match, and the remote daemon must be upgraded to code advertising
`native-client-v1` and `session-browser-v1`. An older daemon is refused before the local runtime is replaced.
This describes work in development, not a production release.

Core native controls for `/model`, `/thinking` and `!` shell commands operate on
the remote session. While connected, these local/session-management operations
are blocked: `/new`, `/fork`, `/clone`, `/tree`, `/resume`, `/import`,
`/trust`, `/share`, `/settings`, `/login`, `/logout`, `/export`, `/debug`,
`/scoped-models` and `/bug`. Disconnect before using them locally.

Standard remote extension dialogs (select, confirm, input, editor), notifications,
status and text widgets can be presented locally. Arbitrary remote `ctx.ui.custom`
screens, custom component widgets and remote extension renderers are not supported.
Synchronizing a package installation does not provide full extension UI parity.

### Automatic server updates

Native `/remote connect` builds an artifact from the client's installed package
files, including unpublished source changes. A Git checkout is not required.
The build identity includes the source, target platform, SDK, Node version and
dependency lock. Supported remote targets are Linux and macOS on x64 and arm64.

The server runs from an immutable release under
`~/.pi-better-server/managed/releases/<build-id>`, outside `node_modules`. Each
release contains private Node **24.14.1** and SDK **1.2.0** dependencies installed
on the target. Node checksums and locked dependency integrity are verified. If
target downloads fail, the client downloads and uploads verified archives instead.
Concurrent connectors share the same release only after integrity validation.
Published releases are not overwritten to repair corruption.

Staging can proceed while sessions run. Activation waits for all sessions to be
idle, including SDK preflight and settlement, queued messages, compaction, shell
commands, dialogs and observable background work. Native cache warming is also
protected, including pending decision and provider requests. Activity observation
does not hold the upgrade admission fence while waiting. Unsupported SDK guards
or unobservable activity defer activation rather than establishing idleness.

An eligible daemon records the stop commitment, closes execution admission and
notifies attached native clients before releasing ownership. The successor adopts
the same state directory only after that release. Each client keeps its existing
session adapter and UI bindings, validates the new build and daemon instance, and
reconciles its snapshot, event cursor and controller lease. Interrupted requests
are not replayed. Recovery reconnects to the announced build in the selected
state directory; it does not install or activate the recovering client's build.
An unannounced connection failure still requires reconnecting.

The runtime update does not rerun bootstrap, install its default extension list,
copy credentials or rewrite agent preferences. Remote-only packages and session
histories remain in their existing directories. Global runtime registration is
updated only after verified readiness for the registered default state directory.
Workspace package synchronization remains a separate approval step below.

Older daemons without `safe-upgrade-v1`, unknown owners, incompatible protocols
and SDK downgrades are deferred. A missing socket or elapsed timeout is not
permission to replace a live owner. An unverified legacy state directory may need
an explicit migration before automatic activation can proceed. The client leaves
the old daemon running and reports the reason instead of killing it.

Activation records live in `<serverDir>/activation.json` and `activation.log`.
`recovery-required` preserves an ambiguous or adopted candidate for inspection;
it does not authorize another writer or a rollback. Automatic rollback is limited
to a proven candidate exit before adoption and restores code only, not settings,
packages or history. Repeating that failed operation does not stop the restored
runtime. A fresh request needs verified rollback completion and ownership before
starting another attempt. Do not delete ownership files to force an update.

An explicit `PI_SERVER_COMMAND` opts out of managed installation and keeps that
absolute launcher authoritative. Older SDK CLI clients retain registered-launcher
startup by default. Codex daemons and explicit local sockets are not managed by
this native installation workflow.

### Reload remote extensions

While connected, `/reload` reloads the daemon's extension runtime, tools and
commands, then refreshes native client metadata and command completion. It does
not reload laptop extensions or settings. The daemon must advertise
`remote-reload-v1`; older daemons return update guidance.

Reload requires idle sessions because Pi changes process-wide provider
registrations. Model, tool, bash, compaction and observable background work,
pending activity checks, dialogs and runtime maintenance prevent reload. It
preserves conversation history, event subscriptions and the controller lease.
A failed runtime rebuild is fenced; explicitly close and reopen that session
before executing again.

### Package synchronization

Before attaching to the remote session, the client reads the locally
configured, installed npm/git package catalog. It resolves npm packages to their
installed exact versions and git packages to full installed commit pins. The
confirmation previews additions and replacements, including `extensions`,
`skills`, `prompts`, `themes` filters and `autoload`. Declining skips synchronization
and continues with the remote catalog. Remote-only packages are retained.

Only approved package declarations are synchronized. Credentials, settings outside
those declarations and local extension/resource sources are not copied;
unsupported local entries are reported. The preview uses the selected remote
workspace's effective catalog. Installs update the remote global packages. A
trusted project declaration that overrides an approved package causes refusal rather than rewriting the
repository's `.pi/settings.json`; manage that override on the remote host. Package
updates require idle daemon sessions and refuse concurrent runtime loading or
maintenance. Approved updates automatically refresh hosted runtimes and connected
clients. Installation stops on the first failure; earlier successful installs are
not rolled back, so idle runtimes are refreshed even after an install failure.
Busy work is not aborted to make an update proceed.

### Verification status

Earlier real-host verification used bundled Pi 1.2.0 on the laptop with the native
UI: `!hostname` returned `r5`, and a model-driven remote tool call returned
`CLIENT_REMOTE_OK r5`. Disconnect, reconnect and lost-transport recovery restored
the expected local and remote histories.

The complete server suite passes on both supported SDK test layouts: **702 passed,
18 expected skips on SDK 0.82.1**, and **713 passed, 7 expected skips on SDK 1.2.0**.
Each layout covers 720 tests with no failures or cancellations. Both TypeScript
checks pass. Skips cover SDK-specific behavior and opt-in installation checks.
Test workers are bounded to four to avoid oversubscribing subprocess-heavy fixtures.

Real-process upgrade checks attach two native session adapters to one managed
daemon, defer activation during a gated tool, reconnect both views, and continue
with their original objects, history and UI bindings. Pull-copy and move use the
replacement clients. See [upgrade integration](test/remote-upgrade-native.test.ts),
[transport races](test/remote-upgrade-reconnect.test.ts),
[startup admission](test/startup-admission.test.ts), and
[SDK quiescence](test/maintenance-sdk-quiescence.test.ts).

An actual Pi 1.2.0 terminal journey passed 44 checks against the current complete
backend and client. It verified busy deferral, transport-only recovery without
another activation, unchanged UI and session object identities, live replies,
pull-copy and disconnect. No local model ran during attachment, and cleanup left
no owned processes or sockets.

Separate private installations on macOS arm64 and Linux x64 verified Node 24.14.1,
SDK 1.2.0 and sealed-release reuse. The macOS check exercised client-download and
upload fallback. A Linux SSH cancellation check entered a bounded dependency
subprocess, aborted its transport, and verified scratch and lock cleanup while
preserving a published-release sentinel. Synthetic agent files remained unchanged;
these installer checks did not start a production daemon.

Earlier native Pi 1.2.0 checks verified browser creation and its first model
reply, live updates and controller access after pull-copy, and newly reloaded
commands and tools without reconnecting. Both native journeys used private fake
providers, not external model credentials. See the regressions for
[new-session selection](test/remote-new-session-model.test.ts),
[attached-source copies](test/remote-pull-copy-live.test.ts), and
[remote reload](test/remote-reload.test.ts).

A separate temporary daemon on `r5` verified compressed copy and handoff in both
SSH directions, returned-session continuation, and remote reload. Its repetitive
740,842-byte seeded transcript travelled in a 3,550-byte archive, a 99.52% reduction;
original conversation entries and existing destination files were preserved.
All owned test runtimes were stopped. The active host daemon was not upgraded or
restarted. These checks are development compatibility evidence, not full custom
extension UI parity or a production release.

## pi-remote

```sh
node src/remote-cli.ts ls [--host <ssh-alias>]
node src/remote-cli.ts new --host <h> --cwd <dir> "<prompt>"
node src/remote-cli.ts steer <session> "<message>"
node src/remote-cli.ts tail <session>
node src/remote-cli.ts answer <session> [--request <id>] (--value <text> | --confirm | --deny | --cancel)
node src/remote-cli.ts move <session> --to <ssh-alias> [--to-remote-dir <dir>] [--to-cwd <dir>]
```

For Pi sessions, `pi-remote attach` still opens the daemon's companion console in
tmux (over SSH for a remote host). It is not the native local `/remote` client
described above.

A session is named by id, unique id prefix, or name. `ls` shows status (running,
idle, needs-input), last activity, cwd and git branch. `steer` queues into a
running turn and starts a turn on an idle session. `tail` follows live events
until Ctrl-C and remembers the last event `seq` it saw per session; the next `tail` asks the daemon to replay what it missed (`subscribe` with `sinceSeq`). `answer` takes the controller lease, answers a dialog an extension is waiting on, and gives the lease back; without an answer flag it lists the pending dialogs.

`--host` reaches a daemon on another machine: `pi-remote` opens an SSH
ControlMaster to the alias (through `packages/ssh-core`), forwards the daemon's
Unix socket to a private local one with `ssh -O forward`, talks to that, and
cancels the forward on exit. `--remote-dir` names the daemon's server dir there;
by default the remote shell is asked (`$PI_SERVER_DIR`, else
`$PI_CODING_AGENT_DIR/server`, else `~/.pi/agent/server`). Each subcommand is its
own module under `src/remote/`, registered in `src/remote-cli.ts`.

Tests against a real host: `PI_REMOTE_TEST_HOST=<alias> PI_REMOTE_TEST_HOST_ROOT=<dir>
npm test`, where the dir holds a Node and Pi as installed by `scripts/bootstrap-host.sh`.

## Moving a session (`pi-remote move`)

`pi-remote move <session> --to <ssh-alias>` moves a session and its git workspace to
another daemon (`--host` picks the source daemon, default local; `--to-socket <path>`
targets a daemon on this machine). Steps: wait for a safe boundary (no turn running;
`--wait <s>`, default 30) -> fence the source -> bundle -> chunked transfer over the
daemons' own sockets (the SSH forward carries it) -> target verifies the archive sha256
and every manifest checksum, rebuilds the workspace, checks the rebuilt tree against the
manifest's per-file digest, opens the session (the acknowledgement) -> source retires.
The workspace lands under the target's `<server dir>/workspaces/<session id>/` unless
`--to-cwd` is given.

Ownership: each daemon keeps `ownership.json` (`owned` -> `fenced` -> `moved`, with an
`epoch`). A fenced or moved session refuses every command and is not resumed on boot, so
there is never a second live writer. Any failure before the acknowledgement aborts the
target and unfences the source. If the target cannot be reached to learn whether it
took the session, the source stays fenced and says so; `pi-remote move --abort <session>`
unfences it once the target is known not to hold it. If the target owns the session and only
retiring the source failed, the message prints `pi-remote move --retire <session> --move-id <id>
[--moved-to <daemon-id>]`; never `--abort` in that state. A workspace holding an untracked nested
git repository or a submodule is refused (commit/push it separately or move it out), never moved
with it silently missing. Staged vs unstaged state is not
preserved (dirty changes arrive unstaged); a committed `.env` stays in history.

The agent-agnostic core lives in `src/core/` (no Pi imports): `bundle.ts`
(createBundle / verifyBundle / materializeWorkspace / digestWorktree), `ownership.ts`,
`transfer.ts`, `exclusions.ts`. `src/move/` is the Pi glue.

Bundle format (`formatVersion: 1`), a tar of regular files:

| member | content |
| --- | --- |
| `manifest.json` | below |
| `git.bundle` | `git bundle` of the branch (or `HEAD`) plus the base ref |
| `tracked.patch` | `git diff --binary HEAD` of dirty tracked files (optional) |
| `untracked/<path>` | untracked, non-ignored files that pass the exclusion rules |
| `session/<name>`, `state/<name>` | session transcript files and session-scoped harness state |

Manifest: `{formatVersion, createdAt, agent:{kind,version,extensions}, session:{id,name?,model?,createdAt?,metadata?},
ownership:{epoch,from,moveId}, repo:{remote?,branch?,head,baseRef?,baseSha?}, files:[{path,role,sha256,size}],
symlinks:[{path,target}], excluded:[{path,reason:"credential"|"generated"}], worktree:[{path,sha256,mode}],
totals:{files,bytes,worktreeFiles,worktreeBytes}}`. `files` checksums every archive member;
`worktree` is the sha256 (and `644`/`755`/`symlink` mode) of every file the restored tree must hold.
Never bundled: any file whose name starts with `.env` (`.env`, `.env.local`, `.envrc`, `.env-prod`, ...), `.npmrc`/`.netrc`/`.git-credentials`, `auth|credentials|secrets.*`, `id_*`, `*.pem|key|p12|pfx|jks`,
`.ssh/.aws/.gnupg/.kube/.docker` content, `node_modules`, build output and caches, anything git ignores, and no
Pi/`gh`/provider auth files (only the transcript and an index row are read from the agent dir).

## Codex threads (`pi-better-server --agent codex`)

The same `move` core carries a Codex thread. Run one daemon per Codex host (`pi-better-server --agent codex`, or
`PI_SERVER_AGENT=codex`); it speaks the daemon socket protocol for `list_sessions`, the move commands and
`codex_endpoint`, and keeps Codex's own app-server running through `codex app-server daemon start`. Settings:
`PI_CODEX_BIN` (the `codex` executable), `CODEX_HOME` (default `~/.codex`), `PI_CODEX_VERSION` (refuse to run unless
`codex --version` is exactly this).

- **What travels:** the thread's rollout file (`sessions/YYYY/MM/DD/rollout-*-<id>.jsonl`) plus the workspace bundle.
  The app-server rebuilds its state db and paginated history from the rollout, so nothing else is needed. The import
  rewrites only the `cwd`, `runtime_workspace_roots` and `workspace_roots` fields of `session_meta`, `turn_context` and
  `thread_settings_applied` records to the rebuilt workspace; conversation text is untouched. The source thread is archived (the tombstone).
- **Never travels:** `auth.json` or any Codex credential. The target host signs in on its own (`codex login`).
- **Model provider:** a thread keeps the provider it was recorded under (`session_meta.model_provider`), and a host's sign-in belongs
  to the providers that host configured, so before anything is fenced `pi-remote move` asks the source for the thread's provider and
  the target whether its Codex can use it (configured in `config.toml`, or built in and signed in; an API-key login belongs to the
  host's default provider, not to the built-in `openai`). If not, the move is refused naming the provider and nothing is changed; the
  target checks again at import. `--codex-provider <id>` (on `move` and `return`) rebinds the thread to a provider the destination
  has: the import rewrites only `session_meta.model_provider` and the `model_provider_id` of `thread_settings_applied` events. The
  thread's model is not changed, so pick a provider that serves it.
- **Version pin:** the bundle records `codex --version`; the target refuses unless its own is identical. `pi-remote
  attach` refuses the same way. `PI_CODEX_VERSION` pins a host to one version outright.
- **Socket only:** the app-server is reached through its unix control socket, locally or ssh-forwarded; there is no
  TCP listener. `pi-remote attach [--host h] <thread> [-- <codex options>]` forwards that socket and runs
  `codex resume <thread> --remote unix://<forwarded socket>`.
- **Not carried:** thread goals, queued messages and read receipts live in separate Codex databases and stay behind.
  The fence archives the thread on the source app-server, which unloads it for every client (pi-remote attach,
  `codex resume --remote`, anything else), so none can start or continue a turn until the move is aborted
  (the thread is unarchived) or retired. A turn already running is waited for before fencing; one that starts in the
  instant between the last busy check and the archive is not interrupted by the fence itself.

### Steer, list, return

- `pi-remote ls [--host h]` lists threads (status `running`, `idle`, or `error: <message>` when the thread's last turn failed, e.g. a 401 from the provider). Threads that moved away are archived and still listed, as `closed` (moved).
- `pi-remote steer [--host h] <thread> "<message>"` goes through the app-server: `turn/steer` while a turn runs (the text joins the
  turn at its next model call), `turn/start` when idle. The reply says which one happened. A turn that fails right after it starts (a rejected key, say) is reported instead: `steer` prints the error and exits 1 (the watch lasts `PI_CODEX_TURN_WATCH_MS`, default 3000). A fenced or moved thread refuses.
- `pi-remote return --host h <thread> [--to-cwd <empty dir>] [--codex-provider <id>] [--wait s]` is the move in the other direction: the host's thread is the
  source and this machine's Codex daemon the target (the running one in `PI_SERVER_DIR`, else one started for the command). The host
  keeps the thread fenced until this machine acknowledges it, so a failed return leaves it live on the host; afterwards the host's copy is archived.
  The workspace goes back to where the thread lived before it moved when that directory is free, otherwise pass `--to-cwd`.
  While this machine's daemon is running it holds the thread, so a standalone `codex resume` / `codex exec resume` is refused ("already has an active writer"): continue with `pi-remote attach <thread>` or `pi-remote steer <thread> "<message>"`.
- Codex plugin: `codex plugin marketplace add <this package>/codex-plugin`, then `codex plugin add pi-remote@pi-remote`. It adds a skill and four
  tools (`remote_detach`, `remote_ls`, `remote_steer`, `remote_return`) that run `pi-remote` (`PI_REMOTE_BIN` names the executable).

## Crash recovery

A session stays `running` until explicit close or inactivity expiry. On start the
daemon reopens owned running sessions at the last entry in their JSONL. It does
not start a turn or replay interrupted tools on its own. Persisted inactivity
continues across downtime; interrupted execution receives a fresh idle window.

## Host bootstrap

Bootstrap is optional for native `/remote connect`. It remains available for
manual installations and registered-launcher CLI startup. Managed runtime updates
do not rerun bootstrap or install the extension defaults listed here.

`scripts/bootstrap-host.sh [PREFIX]` installs a pinned Node, a pinned Pi and this
package's `src/` under `PREFIX` (default `~/.pi-better-server`) with no root, and
writes `PREFIX/bin/pi-server`. It atomically registers that launcher, agent
directory and default server directory in `$HOME/.pi/remote-server.json`, mode
`0600`. Native `/remote` and `pi-remote` use that same registration, so aliases
such as `115` and `r5` select the same default state directory. Explicit
`--remote-dir` remains authoritative. `PI_SERVER_COMMAND` may select an absolute
installed launcher path; it is not a shell command.

`pi-server ensure` prints one JSON readiness record and exits after starting or
reusing the detached daemon. Its log is `<serverDir>/daemon.log`; connection
cancellation does not kill an already launched daemon. No login script, tmux
session, or boot service is needed. Codex transport callers use
`pi-remote --agent codex ...` or `PI_SERVER_AGENT=codex`; Pi on-demand startup and
these lifecycle timers do not manage Codex daemons.

Bootstrap also installs and enables these Pi packages by default through
`pi install`:

| Package | Pinned version | Version override |
| --- | --- | --- |
| `@vanillagreen/pi-codex-minimal-tools` | `2.1.4` | `MINIMAL_TOOLS_VERSION` |
| `@juicesharp/rpiv-ask-user-question` | `2.13.9` | `ASK_USER_QUESTION_VERSION` |
| `@juicesharp/rpiv-web-tools` | `2.13.9` | `WEB_TOOLS_VERSION` |
| `pi-better-harness` | `0.31.0` | `HARNESS_VERSION` |

Pi registers the packages in `PI_CODING_AGENT_DIR` (default `~/.pi/agent`), so native
Pi and daemon sessions using that agent directory load the same extensions. Set
`PI_CODING_AGENT_DIR` both when
bootstrapping and when launching Pi/the daemon if using an isolated agent directory:

```sh
export PI_CODING_AGENT_DIR="$HOME/.pi-server-agent"
PI_VERSION=1.2.0 scripts/bootstrap-host.sh
~/.pi-better-server/bin/pi-server
```

Provider and web-search credentials are still provisioned separately on the host.
The daemon's attach console does not gain native Pi's custom extension screens;
use native Pi on the host in tmux for those screens. The local native `/remote`
client above also cannot transport arbitrary custom screens. Project workspaces
belong outside the runtime installation, for example under `~/workspaces/`.

`PI_VERSION=1.0.0` picks the Pi version (default 0.82.1);
the daemon works on Pi 0.82 and 1.x, and `hello` reports the installed one. On Pi 1.x the
`prompt`, `steer` and `follow_up` responses carry Pi's `data.disposition`
(`started`, `handled` or `queued`); on 0.82 they carry no data.
`scripts/test-on-pi.sh <pi-version>` runs the package tests against any Pi version in an
isolated install, leaving the repo's lockfile alone.

## Detach and return (`/detach`, `pi-remote return`)

`/detach <ssh-alias> [--remote-dir <dir>] [--to-cwd <dir>]` is a Pi command (registered by `src/detach/extension.ts`, listed under `pi.extensions`). It moves the current plain local session and its workspace into the daemon on that host with the same move protocol as `pi-remote move`; this machine stands in as the source (`LocalSource`). Afterwards the local session is read-only (input is refused with a pointer to `return`); follow the remote one with `pi-remote tail <session> --host <alias>` and `steer`, use `pi-remote attach` for the companion console, or connect from another local Pi process with native `/remote` above.

`pi-remote return --host <alias> <session> [--to-cwd <empty dir>]` pulls it back: the workspace is rebuilt (default: where it lived before the detach if that directory is gone or empty; /detach leaves the original in place, so normally a new `<name>-returned` directory beside it, which the command prints; the original is never touched), the transcript is placed in Pi's session directory, and the daemon's copy is retired (`moved`; its workspace directory is left on the host). A returned session can be detached again.

Preflight runs before anything is fenced, and a refusal leaves the source untouched:

- the daemon answers and speaks this protocol; Pi (same major.minor) and pi-better-server are the pinned versions. Otherwise the refusal names `scripts/bootstrap-host.sh` (user-local install) as the fix.
- provider credentials resolve on the receiving side (a dry run, no model call); `gh auth status` passes when the repo remote is on GitHub (`PI_REMOTE_GH` overrides the binary).
- free disk at the workspace location is at least 3x the bundle plus a reserve (`PI_REMOTE_MIN_FREE_BYTES`, default 256 MiB).
- the repo remote answers `git ls-remote` from the receiving side.

The daemon exposes these checks as `move_preflight`; that RPC does not install
or upgrade a runtime. Connection setup follows the managed or registered-launcher
policy above before transfer preflight runs.

If `/detach` leaves this machine's copy fenced (the target was unreachable, or its reply was lost), the error prints the recovery command. It acts on this machine's record and first asks the daemon whether it holds the session: `pi-remote recover <session> --abort --host <alias>` reopens the local session when the daemon does not hold it; `pi-remote recover <session> --retire --move-id <id> --host <alias>` records it as moved when the daemon does. A Pi process that detached a session never runs it again, even after a `return`; resume it with `pi --session` in a new process.
