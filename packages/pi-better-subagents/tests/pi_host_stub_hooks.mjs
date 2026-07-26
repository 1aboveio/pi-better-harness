/**
 * Module resolve hook for extension-level tests: redirect pi host-provided
 * packages (present at runtime inside pi, NOT installed in this repo) to local
 * stubs. This stubs EXTERNAL package boundaries only; no first-party module is
 * intercepted. Registered by extension-level tests via `module.register()`.
 *
 * Covers:
 * - `@earendil-works/pi-ai` (Type schema builder)
 * - `@earendil-works/pi-coding-agent` (CustomEditor — used by navigator #45+)
 * - `@earendil-works/pi-tui` (Key / matchesKey / truncateToWidth — navigator)
 */
export async function resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-ai") {
        return { url: new URL("./pi_host_package_stub.mjs", import.meta.url).href, shortCircuit: true };
    }
    if (specifier === "@earendil-works/pi-coding-agent") {
        return { url: new URL("./pi_coding_agent_stub.mjs", import.meta.url).href, shortCircuit: true };
    }
    if (specifier === "@earendil-works/pi-tui") {
        return { url: new URL("./pi_tui_stub.mjs", import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
