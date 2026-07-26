/**
 * TypeScript re-export of extensions.mjs pure helpers.
 * Logic lives in extensions.mjs for ESM unit-test compatibility (mirrors widget.ts).
 */
export {
    BUILTIN_TOOLS,
    SELF_SPEC,
    providerOf,
    toolList,
    resolveExtensions,
    extensionArgs,
} from "./extensions.mjs";

export interface ExtensionResolution {
    mode: "isolated" | "clean" | "inherit";
    specs: string[];
    unmapped: string[];
    reasons: Record<string, string[]>;
}
