// JSON Schema keywords that model providers have been OBSERVED to reject in
// tool/function parameter schemas. Verified entries only:
// - `uniqueItems`: OpenAI returned 400 invalid_function_parameters for the #315
//   intent bash schema, failing every confined child's first request (#327).
// Not rejected: `patternProperties` (typebox Type.Record). A live headless Pi run
// on openai/gpt-6-luna with the full harness loaded, including Type.Record
// schemas, succeeded; OpenAI rejects the whole request if any tool schema is
// invalid, so that run shows `patternProperties` is accepted.
// Add a keyword here only with an observed provider rejection, cited like above.
export const PROVIDER_REJECTED_KEYWORDS = Object.freeze([
    "uniqueItems",
]);

/** Paths (like `properties.expectedExitCodes.uniqueItems`) of rejected keywords anywhere in a schema. */
export function findProviderRejectedKeywords(schema, path = []) {
    if (schema === null || typeof schema !== "object") return [];
    const found = [];
    for (const [key, value] of Object.entries(schema)) {
        // Property names under `properties` are data, not keywords.
        const isPropertyMap = path[path.length - 1] === "properties";
        if (!isPropertyMap && PROVIDER_REJECTED_KEYWORDS.includes(key)) found.push([...path, key].join("."));
        found.push(...findProviderRejectedKeywords(value, [...path, key]));
    }
    return found;
}
