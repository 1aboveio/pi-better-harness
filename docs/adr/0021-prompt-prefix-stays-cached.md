# Prompt text keeps its cached prefix

## Status

Accepted invariant. The user approved recording this after a cache investigation
on a metered gateway. This ADR extends [ADR 0016](0016-unified-execution-concurrency.md)'s
section-only rule with the caching consequence; it does not change tools,
permissions or settings ownership.

## Decision

Provider cache hit rate depends on the leading prompt bytes never changing.
Within one conversation:

1. **Prompt content is append-only.** New guidance arrives after the content
   already sent, never as a message rebuilt for the request.
2. **No request-local prompt blocks.** A block created per request is written to
   the provider cache once and never read back, and it invalidates everything the
   previous request cached after that point.
3. **No volatile state in the prompt.** Occupancy counters, live counts, elapsed
   time and progress rows belong in tools (`subagent_settings`,
   `bg_task_status`), not in prompt text.
4. **Package guidance is a named section.** Delivery through `before_agent_start`
   `sections` is the only mechanism; returning `systemPrompt` sets
   `forceSystemPrompt` and replaces the whole prefix, as ADR 0016 requires.
5. **A mid-session settings change applies at the next agent start** and then
   stays fixed. That change costs one cold write, not one per request.

## Context and trade-off

Cache hit rate for sessions driven by this bundle moved as follows on a
production gateway (gpt-6.1-sol traffic, 7-day view):

| Date | Cache hit | Change |
|---|---|---|
| 2026-10-10 .. 10-16 | ~93% | baseline |
| 2026-10-17 | ~72% | Subagents 0.19.0 (2026-10-16): "Refresh one temporary settings context block before every model request" |
| 2026-10-30 .. 11-03 | 42–58% | the same block carried live occupancy counters, which change as children come and go |
| 2026-11-04 | 80% | Subagents 0.27.1 moved the policy into the system prompt and stopped printing occupancy |
| 2026-11-05 | 95% | Subagents 0.27.2, Background Tasks 0.14.2 and Goal 0.12.1 published named sections instead of returning a whole prompt |
| 2026-11-06 .. 11-08 | 90–95% | stable |

The mechanism is recorded in the 0.27.1 entry: the settings message "was
request-local, so Pi never persisted it: it was written to the prompt cache once
per request and never read back".

Two controls rule out the obvious alternatives:

- The official Codex CLI on the same gateway, accounts and days held **99%** at a
  *larger* average context (275,840 vs 190,854 tokens). Context size, account
  routing and model are therefore not the cause.
- Inside one pi conversation the cache-read counter froze at a fixed value for
  dozens of consecutive turns while input kept growing, all on one account; and
  cache hit is flat across requests-per-account-per-30-minutes
  (57% / 64% / 52% / 52% / 55%). Concurrency and failover are not the cause.

The cost is not cosmetic: with 120k–480k-token sessions, about 89% of turns
re-sent the uncached body.

## Consequences

Guidance that genuinely must change mid-run stays out of the prompt: expose it
as a tool, or accept one cold write at the change and none afterwards. Display
state (badges, footer, navigator) never enters the prompt; that is also why
[ADR 0020](0020-observed-waits-retain-an-owner.md) keeps observation state with
the owner rather than in text.

A package that adds a prompt publisher must also reject a whole-prompt return in
its tests. Goal already does this in
`packages/pi-better-goal/test/before-agent-start.ts`, which throws when a handler
returns `systemPrompt`; Subagents publishes the `subagents` section and Harness
publishes `harness_execution_policy`, so no package can erase another.

## Verification

- `packages/pi-better-goal/test/before-agent-start.ts` fails a handler that
  returns a whole prompt.
- `packages/pi-better-subagents/tests/child_ownership.test.mjs` asserts the
  worker handoff is published as the `worker_handoff` section, that the handler
  returns nothing, and that the incoming prompt text is unchanged.
- Manual check against a gateway that reports cache reads: send five consecutive
  turns of one conversation and require the cache-read counter to grow with the
  input instead of staying constant while input grows.
