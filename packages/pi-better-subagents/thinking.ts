export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ThinkingLevel = typeof THINKING_LEVELS[number];

const VALID_THINKING_LEVELS = new Set<string>(THINKING_LEVELS);

export function assertThinkingLevel(value: unknown, label: string = "thinking"): asserts value is ThinkingLevel | undefined {
    if (value === undefined || VALID_THINKING_LEVELS.has(String(value))) return;
    throw new Error(`${label} must be one of: ${THINKING_LEVELS.join(", ")}; got ${JSON.stringify(value)}.`);
}