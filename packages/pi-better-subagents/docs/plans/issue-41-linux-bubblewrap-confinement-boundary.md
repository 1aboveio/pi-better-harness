# Issue #41: Linux bubblewrap confinement boundary

- [in-progress] AC1-3, 6-9, 14: real Linux product-builder child proves allowed writes, denied outside and `~/.pi` writes, outside reads, `/tmp`, `/dev/null`, and shared host-local HTTP; `tests/linux_bubblewrap.integration.mjs`. Awaiting required Ubuntu queue execution.
- [in-progress] AC4-5: real Linux product-builder child proves symlink write-through denial and canonicalizes a symlinked workdir alias; `tests/linux_bubblewrap.integration.mjs`. Awaiting required Ubuntu queue execution.
- [in-progress] AC10-12: hard-fail missing bwrap in the Linux lane and report exercised platform backend while preserving macOS assertions; `tests/linux_bubblewrap.integration.mjs`, existing `tests/sandbox_profile.test.mjs`, and queue documentation. Local macOS characterization passed; Ubuntu execution pending.
- [done] AC13: document the bubblewrap dependency, representative installation commands, and read-only Linux `~/.pi`; `README.md` and `tests/README.md`.
- [done] Closeout: local suite/checks, no-surface classifier/oracle, lint and review screens, high-risk self-review, commit, push, and draft PR Review Contract completed. Required real-bwrap Ubuntu CI proof remains pending.
