# Harness-owned run timing

## Status

Accepted, 2026-09-27.

## Problem

An orchestrator's 30-minute attempt limit was written into its prompt and enforced by nothing. In fmm session `01a0e22e`, run `sa_mujphiql_10`, the parent noticed only at 38 minutes, stopped the child in the middle of a 20-minute backend test run, and respawned the same brief in the same workspace, discarding in-flight work. The child was progressing (32 edits, 667/667 frontend tests), not stuck. Since #315 a child's own tool errors no longer wake the parent, so nothing woke it at a deadline either.

## Decision

The subagent harness, not skills or prompts, owns timeouts and stuck detection. Every run gets a durable timing record in its metadata at launch:

- **Soft deadline** (default 30 min): one steering message into the child session through Pi's steer queue (stop starting new work, commit what is done, report) and one parent wake. After **grace** (default 5 min) an unfinished run is stopped and reported through the ordinary completion callback with reason `deadline`.
- **Hard ceiling** (default 90 min): stopped at once, without grace, reason `ceiling`.
- **Stuck wake** (default 10 min without progress): one parent wake per stuck spell, reason `stuck`; never a stop. Progress is any successful tool call that is not an exact repeat of an earlier call in the run (same tool name and arguments, null and absent optional fields treated alike as in #336); edits, writes, `git commit`, and a success after a failure always count. Time inside a running tool call does not count. Seen calls are remembered as fixed-size hashes, at most 4096 per run, oldest forgotten first. The existing "same operation failed three times" incident remains the other stuck signal.

Spawn parameters override the defaults; environment and `config.json` set them globally. The steer reaches the child through a request file in the run directory and a small harness extension loaded into every child that registers no tools and runs no commands. The parent evaluates timing on its supervision tick and records each one-shot event (steer, wake, stop reason) in run metadata, so `/reload` neither loses the deadline nor repeats a wake.

## Consequences

- A slow child that is still working is steered to wrap up and given grace, instead of being killed mid-command by a parent that guessed.
- The stop reason is a lifecycle fact shown on list, output, result, and callbacks; it is not a failure observation (ADR 0006 keeps lifecycle and observations separate).
- Read-only work (review, research) counts as progress while its calls are new; a child that loops on the same call does not. An earlier draft counted only edits, writes, and commits, which would have flagged every long review; this was rejected.
- A command that hangs forever does not count as stuck (it is waiting); the deadline and ceiling bound it.
- Runs launched before this change have no timing record and are not timed.
