# pi-better-subagents

Detached, sandboxed subagents for [Pi](https://pi.dev).

Delegate work and keep going. Each subagent runs in its own `pi -p` child process, reports back when finished, and leaves the foreground session free for the human.

## Core Features

- Non-blocking subagent launches.
- Default OS write sandboxing on macOS and Linux.
- Explicit tool allowlists for child sessions.
- Durable logs and result retrieval across reloads.
- Live background-work navigator for active runs.

## Install

```sh
pi install npm:pi-better-subagents
```

Try it for one run:

```sh
pi -e npm:pi-better-subagents
```

Linux sandboxing uses `bubblewrap` when available:

```sh
sudo apt-get install bubblewrap
```

## Update Or Remove

```sh
pi update npm:pi-better-subagents
pi remove npm:pi-better-subagents
```

## More Detail

- Repository: https://github.com/1aboveio/pi-better-harness
- Detailed notes: https://github.com/1aboveio/pi-better-harness/blob/main/packages/pi-better-subagents/docs/usage.md
