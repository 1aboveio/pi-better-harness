# Unified execution concurrency

## Status

Accepted. The user approved a shared Harness execution policy separate from
subagent delegation. Package-owned defaults and delegation settings retain
[ADR 0014](0014-global-harness-defaults.md)'s storage and ownership.

## Decision

Use `packages/pi-better-harness/extensions/execution-policy.ts` as the canonical policy module. Vendor
it into Subagents, Background Tasks, and Plan through the existing
`scripts/sync-shared-log-utils.mjs` script so standalone packages need no installed
Harness bundle. Each package registers the policy for `before_agent_start`; an
idempotent append injects it once per prompt regardless of which packages are
loaded or their registration order. Keep delegation guidance separate.

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

Verify single policy injection with each package alone, combined packages in
different registration orders, repeated registration, and successive prompts.
Check behavior through the vendored modules as well as the canonical module. Verify guidance covers
independent host migrations, resource and dependency constraints, manual-mode
foreground/background concurrency, unresolved availability tradeoffs, host-local
failure isolation, and terminal-result inspection without changing delegation,
safety, authorization, or workflow prerequisites.

Run `node scripts/execution-policy.eval.mjs --model <provider/model>` for a live
model decision check with simulated background operations. It checks four-host
launch coverage before polling, host-local failure isolation, and asking about
unresolved fleet availability. It launches no real migration commands and is not
a deterministic unit test or a guarantee that every model follows the policy.
