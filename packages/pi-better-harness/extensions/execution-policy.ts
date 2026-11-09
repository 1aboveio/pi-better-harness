/**
 * Harness-wide scheduling guidance, vendored so standalone extensions share it.
 *
 * Published as a named system-prompt section, never as appended text. A
 * `before_agent_start` handler that returns `systemPrompt` sets
 * `forceSystemPrompt`, and a forced prompt is opaque to pi: `buildSystemPromptState`
 * returns `{ content }` with no sections while `diffSystemPromptSections` keeps
 * diffing the sections the request therefore never shows. The request carries a
 * rendered snapshot, so any section published after that snapshot never reaches
 * it, so every package that speaks here publishes a section.
 */
export const EXECUTION_POLICY_SECTION = "harness_execution_policy";

/**
 * The minimum shape this module needs. `sections` stays optional because this
 * repo typechecks against older pi typings whose event options predate sections;
 * the shipped runtime always supplies the map.
 */
export interface PromptSectionTarget {
  sections?: Record<string, string>;
}

export const EXECUTION_POLICY_TEXT: string = [
  "Harness execution policy: concurrency is separate from subagent delegation.",
  "Before multi-unit work, identify ready, authorized, independent units, actual prerequisites, shared mutable resources, and capacity or availability constraints. Represent each independently verifiable deliverable as its own plan step; do not create dependencies from list order.",
  "Start all ready, authorized, non-conflicting units concurrently within known resource limits before waiting for any one to finish. Reassess ready work after launches and results; continue unblocked foreground work instead of polling running tasks. Do not equate one background launch with scheduling all ready work.",
  "Serialize only for a concrete dependency, conflicting writes or ownership, resource or concurrency limit, documented rollout gate, or explicit availability requirement. Record the reason in the plan or explain it to the user. Do not invent a canary or host-by-host availability requirement.",
  "If concurrency raises an unresolved material operational trade-off, ask the user once before the affected operations and continue independent preparation meanwhile. Existing authorization, safety checks, workflow prerequisites, and human-approved rollout constraints remain binding; urgency does not waive them.",
  "Choose the execution mechanism after deciding what can run together: foreground tools for small, tightly coupled, or interactive work; subagents for bounded independent reasoning or implementation when the active delegation mode permits; background tasks for independent long-running commands or waits. Manual delegation forbids proactive subagents, not concurrent foreground tools or background commands. Inspect every launch receipt for failures or skipped work.",
  "Established command-only jobs and external waits belong to background operations, including in coordinator mode. Use bg_task_spawn for a long command, bg_task_watch for a repeated check, and watch_delivery for supported merge delivery. A subagent assignment must require reasoning or implementation beyond launching and waiting. Workers retain their assigned validation: launch or watch, continue independent work, then park with wait_for_operations and inspect the terminal evidence on continuation. Continue independent work while it runs; a task launch is not completion of the assignment.",
  "If a worker hands back a command, launch it through bg_task_spawn or bg_task_watch with the supplied cwd, and inspect its terminal result before claiming verification.",
  "A unit waiting or failing does not block other ready independent units unless the evidence shows a shared blocker. Preserve each unit's guards and rollback boundary. Before completing verification, the plan, or the goal, inspect and integrate every relevant terminal result or failure; launch is not completion.",
].join("\n");

/**
 * True when this pi runtime renders custom prompt sections.
 *
 * pi gained `systemPromptOptions.sections` after 0.84.4, and the packages here
 * declare support back to 0.84.4. A section-only publisher is a silent no-op on
 * an older host: the handler runs, the map is populated, and the prompt the model
 * receives is unchanged. Callers must fall back to appending text instead.
 */
export function supportsPromptSections(options: unknown): boolean {
  const sections = (options as { sections?: unknown } | undefined)?.sections;
  return typeof sections === "object" && sections !== null;
}

/**
 * Publish the policy into `options.sections`.
 *
 * Assignment, not concatenation: two packages publishing the same section write
 * identical text, so load order cannot duplicate or drop it, and a repeated turn
 * rewrites the same value so pi's section diff reports no change.
 */
export function publishExecutionPolicy<T extends object>(options: T): T {
  const target = options as PromptSectionTarget;
  const sections = (target.sections ??= {});
  sections[EXECUTION_POLICY_SECTION] = EXECUTION_POLICY_TEXT;
  return options;
}
