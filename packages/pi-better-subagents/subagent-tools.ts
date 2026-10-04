/**
 * Launch-time plan for a confined child's extension tools (ADR 0009).
 *
 * Guarded: apply_patch, a harness adapter on the guarded file operations.
 * Trusted: a tool ticked in /sandbox, admitted by name AND owning package, whose
 * package is loaded into the child. `toolExtensions` in config.json still picks
 * the package to load (an override), but the loaded package must be the ticked one.
 */
import { canonicalizePath } from "./shared-sandbox-core.ts";
import { isNetworkTool, packageLabel, toolPackage, type SubagentToolSettings, type ToolSource } from "./shared-task-tools.ts";
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
    /** Tools registered in the parent Pi (`pi.getAllTools()`), used to find a ticked tool's package. */
    registered: readonly ToolSource[];
    toolExtensions?: Record<string, string | string[]> | null;
    resolvePath: (spec: string) => string | undefined;
}): TaskToolPlan {
    const plan: TaskToolPlan = { applyPatch: false, trusted: [], refused: [] };
    for (const name of options.requested) {
        if (name === "process_list" && options.processAccess !== "read") {
            plan.refused.push({ name, reason: "Process access is Off; enable Read in /sandbox" });
            continue;
        }
        if (options.builtins.includes(name)) continue;
        if (name === APPLY_PATCH) {
            if (options.settings.applyPatch) plan.applyPatch = true;
            else plan.refused.push({ name, reason: "apply_patch is off in /sandbox (Subagents · Tools)" });
            continue;
        }
        const ticked = options.settings.trusted.filter((entry) => entry.name === name);
        if (!ticked.length) {
            plan.refused.push({ name, reason: "not a guarded tool and not ticked as trusted in /sandbox (Subagents · Tools)" });
            continue;
        }
        const network = isNetworkTool(name);
        if (network && !options.network) {
            plan.refused.push({ name, reason: "needs Network access, which is Off for subagents" });
            continue;
        }
        // Which package to load: a config override, else the package that registers
        // the tool in this Pi, else an installed npm package by its spec.
        const override = specList(options.toolExtensions?.[name]);
        let chosen: { package: string; loadPath: string } | undefined;
        let problem: string | undefined;
        for (const entry of ticked) {
            if (override.length) {
                if (!override.includes(entry.package)) continue;
                const loadPath = options.resolvePath(entry.package);
                if (loadPath) { chosen = { package: entry.package, loadPath }; break; }
                problem = `its package ${packageLabel(entry.package)} is not installed`;
                continue;
            }
            const owner = options.registered.map(toolPackage).find((tool) => tool?.name === name && tool.package === entry.package);
            const loadPath = owner?.root ?? (entry.package.startsWith("npm:") ? options.resolvePath(entry.package) : undefined);
            if (loadPath) { chosen = { package: entry.package, loadPath }; break; }
            problem = `its package ${packageLabel(entry.package)} can't be found (not installed or not loaded in this Pi)`;
        }
        if (!chosen) {
            plan.refused.push({ name, reason: problem ?? `config.json toolExtensions maps it to ${override.map(packageLabel).join(", ")}, not the ticked package ${ticked.map((t) => packageLabel(t.package)).join(", ")}` });
            continue;
        }
        // A directory is admitted as a package root; a file admits only itself.
        let root: string;
        try { root = canonicalizePath(chosen.loadPath); }
        catch { plan.refused.push({ name, reason: `its package path ${chosen.loadPath} can't be resolved` }); continue; }
        plan.trusted.push({ name, package: chosen.package, root, network, loadPath: chosen.loadPath });
    }
    return plan;
}

/** "apply_patch (guarded) · web_fetch, web_search (trusted)" for the launch Runtime line. */
export function describeTaskTools(plan: TaskToolPlan): string | undefined {
    const parts = [
        ...(plan.applyPatch ? [`guarded ${APPLY_PATCH}`] : []),
        ...(plan.trusted.length ? [`trusted ${plan.trusted.map((tool) => `${tool.name} (${packageLabel(tool.package)})`).join(", ")}`] : []),
    ];
    return parts.length ? parts.join(" · ") : undefined;
}
