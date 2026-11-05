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
  handlers: { get(event: string): ((event: unknown, ctx: unknown) => unknown) | undefined },
  ctx: unknown,
  base = "base",
): Promise<{ systemPrompt: string; sections: Record<string, string> }> {
  const options: { sections: Record<string, string> } = { sections: {} };
  await handlers.get("before_agent_start")?.({ systemPromptOptions: options, systemPrompt: base }, ctx);
  const rendered = Object.values(options.sections).filter((value) => value);
  return {
    systemPrompt: rendered.length > 0 ? `${base}\n\n${rendered.join("\n\n")}` : base,
    sections: options.sections,
  };
}
