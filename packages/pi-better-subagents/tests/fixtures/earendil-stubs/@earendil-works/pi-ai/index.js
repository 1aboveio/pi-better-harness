/** Minimal TypeBox-shaped stub for loading index.ts in tests without the host pi install. */
function schema(kind, def = {}) {
    return { ...def, [Symbol.for('pi-ai.kind')]: kind };
}
export const Type = {
    Object: (properties, options = {}) => schema('object', { properties, ...options }),
    String: (options = {}) => schema('string', options),
    Boolean: (options = {}) => schema('boolean', options),
    Number: (options = {}) => schema('number', options),
    Optional: (inner) => schema('optional', { inner }),
    Array: (inner, options = {}) => schema('array', { items: inner, ...options }),
    // Role selectors are Type.Union([string, string[]]). Registration only declares the schema.
    Union: (variants, options = {}) => schema('union', { anyOf: variants, ...options }),
};
export function getSupportedThinkingLevels(model) {
    if (!model || model.reasoning === false) return ['off'];
    const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    if (!model.thinkingLevelMap) return levels;
    return levels.filter((level) => model.thinkingLevelMap[level] !== null);
}
