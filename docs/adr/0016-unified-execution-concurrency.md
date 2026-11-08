# Unified execution concurrency

## Status

Accepted. The user approved a shared Harness execution policy separate from
subagent delegation. Package-owned defaults and delegation settings retain
[ADR 0014](0014-global-harness-defaults.md)'s storage and ownership.

## Decision

Use `packages/pi-better-harness/extensions/execution-policy.ts` as the canonical policy module. Vendor
it into Subagents and Background Tasks through the existing
`scripts/sync-shared-log-utils.mjs` script so standalone packages need no installed
Harness bundle. Each package publishes the policy as the `harness_execution_policy`
system-prompt section. Assignment, not concatenation, keeps it to one copy per
prompt regardless of which packages are loaded or their registration order. Keep
delegation guidance separate, in its own section.

Publish sections rather than returning a whole prompt. A `before_agent_start`handler that returns `systemPrompt` sets `forceSystemPrompt`, and pi then renders
`{ content }` with no sections while still diffing the sections it never sends.
Mixing the two modes therefore sends a rendered snapshot, so a section published
after that snapshot never reaches the request. The ban removes the dependence on
load order rather than eliminating one particular ordering. Each package owns a distinct section
(`harness_execution_policy`, `subagents`, `worker_handoff`, `background_tasks`,
`goal`), so no publisher can erase another, and nothing appends to prompt text.
Background Tasks owns the wait guidance in that section: the check is cheap, the
wait is not, so an external or long wait becomes `bg_task_watch`,
`bg_task_spawn` plus `wait_for_operations`, or `watch_delivery` rather than a
foreground `sleep`. No package depends on an unversioned global append file for
this guidance.

Sections carry instructions only. No rationale, no worked examples, and no
defaults the tool schemas already state: the model already has every schema in
context, so restating `timeout_seconds` or a condition shape spends prefix
tokens on text it can read. Keep the imperative and the tool name; drop the
argument for why.

Identify ready, authorized independent units, including separate per-host
migrations, and start them concurrently within resource constraints before
waiting. Serialize only for real dependencies, shared writes, resource or
capacity limits, or explicit rollout or availability requirements. Record the
reason for serialization rather than treating a delegation mode as a concurrency
restriction.

Ask once about an unresolved material operational availability tradeoff while
independent preparation continues. A host-local failure does not block other
independent hosts unless there is evidence of a shared cause. Safety,
authorization, and workflow prerequisites remain unchanged; concurrency supplies
neither authorization nor permission to bypass them.

Use foreground tools for small, tightly coupled, or interactive work. Use
subagents only as permitted by the active manual, adaptive, or coordinator mode.
Manual forbids proactive subagents, not parallel foreground or background
execution; explicit user requests and active workflow requirements retain their
existing delegation exceptions. Use background tasks for independent long-running
commands or waits, and continue unblocked foreground work without polling workers.
No auto-launcher, scheduler, or reminder loops are introduced in this scope.

Plans track distinct deliverables and dependencies, not individual worker
processes. Distinct ready milestones may be `in_progress` concurrently only when
their work is actually underway; per-host deliverables are separate milestones.
Worker registries retain run status. Before completing verification, the plan,
or the active goal, ensure every relevant subagent and background task is
terminal and inspect and integrate its result or failure.

## Verification

[ADR 0021](0021-prompt-prefix-stays-cached.md) records the caching consequence of
this rule: no request-local prompt block and no volatile state in prompt text,
because only an unchanged leading prefix can be read back from the provider
cache.

Verify single policy injection with each package alone, combined packages in
different registration orders, repeated registration, and successive prompts.
Assert that no extension returns a whole prompt, since one such return makes every
published section invisible. Check behavior through the vendored modules as well as
the canonical module. Verify guidance covers
independent host migrations, resource and dependency constraints, manual-mode
foreground/background concurrency, unresolved availability tradeoffs, host-local
failure isolation, and terminal-result inspection without changing delegation,
safety, authorization, or workflow prerequisites.

Run `node scripts/execution-policy.eval.mjs --model <provider/model>` for a live
model decision check with simulated background operations. It checks four-host
launch coverage before polling, host-local failure isolation, and asking about
unresolved fleet availability. It launches no real migration commands and is not
a deterministic unit test or a guarantee that every model follows the policy.
