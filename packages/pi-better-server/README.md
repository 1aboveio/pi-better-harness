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
`close_session`. Responses use Pi's `{ type: "response", command, success }`
shape and echo `id` and `sessionId`. The connection that creates or opens a
session also receives `{ type: "event", sessionId, event }` lines.

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
```

A session is named by id, unique id prefix, or name. `ls` shows status (running,
idle, needs-input), last activity, cwd and git branch. `steer` queues into a
running turn and starts a turn on an idle session. `tail` follows live events
until Ctrl-C and remembers the last event `seq` it saw per session.

`--host` reaches a daemon on another machine: `pi-remote` opens an SSH
ControlMaster to the alias (through `packages/ssh-core`), forwards the daemon's
Unix socket to a private local one with `ssh -O forward`, talks to that, and
cancels the forward on exit. `--remote-dir` names the daemon's server dir there;
by default the remote shell is asked (`$PI_SERVER_DIR`, else
`$PI_CODING_AGENT_DIR/server`, else `~/.pi/agent/server`). Each subcommand is its
own module under `src/remote/`, registered in `src/remote-cli.ts`.

Tests against a real host: `PI_REMOTE_TEST_HOST=<alias> PI_REMOTE_TEST_HOST_ROOT=<dir>
npm test`, where the dir holds a Node and Pi as installed by `scripts/bootstrap-host.sh`.

## Crash recovery

A session stays `running` until `close_session`. On start the daemon reopens
every running session at the last entry in its JSONL. It does not start a turn
on its own.

## Host bootstrap

`scripts/bootstrap-host.sh [PREFIX]` installs a pinned Node, a pinned Pi and this
package's `src/` under `PREFIX` (default `~/.pi-better-server`) with no root, and
writes `PREFIX/bin/pi-server`.
