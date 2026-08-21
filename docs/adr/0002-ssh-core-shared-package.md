# Shared remote SSH protocol lives in private `ssh-core`

Both durable remote jobs (`pi-better-background-tasks`) and sync remote exec (`pi-better-ssh`) need the same agent-safe SSH identity, argv construction, injectable runner seam, and remote tmux bootstrap/session helpers. Those belong in a private workspace package `packages/ssh-core`, vendored into publishable extensions the same way `log-utils` / `callback-batcher` are today. Product tools and task orchestration stay in the consumer packages; `ssh-core` is not a Pi extension and is not published to npm.

## Status

proposed

## Considered Options

1. **Duplicate helpers in each extension** — fastest short term; diverges on safety options, quoting, and tmux bootstrap within months.
2. **Put shared SSH inside `pi-better-background-tasks` and depend on it from `pi-better-ssh`** — couples a sync-shell product to background-task runtime/versioning and pulls unused task machinery into SSH-only installs.
3. **Private `ssh-core` consumed by both** — chosen. Matches existing internal-package + sync-into-consumers pattern; keeps publishable surfaces independent; lets ControlMaster land once and be optionally reused by bg_task later.

## Consequences

- Extract `ssh-core` from the current `remote-task-preset.ts` seam **before** building `pi-better-ssh`, with behavior-preserving tests on background-tasks as the proving ground.
- Day-one `ssh-core` includes tmux probe/install/session start/poll/kill as well as connection/argv/mux primitives. Background-tasks keep owning task metadata, callbacks, navigator, and spawn/watch policy.
- `ssh-core` follows the private workspace convention (`private: true`, short name, synced via `scripts/sync-shared-log-utils.mjs` or a sibling sync step) rather than becoming a published dependency.
