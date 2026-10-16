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

A client may open with `hello { protocolVersion, piVersion?, extensionVersions? }`.
The daemon answers with its own `{ protocolVersion, piVersion, extensionVersions }`.
It rejects the client, with an error naming both sides, then closes the
connection, when the protocol versions differ or when a stated `piVersion` is on
a different Pi major.minor. Extension versions are reported, never enforced.
A client that skips `hello` is still served.

## pi-remote

```sh
node src/remote-cli.ts ls [--host <ssh-alias>]
node src/remote-cli.ts new --host <h> --cwd <dir> "<prompt>"
node src/remote-cli.ts steer <session> "<message>"
node src/remote-cli.ts tail <session>
node src/remote-cli.ts answer <session> [--request <id>] (--value <text> | --confirm | --deny | --cancel)
node src/remote-cli.ts move <session> --to <ssh-alias> [--to-remote-dir <dir>] [--to-cwd <dir>]
```

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

## Crash recovery

A session stays `running` until `close_session`. On start the daemon reopens
every running session at the last entry in its JSONL. It does not start a turn
on its own.

## Host bootstrap

`scripts/bootstrap-host.sh [PREFIX]` installs a pinned Node, a pinned Pi and this
package's `src/` under `PREFIX` (default `~/.pi-better-server`) with no root, and
writes `PREFIX/bin/pi-server`.

## Detach and return (`/detach`, `pi-remote return`)

`/detach <ssh-alias> [--remote-dir <dir>] [--to-cwd <dir>]` is a Pi command (registered by `src/detach/extension.ts`, listed under `pi.extensions`). It moves the current plain local session and its workspace into the daemon on that host with the same move protocol as `pi-remote move`; this machine stands in as the source (`LocalSource`). Afterwards the local session is read-only (input is refused with a pointer to `return`); follow the remote one with `pi-remote tail <session> --host <alias>` and `steer` until the attach TUI is available.

`pi-remote return --host <alias> <session> [--to-cwd <empty dir>]` pulls it back: the workspace is rebuilt (default: where it lived before the detach if that directory is gone or empty; /detach leaves the original in place, so normally a new `<name>-returned` directory beside it, which the command prints; the original is never touched), the transcript is placed in Pi's session directory, and the daemon's copy is retired (`moved`; its workspace directory is left on the host). A returned session can be detached again.

Preflight runs before anything is fenced, and a refusal leaves the source untouched:

- the daemon answers and speaks this protocol; Pi (same major.minor) and pi-better-server are the pinned versions. Otherwise the refusal names `scripts/bootstrap-host.sh` (user-local install) as the fix.
- provider credentials resolve on the receiving side (a dry run, no model call); `gh auth status` passes when the repo remote is on GitHub (`PI_REMOTE_GH` overrides the binary).
- free disk at the workspace location is at least 3x the bundle plus a reserve (`PI_REMOTE_MIN_FREE_BYTES`, default 256 MiB).
- the repo remote answers `git ls-remote` from the receiving side.

The daemon exposes these as `move_preflight`. Not covered: installing for the user automatically (the refusal prints the command instead).

If `/detach` leaves this machine's copy fenced (the target was unreachable, or its reply was lost), the error prints the recovery command. It acts on this machine's record and first asks the daemon whether it holds the session: `pi-remote recover <session> --abort --host <alias>` reopens the local session when the daemon does not hold it; `pi-remote recover <session> --retire --move-id <id> --host <alias>` records it as moved when the daemon does. A Pi process that detached a session never runs it again, even after a `return`; resume it with `pi --session` in a new process.
