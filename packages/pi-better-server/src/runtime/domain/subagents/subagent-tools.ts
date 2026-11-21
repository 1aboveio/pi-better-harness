/** Bind selected tools to their confined adapter or canonical provider before startup (ADR 0027). */
import { supportedChildEntrypoint } from "./config.ts";
import { canonicalizePath } from "./shared-sandbox-core.ts";
import { isNetworkTool, packageLabel, discoverTrustedTools, RESERVED_TOOL_NAMES, type SubagentToolSettings, type ToolSource } from "./shared-task-tools.ts";
import type { TaskExtensionTool } from "./task-policy.ts";

export const APPLY_PATCH = "apply_patch";

export interface TaskToolPlan {
    /** apply_patch is a task builtin for this run. */
    applyPatch: boolean;
    /** Trusted tools the child admits, with the package root recorded in the child policy. */
    trusted: (TaskExtensionTool & { loadPath: string })[];
    /** Requested tools that will not exist in the child, with the reason. */
    refused: { name: string; reason: string }[];
}

function specList(value: unknown): string[] {
    if (typeof value === "string") return value.trim() ? [value.trim()] : [];
    return Array.isArray(value) ? value.filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim()) : [];
}

export function planTaskTools(options: {
    requested: readonly string[];
    settings: SubagentToolSettings;
    network: boolean;
    processAccess?: "off" | "read";
    builtins: readonly string[];
    /** Tools registered in the parent Pi (`pi.getAllTools()`), used to resolve a legacy provider identity. */
    registered: readonly ToolSource[];
    toolExtensions?: Record<string, string | string[]> | null;
    resolvePath: (spec: string) => string | undefined;
}): TaskToolPlan {
    const plan: TaskToolPlan = { applyPatch: false, trusted: [], refused: [] };
    const registered = discoverTrustedTools(options.registered);
    for (const name of options.requested) {
        if (name === "process_list" && options.processAccess !== "read") {
            plan.refused.push({ name, reason: "Process access is Off; enable Read in /sandbox" });
            continue;
        }
        if (options.builtins.includes(name)) continue;
        if (name === APPLY_PATCH) {
            plan.applyPatch = true;
            continue;
        }
        if (RESERVED_TOOL_NAMES.includes(name)) {
            plan.refused.push({ name, reason: "no supported task adapter" });
            continue;
        }
        const network = isNetworkTool(name);
        if (network && !options.network) {
            plan.refused.push({ name, reason: "needs Network access, which is Off for subagents" });
            continue;
        }
        // The selected mapping identifies the implementation. Old saved entries can
        // still identify its package when the worker has no configured mapping.
        const mapped = specList(options.toolExtensions?.[name]);
        const packages = mapped.length ? mapped : options.settings.trusted.filter(tool => tool.name === name).map(tool => tool.package);
        let chosen: { package: string; loadPath: string } | undefined;
        for (const pkg of packages) {
            const owner = registered.find(tool => tool.name === name && tool.package === pkg);
            const path = mapped.length ? options.resolvePath(pkg) : owner?.root ?? (pkg.startsWith("npm:") ? options.resolvePath(pkg) : undefined);
            if (path) { chosen = { package: pkg, loadPath: path }; break; }
        }
        if (!chosen) {
            const reason = packages.length ? `provider ${packages.map(packageLabel).join(", ")} is unavailable` : "no provider selected for this worker";
            plan.refused.push({ name, reason });
            continue;
        }
        // A directory is admitted as a package root; a file admits only itself.
        let root: string;
        try {
            root = canonicalizePath(chosen.loadPath);
            if (!supportedChildEntrypoint(name, chosen.package, root)) {
                plan.refused.push({ name, reason: "provider requires a supported task adapter" });
                continue;
            }
        } catch {
            plan.refused.push({ name, reason: `its package path ${chosen.loadPath} can't be resolved` });
            continue;
        }
        plan.trusted.push({ name, package: chosen.package, root, network, loadPath: chosen.loadPath });
    }
    return plan;
}

/** One effective child tool list and what the plan refused, split by who asked for it. */
export interface EffectiveTaskToolSelection {
    /** The child tool list: refused names are absent, so policy, preflight and recipe agree. */
    tools: string[];
    /** Requested names the plan refuses, each with an actionable reason. */
    refused: { name: string; reason: string }[];
    /** Refused names this attempt requires (explicit request or frozen recipe): the launch must fail. */
    required: { name: string; reason: string }[];
    /** Refused names that only came from the default/inherited loadout: dropped with a warning. */
    dropped: { name: string; reason: string }[];
}

/**
 * The single effective tool selection every downstream authority reads (ADR 0009).
 *
 * A refused tool never reaches the task policy, the child preflight, the worker
 * bridge or the frozen launch recipe: the child cannot register it, so listing it
 * only makes the parent announce a tool the child then dies without (#669).
 *
 * Who asked matters. A name this attempt requires - an explicit `tools` request,
 * or a continuation's frozen loadout - stops the launch, because silently
 * narrowing it would change what the caller (or the saved conversation) asked
 * for. An inherited default is dropped from the child instead, with the reason.
 */
export function selectEffectiveTaskTools(options: {
    /** Candidate loadout after the confinement adjustments. */
    tools: readonly string[];
    plan: TaskToolPlan;
    /** Names this attempt requires; absent means the whole loadout is implicit. */
    required?: ReadonlySet<string>;
}): EffectiveTaskToolSelection {
    const refused = options.plan.refused.filter((tool) => options.tools.includes(tool.name));
    const refusedNames = new Set(refused.map((tool) => tool.name));
    const required = refused.filter((tool) => options.required?.has(tool.name) === true);
    const requiredNames = new Set(required.map((tool) => tool.name));
    return {
        tools: options.tools.filter((name) => !refusedNames.has(name)),
        refused,
        required,
        dropped: refused.filter((tool) => !requiredNames.has(tool.name)),
    };
}

/** "apply_patch (guarded) · web_fetch, web_search (trusted)" for the launch Runtime line. */
export function describeTaskTools(plan: TaskToolPlan): string | undefined {
    const parts = [
        ...(plan.applyPatch ? [`guarded ${APPLY_PATCH}`] : []),
        ...(plan.trusted.length ? [`trusted ${plan.trusted.map((tool) => `${tool.name} (${packageLabel(tool.package)})`).join(", ")}`] : []),
    ];
    return parts.length ? parts.join(" · ") : undefined;
}
