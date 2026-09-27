// JSON Schema keywords that model providers reject in tool/function parameter schemas.
// OpenAI returns 400 invalid_function_parameters for these (observed: `uniqueItems` in
// the #315 intent bash schema failed every confined child's first request).
export const PROVIDER_REJECTED_KEYWORDS = Object.freeze([
    "uniqueItems", "patternProperties", "unevaluatedProperties", "unevaluatedItems", "propertyNames",
    "dependentRequired", "dependentSchemas", "contains", "minContains", "maxContains", "if", "then", "else", "not",
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
