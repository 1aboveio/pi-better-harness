// Generated fixed launch domain from packages/pi-better-subagents/shared-task-tools.ts. Do not edit directly.
// Generated from packages/task-sandbox/tools.ts. Do not edit directly.
/**
 * Which extension tools a confined subagent may use (ADR 0009).
 *
 * - Guarded tools are harness adapters that go through the task's guarded file
 *   operations, so the file rules govern them. Today: apply_patch.
 * - Trusted tools are extension tools admitted by name AND owning package.
 *   They run in the child Pi process, outside the file rules; a human ticks each
 *   one in /sandbox. Network tools are refused while Network is Off.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
export const WEB_TOOLS_PACKAGE = "npm:@juicesharp/rpiv-web-tools";
export function defaultSubagentTools() {
    return {
        applyPatch: true,
        trusted: [{ name: "web_fetch", package: WEB_TOOLS_PACKAGE }, { name: "web_search", package: WEB_TOOLS_PACKAGE }],
    };
}
/** Tools that reach the network; refused while the profile's Network access is Off. */
export function isNetworkTool(name) {
    return ["web_fetch", "web_search", "firecrawl_scrape", "firecrawl_extract", "mcp", "mcpScript", ...SSH_TOOL_NAMES].includes(name) ||
        name.startsWith("mcp__");
}
/** Names never offered as trusted: builtins and the guarded adapters. */
export const RESERVED_TOOL_NAMES = Object.freeze(["read", "write", "edit", "bash", "run_application", "grep", "find", "ls", "powershell", "apply_patch", "process_list"]);
/** Harness tools stay excluded except for the explicitly supported SSH tools. */
const HARNESS_PACKAGES = /(^|[/:])pi-better-[a-z-]+$/;
const SSH_PACKAGE = /(^|[/:])pi-better-ssh$/;
const SSH_TOOL_NAMES = ["remote_bash", "ssh_profile", "ssh_mux"];
/** Strict decoding: a malformed tool list must not silently admit anything. */
export function parseSubagentTools(value) {
    if (value === undefined)
        return defaultSubagentTools();
    if (!value || typeof value !== "object")
        throw new Error("Invalid subagent tool settings.");
    const v = value;
    if (typeof v.applyPatch !== "boolean" || !Array.isArray(v.trusted))
        throw new Error("Invalid subagent tool settings.");
    const trusted = [];
    for (const entry of v.trusted) {
        const e = entry;
        if (!e || typeof e.name !== "string" || !e.name || typeof e.package !== "string" || !e.package) {
            throw new Error("Invalid trusted subagent tool entry.");
        }
        if (RESERVED_TOOL_NAMES.includes(e.name))
            throw new Error(`${e.name} cannot be a trusted tool.`);
        if (!trusted.some((t) => t.name === e.name && t.package === e.package))
            trusted.push({ name: e.name, package: e.package });
    }
    return { applyPatch: v.applyPatch, trusted };
}
/** The owning package of a registered tool, or undefined for synthetic core/inline sources. */
export function toolPackage(tool) {
    const info = tool.sourceInfo;
    if (!info?.path || info.path.startsWith("<"))
        return undefined;
    const base = info.baseDir ?? dirname(info.path);
    if (!existsSync(join(base, "package.json"))) {
        // A single extension file (e.g. ~/.pi/agent/extensions/foo.ts): it is its own package.
        return { name: tool.name, package: info.path, root: info.path };
    }
    const pkg = info.source && info.source !== "builtin" ? info.source : base;
    return { name: tool.name, package: pkg, root: base };
}
/** Candidate trusted tools, excluding core builtins, guarded names and non-SSH harness tools. */
export function discoverTrustedTools(tools) {
    const found = [];
    for (const tool of tools) {
        if (RESERVED_TOOL_NAMES.includes(tool.name))
            continue;
        const owner = toolPackage(tool);
        if (!owner)
            continue;
        const harnessOwners = [owner.package, owner.root].map((id) => id.replace(/\/+$/, ""))
            .filter((id) => HARNESS_PACKAGES.test(id));
        if (harnessOwners.length && !(SSH_TOOL_NAMES.includes(tool.name) && harnessOwners.every((id) => SSH_PACKAGE.test(id))))
            continue;
        if (!found.some((t) => t.name === owner.name && t.package === owner.package)) {
            found.push(tool.sourceInfo?.source === "builtin" ? { ...owner, source: "builtin" } : owner);
        }
    }
    return found.sort((a, b) => a.name.localeCompare(b.name) || a.package.localeCompare(b.package));
}
/** A package label for display: `npm:@scope/name` → `@scope/name`. */
export function packageLabel(pkg) {
    return pkg.startsWith("npm:") ? pkg.slice(4) : pkg;
}
