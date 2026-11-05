/**
 * Invoke a `before_agent_start` handler the way pi's extension runner does.
 *
 * The runner normalizes one options object per turn and lets handlers mutate
 * `sections` in place; the rendered prompt is the base plus those sections.
 * Reading `.systemPrompt` off the handler's return therefore asserts a contract
 * pi does not have, and would pass even if the handler published nothing.
 *
 * Sections render in publication order, which is why goal guidance lands exactly
 * where the old appended string did.
 */
export async function invokeBeforeAgentStart(
  handlers: { get(event: string): ((...args: any[]) => unknown) | undefined },
  ctx: unknown,
  base = "base",
): Promise<{ systemPrompt: string; sections: Record<string, string> }> {
  const options: { sections: Record<string, string> } = { sections: {} };
  const returned = await handlers.get("before_agent_start")?.({ systemPromptOptions: options, systemPrompt: base }, ctx) as
    | { systemPrompt?: string }
    | undefined;
  // pi sets forceSystemPrompt whenever a handler returns `systemPrompt`, and the
  // request then carries that rendered snapshot instead of the sections. A caller
  // that renders sections while ignoring the return value would show a passing
  // test for a prompt the model never sees, so fail loudly instead.
  if (returned && returned.systemPrompt !== undefined) {
    throw new Error(`before_agent_start returned a whole prompt; forceSystemPrompt would hide every published section: ${returned.systemPrompt.slice(0, 120)}`);
  }
  const rendered = Object.values(options.sections).filter((value) => value);
  return {
    systemPrompt: rendered.length > 0 ? `${base}\n\n${rendered.join("\n\n")}` : base,
    sections: options.sections,
  };
}
