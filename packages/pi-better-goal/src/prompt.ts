/**
 * Goal-owned system-prompt guidance.
 *
 * Published as a named section, never as a returned `systemPrompt`. Returning text
 * sets `forceSystemPrompt`, and a forced prompt is opaque: `buildSystemPromptState`
 * yields `{ content }` with no sections while pi keeps diffing the sections that
 * the request therefore no longer carries. The request carries a rendered
 * snapshot, so goal text published after that snapshot is silently absent.
 */
export const GOAL_SECTION = "goal";

/** `sections` is optional because the repo typechecks against older pi typings. */
export interface PromptSectionTarget {
  sections?: Record<string, string>;
}

/**
 * Append guidance to the goal section, preserving anything already published there.
 *
 * Appending is safe across turns because pi normalizes a fresh options object for
 * every `before_agent_start`, so this never accumulates between requests; within a
 * single turn the parts belong together and keep their order.
 */
export function publishGoalGuidance<T extends object>(options: T, ...parts: Array<string | undefined | false>): T {
  const text = parts.filter((part): part is string => typeof part === "string" && part.trim().length > 0).join("\n\n");
  if (!text) return options;
  const target = options as PromptSectionTarget;
  const sections = (target.sections ??= {});
  const existing = sections[GOAL_SECTION];
  sections[GOAL_SECTION] = existing ? `${existing}\n\n${text}` : text;
  return options;
}
