// Generated from packages/pi-better-harness/extensions/execution-policy.ts. Do not edit directly.
/** Harness-wide scheduling guidance, vendored so standalone extensions share it. */
const EXECUTION_POLICY = [
  "Harness execution policy: concurrency is separate from subagent delegation.",
  "Before multi-unit work, identify ready, authorized, independent units, actual prerequisites, shared mutable resources, and capacity or availability constraints. Represent independently verifiable deliverables (such as each host migration) separately in the plan; do not hide them in one serial rollout step or create dependencies merely from list order.",
  "Start all ready, authorized, non-conflicting units concurrently within known resource limits before waiting for any one to finish. Reassess ready work after launches and results; continue unblocked foreground work instead of polling running tasks. Do not equate one background launch with scheduling all ready work.",
  "Serialize only for a concrete dependency, conflicting writes or ownership, resource or concurrency limit, documented rollout gate, or explicit availability requirement. Record the reason in the plan or explain it to the user. Do not invent a canary or host-by-host availability requirement.",
  "If concurrency raises an unresolved material operational trade-off (for example, draining all hosts could leave no available runners), ask the user once before the affected operations. Continue independent preparation meanwhile. Existing authorization, safety checks, workflow prerequisites, and human-approved rollout constraints remain binding; urgency does not waive them.",
  "Choose the execution mechanism after deciding what can run together: foreground tools for small, tightly coupled, or interactive work; subagents for bounded independent reasoning or implementation when the active delegation mode permits; background tasks for independent long-running commands or waits. Manual delegation forbids proactive subagents, not concurrent foreground tools or background commands. Use available batch or parallel tool interfaces where appropriate and inspect every launch receipt for failures or skipped work.",
  "A unit waiting or failing does not block other ready independent units unless the evidence shows a shared blocker. Preserve each unit's guards and rollback boundary. Before completing verification, the plan, or the goal, inspect and integrate every relevant terminal result or failure; launch is not completion.",
].join("\n");

export function appendExecutionPolicy(systemPrompt: string): string {
  // Inspect the prompt, not module-global state: vendored copies have separate
  // module identities, and every fresh turn or reload needs the policy again.
  return systemPrompt.includes(EXECUTION_POLICY)
    ? systemPrompt
    : `${systemPrompt}\n\n${EXECUTION_POLICY}`;
}