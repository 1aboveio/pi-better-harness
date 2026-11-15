export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = typeof THINKING_LEVELS[number];

const VALID_THINKING_LEVELS = new Set<string>(THINKING_LEVELS);

export function assertThinkingLevel(value: unknown, label: string = "thinking"): asserts value is ThinkingLevel | undefined {
    if (value === undefined || VALID_THINKING_LEVELS.has(String(value))) return;
    throw new Error(`${label} must be one of: ${THINKING_LEVELS.join(", ")}; got ${JSON.stringify(value)}.`);
}

/** Resolve the convenient `model@effort` shorthand used by subagent callers. */
export function parseModelThinking(
    model: string | undefined,
    thinking?: ThinkingLevel,
): { model: string | undefined; thinking: ThinkingLevel | undefined } {
    if (!model) return { model, thinking };

    const separator = model.lastIndexOf("@");
    if (separator <= 0 || separator === model.length - 1) return { model, thinking };

    const suffix = model.slice(separator + 1);
    assertThinkingLevel(suffix, "model thinking suffix");
    return {
        model: model.slice(0, separator),
        thinking: thinking ?? suffix,
    };
}