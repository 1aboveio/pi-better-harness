/**
 * Goal-owned system-prompt guidance.
 *
 * Published as a named section on hosts that render sections, never as a returned
 * `systemPrompt` there: returning text sets `forceSystemPrompt`, and the request
 * then carries an opaque rendered snapshot, so a section published afterwards
 * never reaches the model.
 *
 * On older hosts (this package declares support back to pi 0.84.4) custom sections
 * do not render at all, so the same text is appended instead. Publishing alone
 * would silently deliver nothing on those versions.
 */
export const GOAL_SECTION = "goal";

/** The minimum shape this module needs; both the event options and a test double satisfy it. */
export interface PromptSectionTarget {
  sections?: Record<string, string>;
}

/** What a handler receives; only these two fields are used. */
export interface BeforeAgentStartEvent {
  systemPrompt: string;
  systemPromptOptions?: unknown;
}

/** Mirrors `supportsPromptSections` in the vendored execution policy. */
function rendersSections(options: unknown): boolean {
  const sections = (options as { sections?: unknown } | undefined)?.sections;
  return typeof sections === "object" && sections !== null;
}

/**
 * Deliver guidance, choosing the channel this host understands.
 *
 * Appending within one turn is safe: pi normalizes a fresh options object for
 * every `before_agent_start`, so this never accumulates between requests, and
 * within a turn the parts belong together and keep their order.
 */
export function publishGoalGuidance(
  event: BeforeAgentStartEvent,
  ...parts: Array<string | undefined | false>
): { systemPrompt: string } | undefined {
  const text = parts.filter((part): part is string => typeof part === "string" && part.trim().length > 0).join("\n\n");
  if (!text) return undefined;
  if (!rendersSections(event.systemPromptOptions)) {
    return { systemPrompt: `${event.systemPrompt}\n\n${text}` };
  }
  const target = event.systemPromptOptions as PromptSectionTarget;
  const sections = (target.sections ??= {});
  const existing = sections[GOAL_SECTION];
  sections[GOAL_SECTION] = existing ? `${existing}\n\n${text}` : text;
  return undefined;
}
