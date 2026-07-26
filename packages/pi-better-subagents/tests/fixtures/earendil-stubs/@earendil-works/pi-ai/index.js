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
};
