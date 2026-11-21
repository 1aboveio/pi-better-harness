# Harness-owned run timing

## Status

Accepted, 2026-09-27. The September revision made elapsed-time limits opt-in.
On 2026-11-11 the built-in hard timeout changed to 60 minutes. The soft
deadline remains opt-in. [Timeout setting and default](https://github.com/1aboveio/pi-better-harness/commit/e1bc2f02f4edcc52998301fe9a9873c6b5a9d91c)

## Problem

An orchestrator's 30-minute attempt limit was written into its prompt and enforced by nothing. In fmm session `01a0e22e`, run `sa_mujphiql_10`, the parent noticed only at 38 minutes, stopped the child in the middle of a 20-minute backend test run, and respawned the same brief in the same workspace, discarding in-flight work. The child was progressing (32 edits, 667/667 frontend tests), not stuck. Since #315 a child's own tool errors no longer wake the parent, so nothing woke it at a deadline either.

## Decision

The subagent harness, not skills or prompts, owns timeouts and stuck detection. Every run gets a durable timing record in its metadata at launch:

- **Soft deadline** (default off): when configured, one steering message enters the child session through Pi's steer queue (stop starting new work, commit what is done, report) and the parent gets one wake. Pi delivers a steer only after the current tool call, so **grace** (default 5 min) starts when the steer enters the child's conversation, recorded by a receipt the child's harness extension writes; while it waits behind a running tool call, the deadline stop is held. An unfinished run is then stopped and reported through the ordinary completion callback with reason `deadline`. Counting grace from the request would have killed a test run started just before the deadline, which is the incident above.
- **Hard ceiling.** The built-in `max_minutes` is 60. Once the run reaches its ceiling, the supervisor stops it with reason `ceiling`, even if the child is making progress or waiting on a tool. The ceiling takes precedence over soft-deadline grace and also applies to supervised orphaned runs. Set `max_minutes: 0` to disable this stop for a launch.
- **Tool-wait wake** (default 5 min): one factual parent wake for each tool call that stays open that long. A normal long test alerts too; the alert is not a failure verdict. Parallel calls alert independently, and a durable once-per-call marker prevents a reload, event replay, or later supervision tick from repeating the same alert. A failed handoff leaves the marker unset, so the existing urgent-callback retry path sends it again. The alert never cancels a tool, stops or restarts the run, or changes an explicitly configured deadline or ceiling.
- **Stuck wake** (default 10 min without progress): one parent wake per stuck spell, reason `stuck`; never a stop. Progress is any successful tool call that is not an exact repeat of an earlier call in the run (same tool name and arguments, null and absent optional fields treated alike as in #336); file-mutating tools (edit, write, multi_edit, apply_patch, str_replace, and the like), `git commit`, and a success after a failure always count. Time inside a running tool call does not count. Seen calls are remembered as fixed-size hashes, at most 4096 per run, oldest forgotten first. The existing "same operation failed three times" incident remains the other stuck signal.

A spawn parameter overrides the defaults. For the hard ceiling, the session timeout from `/subagents settings` takes precedence over the environment, saved settings and the built-in default. The settings page offers a duration or **No limit** in **Run timeout** and accepts `No limit` as input. This choice maps to the existing numeric value `0` in saved settings. The same screen lets the user adjust the tool-wait and no-progress alerts and save defaults with Ctrl+S. A change applies to new attempts. Automatic resume carries forward the remaining time or the explicitly disabled ceiling.

The steer reaches the child through a request file in the run directory and a small harness extension loaded into every child that registers no tools and runs no commands. The supervisor records each one-shot event (steer, wake per call/spell, stop reason) in run metadata, so `/reload` neither loses the deadline nor repeats a wake. Tool-wait and stuck alerts report facts (run identity, category, duration, current operation, available evidence and last progress) without prescribing whether the parent should inspect, continue, stop, or retry.

The timing policy uses elapsed time and observed tool activity. Model turn count does not trigger a wrap-up, stop or completion decision.

The acceptance case for #621 stops a child during verification after it has recorded work. The parent must be able to retrieve the stop reason, partial work and last known verification state through the common delivery contract, even if the child never sends a final message. [Issue #621](https://github.com/1aboveio/pi-better-harness/issues/621) · [Subagent lifecycle](0007-subagent-lifecycle.md#result-and-delivery)

## Consequences

- For a long build or verification run, the caller can raise the ceiling or disable it at launch. If the caller also wants a partial report before the ceiling, it can set an earlier soft deadline with enough time for the child to report.
- The stop reason is a lifecycle fact shown on list, output, result, and callbacks. Failure observations have their own record. [Shared failure observations](../../../../docs/adr/0006-shared-failure-observations.md)
- Read-only work (review, research) counts as progress while its calls are new; a child that loops on the same call does not. An earlier draft counted only edits, writes, and commits, which would have flagged every long review; this was rejected.
- A command that hangs keeps its tool call open. The tool-wait alert reports that fact. With the ceiling disabled, a soft-deadline steer queued behind that call can remain pending indefinitely.
- Runs launched before this change have no timing record and are not timed.
- Timing requires a live supervisor for the run. Closing the foreground session allows managed children to keep running under the shared runtime.
- A batch job's `null` timing value inherits the `shared` value, then the default, like its other options.
