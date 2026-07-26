/**
 * Headless extension resolution — decide which extension CODE loads in a child.
 *
 * Why this exists (issue #17): a subagent that loads every globally-installed
 * package inherits their startup side effects. `pi-patty-bg-tasks` replaces the
 * builtin `bash` with a `detached` + `unref()` spawn; in `pi -p` a parallel
 * `bash` + `read` batch then drains the Node event loop and the child EXITS 0
 * mid-turn — no `tool_execution_end`, no `agent_end`. Measured: 30 recorded runs,
 * 17 died this way and every one was reported as "completed".
 *
 * A tool allowlist CANNOT fix this. `--tools` restricts what the model may CALL;
 * the offending package has already overridden builtin `bash` at startup, so the
 * `bash` in your allowlist IS the broken one. Verified: extensions on + exactly
 * `read,bash,edit,write,web_search,web_fetch` still dies 2-start / 1-end.
 *
 * pi also has no "load everything except X" flag — only `--extension/-e <path>`
 * (add one) and `--no-extensions` (all off). So a package DENYLIST is not
 * expressible at the CLI at all. The only mechanism that excludes a package is
 * to stop loading everything and name what you want:
 *
 *     pi -p --no-extensions -e <needed> -e <needed>
 *
 * That is what this module computes. The needed set is DERIVED from the tool
 * allowlist the caller already passes, so least privilege falls out with no new
 * vocabulary for the model to get wrong, and every future lifetime-breaking
 * package is excluded by default rather than by name.
 *
 * Pure: no fs, no env. Path materialization lives in index.ts.
 */

/**
 * Tools pi provides with `--no-extensions`. Verified empirically:
 *   pi -p --no-extensions "list your tools" -> read, bash, edit, write
 * A builtin needs no extension, so it never counts as unmapped.
 */
export const BUILTIN_TOOLS = ["read", "bash", "edit", "write"];

/** Marker spec meaning "this extension's own package" (for allow_nested). */
export const SELF_SPEC = "self";

/** Split "xai/grok-4.5" -> "xai". Returns undefined when there is no provider. */
export function providerOf(model) {
    if (typeof model !== "string") return undefined;
    const i = model.indexOf("/");
    return i > 0 ? model.slice(0, i) : undefined;
}

/** Normalize a config value that may be a single spec or a list of them. */
function toSpecList(value) {
    if (typeof value === "string") return value.trim() ? [value.trim()] : [];
    if (Array.isArray(value)) return value.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim());
    return [];
}

/** Parse a comma/space separated tool allowlist into unique bare names. */
export function toolList(tools) {
    if (!tools) return [];
    const out = [];
    for (const raw of String(tools).split(",")) {
        const t = raw.trim();
        if (t && !out.includes(t)) out.push(t);
    }
    return out;
}

/**
 * Decide the child's extension set.
 *
 * @param {object} a
 * @param {string} [a.tools]        Tool allowlist (comma form) the child will get.
 * @param {string} [a.model]        Model as "provider/id" — pulls in provider auth.
 * @param {boolean} [a.clean]       Hermetic builtins-only child.
 * @param {boolean} [a.allowNested] Child may spawn its own subagents.
 * @param {object} [a.config]       Extension config (toolExtensions, providerExtensions, inheritExtensions).
 * @returns {{mode: "isolated"|"clean"|"inherit", specs: string[], unmapped: string[], reasons: Record<string,string[]>}}
 *   mode     — "isolated" passes --no-extensions + explicit -e (the default);
 *              "clean" passes --no-extensions with no -e;
 *              "inherit" passes neither (operator opt-out, NOT model-selectable).
 *   specs    — extension specs to load, deduped, in a stable order.
 *   unmapped — requested tools that are neither builtin nor mapped to an
 *              extension. They simply will not exist in the child; surfaced so
 *              the human sees it instead of the child silently lacking a tool.
 *   reasons  — spec -> what pulled it in, for the spawn diagnostic.
 */
export function resolveExtensions(a = {}) {
    const cfg = a.config ?? {};
    const specs = [];
    const reasons = {};
    const add = (spec, why) => {
        if (!spec) return;
        if (!specs.includes(spec)) specs.push(spec);
        (reasons[spec] ??= []).push(why);
    };

    // allow_nested is honored in every mode: it is an explicit caller request,
    // and without our own package loaded the child has no subagent tools at all.
    if (a.allowNested) add(SELF_SPEC, "allow_nested");

    if (cfg.inheritExtensions === true) {
        return { mode: "inherit", specs: [], unmapped: [], reasons: {} };
    }
    if (a.clean === true) {
        return { mode: "clean", specs, unmapped: [], reasons };
    }

    const toolMap = cfg.toolExtensions ?? {};
    const unmapped = [];
    for (const tool of toolList(a.tools)) {
        if (BUILTIN_TOOLS.includes(tool)) continue;
        const mapped = toSpecList(toolMap[tool]);
        if (mapped.length === 0) {
            if (!unmapped.includes(tool)) unmapped.push(tool);
            continue;
        }
        for (const spec of mapped) add(spec, `tool:${tool}`);
    }

    // Model auth is not tool-shaped: xai/grok needs pi-xai-oauth loaded or the
    // child cannot authenticate at all, whatever tools it was granted.
    const provider = providerOf(a.model);
    if (provider) {
        for (const spec of toSpecList((cfg.providerExtensions ?? {})[provider])) {
            add(spec, `provider:${provider}`);
        }
    }

    return { mode: "isolated", specs, unmapped, reasons };
}

/**
 * Build the pi CLI flags for a resolution. `resolvePath` maps a spec to an
 * on-disk path (or undefined when the package is not installed); unresolvable
 * specs are reported rather than silently dropped.
 *
 * @returns {{args: string[], missing: string[]}}
 */
export function extensionArgs(resolution, resolvePath) {
    if (resolution.mode === "inherit") return { args: [], missing: [] };
    const args = ["--no-extensions"];
    const missing = [];
    for (const spec of resolution.specs) {
        const path = resolvePath(spec);
        if (!path) { missing.push(spec); continue; }
        args.push("--extension", path);
    }
    return { args, missing };
}
