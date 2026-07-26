/**
 * Stub of the pi host-provided `@earendil-works/pi-ai` package for
 * extension-level tests. The extension uses `Type.*` only to DECLARE tool
 * parameter schemas; tests call `execute` directly, so the schemas are never
 * validated — shape-preserving placeholders are sufficient.
 */
const schema = (kind, extra) => ({ kind: `stub:${kind}`, ...extra });
export const Type = {
    Object: (props) => schema("object", { props }),
    String: (o) => schema("string", o),
    Number: (o) => schema("number", o),
    Boolean: (o) => schema("boolean", o),
    Array: (items, o) => schema("array", { items, ...o }),
    Optional: (s) => ({ ...s, optional: true }),
};
