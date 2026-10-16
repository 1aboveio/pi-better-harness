---
name: pi-remote
description: Move a Codex thread and its workspace to another machine and back, list threads running on a remote host, and send them instructions. Use when the user wants to detach work to a server, check on or steer a remote thread, or bring it back to this machine.
---

# Pi Remote

Four tools from the `pi_remote` MCP server drive the `pi-remote` CLI. They need an ssh alias for the other machine, and `pi-better-server --agent codex` running on it.

- `remote_ls`: list threads on a host (or on this machine without `host`). Shows status: `running`, `idle`, `needs-input`.
- `remote_steer`: send a message to a thread. A running turn takes it at its next model call; an idle thread starts a turn.
- `remote_detach`: move a thread and its workspace (dirty and untracked files included) from this machine to a host. Do this only when the user asked for it. It waits for the current turn to finish, and this machine's copy is archived afterwards.
- `remote_return`: bring a thread back from a host and rebuild its workspace here. If the original directory is not empty, pass `to_cwd` with an empty directory. Resume locally with `codex resume <thread id>`.

Rules:
- Ask for the host alias if the user has not given one. Never guess it.
- After `remote_detach` the thread lives on the host only. Do not keep working on it here; use `remote_steer` to talk to it and `remote_return` to get it back.
- Report errors as they come; a failed move leaves the thread where it was.
- Codex sign-in is never copied between machines. The host needs its own `codex login` before it can run new turns.
