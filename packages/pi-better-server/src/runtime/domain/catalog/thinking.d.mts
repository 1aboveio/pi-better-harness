export declare const THINKING_LEVELS: readonly ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export type ThinkingLevel = typeof THINKING_LEVELS[number];
export declare function assertThinkingLevel(value: unknown, label?: string): asserts value is ThinkingLevel | undefined;
/** Resolve the convenient `model@effort` shorthand used by subagent callers. */
export declare function parseModelThinking(model: string | undefined, thinking?: ThinkingLevel): {
    model: string | undefined;
    thinking: ThinkingLevel | undefined;
};
