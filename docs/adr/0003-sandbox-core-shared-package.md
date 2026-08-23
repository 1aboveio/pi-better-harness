# Shared OS write-sandbox mechanism lives in private `sandbox-core`

The kernel-enforced write confinement proven by `pi-better-subagents` is needed by three products: detached subagent runs, the foreground `pi-better-sandbox` extension, and local `pi-better-background-tasks` spawn/watch. The mechanism — backend discovery, canonical path containment, write-deny compilation, macOS SBPL profile construction, Linux Bubblewrap mount construction, and ordered executable/argv wrapping — belongs in a private workspace package `packages/sandbox-core`, vendored into publishable extensions the same way `ssh-core` and `log-utils` are today. Product policy (when a sandbox is requested, what it may write, what a user may toggle) stays in the consumer packages; `sandbox-core` is not a Pi extension and is not published to npm.

## Status

accepted and implemented by epic [#229](https://github.com/1aboveio/pi-better-harness/issues/229), extraction slice [#230](https://github.com/1aboveio/pi-better-harness/issues/230)

## Considered Options

1. **Leave the mechanism in `pi-better-subagents` and depend on it** — couples a foreground write sandbox to detached-run lifecycle, metadata, and versioning, and pulls subagent machinery into installs that only want the foreground sandbox.
2. **Duplicate the profile/mount builders per consumer** — the shape most likely to drift silently: a profile fixed in one copy leaves the other consumers confined by an older rule set, which is a security regression rather than a cosmetic one.
3. **Private `sandbox-core` consumed by all three** — chosen. Matches the implemented `ssh-core` precedent, keeps publishable surfaces independent, and gives the platform backends a single place to be proven against a real kernel.

## Consequences

- Extraction is behavior-preserving. `pi-better-subagents` keeps its tool parameters, default-on/explicit/opt-out policy, and process lifecycle, and reaches the shared mechanism through a thin adapter (`packages/pi-better-subagents/sandbox.ts`) that maps its single-writable-directory shape onto the shared policy.
- The shared interface is target-neutral: `execPath`/`execArgs` wrap any executable, not just the pi binary. The subagent-flavored `piBin`/`piArgs` naming stays only inside the adapter.
- `sandbox-core` day one includes write-deny compilation and an in-process containment check (`compileWritePolicy`/`evaluateWriteAccess`) that the subagent consumer does not use. Those exist because the foreground `write`/`edit` overrides never spawn a child, so argv wrapping cannot confine them; they need the same canonicalization and containment rule the kernel backends apply.
- Distribution follows the private workspace convention (`private: true`, short name, `scripts/sync-shared-sandbox-core.mjs` run from each consumer's `pretest`/`prepack`) rather than becoming a published dependency. The vendored copy is a single root-level file per consumer because `pi-better-subagents` packs `*.ts` from its package root.
- The Linux backend's deny paths are layered as `--ro-bind-try` after the writable bind. A denied path that does not exist yet is therefore not held out by bwrap; callers that can create it in process must also apply `evaluateWriteAccess`. The macOS backend has no such gap: SBPL deny rules match by path, not by inode.
- `packages/pi-better-subagents/docs/adr/0001-linux-sandbox-bubblewrap.md` still governs the Linux backend's choice of Bubblewrap and its failure matrix. This ADR moves the code, not those decisions.
