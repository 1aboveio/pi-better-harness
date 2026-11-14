// Generated from packages/pi-better-subagents/thinking.ts. Do not edit directly.
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const VALID_THINKING_LEVELS = new Set(THINKING_LEVELS);
export function assertThinkingLevel(value, label = "thinking") {
    if (value === undefined || VALID_THINKING_LEVELS.has(String(value)))
        return;
    throw new Error(`${label} must be one of: ${THINKING_LEVELS.join(", ")}; got ${JSON.stringify(value)}.`);
}
/** Resolve the convenient `model@effort` shorthand used by subagent callers. */
export function parseModelThinking(model, thinking) {
    if (!model)
        return { model, thinking };
    const separator = model.lastIndexOf("@");
    if (separator <= 0 || separator === model.length - 1)
        return { model, thinking };
    const suffix = model.slice(separator + 1);
    assertThinkingLevel(suffix, "model thinking suffix");
    return {
        model: model.slice(0, separator),
        thinking: thinking ?? suffix,
    };
}
