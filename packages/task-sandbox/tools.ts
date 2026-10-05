/**
 * Which extension tools a confined subagent may use (ADR 0009).
 *
 * - Guarded tools are harness adapters that go through the task's guarded file
 *   operations, so the file rules govern them. Today: apply_patch.
 * - Trusted tools are third-party tools admitted by name AND owning package.
 *   They run in the child Pi process, outside the file rules; a human ticks each
 *   one in /sandbox. Network tools are refused while Network is Off.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface TrustedToolEntry {
    /** Tool name as registered. */
    name: string;
    /** Owning package, as Pi reports its source (e.g. `npm:@juicesharp/rpiv-web-tools`). */
    package: string;
}

export interface SubagentToolSettings {
    /** The guarded apply_patch adapter. */
    applyPatch: boolean;
    /** Ticked trusted tools. Everything not listed is off. */
    trusted: TrustedToolEntry[];
}

export const WEB_TOOLS_PACKAGE = "npm:@juicesharp/rpiv-web-tools";

export function defaultSubagentTools(): SubagentToolSettings {
    return {
        applyPatch: true,
        trusted: [{ name: "web_fetch", package: WEB_TOOLS_PACKAGE }, { name: "web_search", package: WEB_TOOLS_PACKAGE }],
    };
}

/** Tools that reach the network; refused while the profile's Network access is Off. */
export function isNetworkTool(name: string): boolean {
    return ["web_fetch", "web_search", "firecrawl_scrape", "firecrawl_extract", "mcp", "mcpScript", "remote_bash"].includes(name) ||
        name.startsWith("mcp__");
}

/** Names never offered as trusted: builtins and the guarded adapters. */
export const RESERVED_TOOL_NAMES = Object.freeze(["read", "write", "edit", "bash", "grep", "find", "ls", "powershell", "apply_patch", "process_list"]);

/** Packages that are this harness: their tools are never offered as trusted tools. */
const HARNESS_PACKAGES = /(^|[/:])pi-better-[a-z-]+$/;

/** Strict decoding: a malformed tool list must not silently admit anything. */
export function parseSubagentTools(value: unknown): SubagentToolSettings {
    if (value === undefined) return defaultSubagentTools();
    if (!value || typeof value !== "object") throw new Error("Invalid subagent tool settings.");
    const v = value as Record<string, unknown>;
    if (typeof v.applyPatch !== "boolean" || !Array.isArray(v.trusted)) throw new Error("Invalid subagent tool settings.");
    const trusted: TrustedToolEntry[] = [];
    for (const entry of v.trusted) {
        const e = entry as Record<string, unknown> | null;
        if (!e || typeof e.name !== "string" || !e.name || typeof e.package !== "string" || !e.package) {
            throw new Error("Invalid trusted subagent tool entry.");
        }
        if (RESERVED_TOOL_NAMES.includes(e.name)) throw new Error(`${e.name} cannot be a trusted tool.`);
        if (!trusted.some((t) => t.name === e.name && t.package === e.package)) trusted.push({ name: e.name, package: e.package });
    }
    return { applyPatch: v.applyPatch, trusted };
}

export interface ToolSource {
    name: string;
    sourceInfo?: { path?: string; source?: string; baseDir?: string };
}

export interface DiscoveredTool {
    name: string;
    package: string;
    /** Explicit SDK provenance for display only; never a package or admission identity. */
    source?: "builtin";
    /**
     * What to load and admit: the package root directory, or, for an extension
     * file with no package manifest, that file itself. Loading a manifest-less
     * directory would make Pi discover every extension in it.
     */
    root: string;
}

/** The owning package of a registered tool, or undefined for synthetic core/inline sources. */
export function toolPackage(tool: ToolSource): DiscoveredTool | undefined {
    const info = tool.sourceInfo;
    if (!info?.path || info.path.startsWith("<")) return undefined;
    const base = info.baseDir ?? dirname(info.path);
    if (!existsSync(join(base, "package.json"))) {
        // A single extension file (e.g. ~/.pi/agent/extensions/foo.ts): it is its own package.
        return { name: tool.name, package: info.path, root: info.path };
    }
    const pkg = info.source && info.source !== "builtin" ? info.source : base;
    return { name: tool.name, package: pkg, root: base };
}

/** Candidate trusted tools in a running Pi, excluding core builtins, guarded names and this harness. */
export function discoverTrustedTools(tools: readonly ToolSource[]): DiscoveredTool[] {
    const found: DiscoveredTool[] = [];
    for (const tool of tools) {
        if (RESERVED_TOOL_NAMES.includes(tool.name)) continue;
        const owner = toolPackage(tool);
        if (!owner || [owner.package, owner.root].some((id) => HARNESS_PACKAGES.test(id.replace(/\/+$/, "")))) continue;
        if (!found.some((t) => t.name === owner.name && t.package === owner.package)) {
            found.push(tool.sourceInfo?.source === "builtin" ? { ...owner, source: "builtin" } : owner);
        }
    }
    return found.sort((a, b) => a.name.localeCompare(b.name) || a.package.localeCompare(b.package));
}

/** A package label for display: `npm:@scope/name` → `@scope/name`. */
export function packageLabel(pkg: string): string {
    return pkg.startsWith("npm:") ? pkg.slice(4) : pkg;
}
