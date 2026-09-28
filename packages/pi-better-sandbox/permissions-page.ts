import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

import { isNetworkTool, packageLabel, type DiscoveredTool } from "./shared-task-tools.ts";
import { defaultSandboxPermissions, describeLoosening, type CredentialAccess, type FileAccess, type SandboxPermissionProfile as PermissionProfile, type SandboxPermissionSettings as PermissionSettings } from "./permissions.ts";
export type { PermissionProfile, PermissionSettings };

export interface PermissionPageHandlers {
    getConfig(): PermissionSettings;
    change(settings: PermissionSettings): void | Promise<void>;
    save(settings: PermissionSettings): void | Promise<void>;
    /** What saving `settings` would loosen versus the saved defaults; non-empty requires a confirming second Enter. */
    loosening?(settings: PermissionSettings): string[];
    /** Trusted-tool candidates registered in the running Pi (builtins and harness tools excluded). */
    discoverTools?(): readonly Pick<DiscoveredTool, "name" | "package">[];
}

type TrustedTool = { name: string; package: string; loaded: boolean };
/** One visible Tools row: a package with several tools folds into a group row. */
type ToolItem =
    | { kind: "guarded"; name: "apply_patch" }
    | { kind: "trusted"; tool: TrustedTool; nested: boolean }
    | { kind: "group"; package: string; tools: TrustedTool[]; open: boolean };

const GUARDED_HINT = "apply_patch goes through the guarded file operations: Project files and Outside project apply to it.";
const TRUSTED_HINT = "Trusted tools run in the subagent's Pi process, outside the file rules. Tick only tools you trust.";
const GROUP_HINT = "Space ticks or unticks every tool in this package. → expands, ← collapses.";

export const DEFAULT_PERMISSION_SETTINGS = defaultSandboxPermissions();

const rows = [
    { label: "Sandbox", key: "enabled" },
    { label: "Project files", key: "projectFiles" },
    { label: "Outside project", key: "outsideProject" },
    { label: "Stored credentials", key: "storedCredentials" },
    { label: "Run commands & applications", key: "commands" },
    { label: "Network access", key: "network" },
] as const;
const fileValues: readonly FileAccess[] = ["off", "read", "write", "read-write"];
const credentialValues: readonly CredentialAccess[] = ["off", "read", "read-write"];
const FILE_LABELS: Record<FileAccess, string> = { off: "Off", read: "Read", write: "Write", "read-write": "Write & delete" };
const CREDENTIAL_LABELS: Record<CredentialAccess, string> = { off: "Off", read: "Read", "read-write": "Read / write" };
const FIXED_CREDENTIALS = "Outside project = Write always hides credential files; change Outside project to edit this row.";

/** The context line for the highlighted cell, or undefined. */
function cellHint(key: string, profile: PermissionProfile | undefined): string | undefined {
    if (key === "projectFiles" || key === "outsideProject") {
        const level = profile?.[key];
        const where = key === "projectFiles" ? "in the project" : "outside the project";
        return level === "write"
            ? `Write: git and rename-based saves fail ${where} except in worktree folders; set Write & delete if needed.`
            : "Always deletable: temp, hidden ~/.directories and worktree folders (.worktrees/, *-worktrees/).";
    }
    if (key === "storedCredentials" && profile?.outsideProject === "write") return FIXED_CREDENTIALS;
    return undefined;
}
const columns = ["main", "subagents"] as const;

function snapshot(settings: PermissionSettings): PermissionSettings {
    return { main: { ...settings.main }, subagents: { ...settings.subagents }, subagentTools: {
        applyPatch: settings.subagentTools.applyPatch, trusted: settings.subagentTools.trusted.map((tool) => ({ ...tool })) } };
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function cell(text: string, width: number): string {
    if (width <= 0) return "";
    const cut = truncateToWidth(text, width, "");
    return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
}

/** A flat, keyboard-driven view; handlers own the effective policy and persistence. */
export function createPermissionsPage(
    theme: Theme,
    handlers: PermissionPageHandlers,
    requestRender: () => void,
    close: () => void,
): Component {
    let settings: PermissionSettings | undefined;
    let message = "";
    let isError = false;
    try {
        settings = snapshot(handlers.getConfig());
    } catch (error) {
        message = errorText(error);
        isError = true;
    }
    let discovered: readonly Pick<DiscoveredTool, "name" | "package">[] = [];
    try {
        discovered = handlers.discoverTools?.() ?? [];
    } catch (error) {
        message = `Tool discovery failed: ${errorText(error)}`;
        isError = true;
    }
    const isTicked = (item: { name: string; package: string }) =>
        !!settings?.subagentTools.trusted.some((tool) => tool.name === item.name && tool.package === item.package);
    /** Packages whose group row is expanded; groups start collapsed. */
    const expanded = new Set<string>();
    /**
     * Guarded first, then discovered and ticked trusted tools by package. A
     * package with several tools is one group row, followed by its tools when expanded.
     */
    function toolItems(): ToolItem[] {
        const trusted = new Map<string, TrustedTool>();
        for (const tool of discovered) trusted.set(`${tool.name}\0${tool.package}`, { name: tool.name, package: tool.package, loaded: true });
        for (const tool of settings?.subagentTools.trusted ?? []) {
            const key = `${tool.name}\0${tool.package}`;
            if (!trusted.has(key)) trusted.set(key, { name: tool.name, package: tool.package, loaded: false });
        }
        const byPackage = new Map<string, TrustedTool[]>();
        for (const tool of [...trusted.values()].sort((a, b) =>
            packageLabel(a.package).localeCompare(packageLabel(b.package)) || a.name.localeCompare(b.name))) {
            byPackage.set(tool.package, [...byPackage.get(tool.package) ?? [], tool]);
        }
        const result: ToolItem[] = [{ kind: "guarded", name: "apply_patch" }];
        for (const [pkg, tools] of byPackage) {
            if (tools.length === 1) {
                result.push({ kind: "trusted", tool: tools[0]!, nested: false });
                continue;
            }
            const open = expanded.has(pkg);
            result.push({ kind: "group", package: pkg, tools, open });
            if (open) result.push(...tools.map((tool) => ({ kind: "trusted" as const, tool, nested: true })));
        }
        return result;
    }
    let items = toolItems();
    const toolAt = (index: number): ToolItem | undefined => index >= rows.length && index < saveRow() ? items[index - rows.length] : undefined;

    /** Expand or collapse the group at, or containing, the selected row. */
    function fold(open: boolean): boolean {
        const item = toolAt(row);
        if (!item || item.kind === "guarded" || (item.kind === "trusted" && !item.nested)) return false;
        const pkg = item.kind === "group" ? item.package : item.tool.package;
        if (open) expanded.add(pkg);
        else expanded.delete(pkg);
        items = toolItems();
        // Collapsing from a nested tool moves the selection to its group row.
        if (!open) row = rows.length + items.findIndex((entry) => entry.kind === "group" && entry.package === pkg);
        requestRender();
        return true;
    }
    const saveRow = () => rows.length + items.length;
    let row = 0;
    let column = 0;
    let busy = false;
    let pendingConfirmation: string | undefined;

    function report(error: unknown): void {
        message = errorText(error);
        isError = true;
        requestRender();
    }

    async function change(): Promise<void> {
        if (!settings || busy || row === saveRow()) return;
        const next = snapshot(settings);
        if (row >= rows.length) {
            const item = items[row - rows.length]!;
            if (item.kind === "guarded") {
                next.subagentTools.applyPatch = !next.subagentTools.applyPatch;
                return apply(next);
            }
            const tools = item.kind === "group" ? item.tools : [item.tool];
            const inSet = (tool: { name: string; package: string }) => tools.some((t) => t.name === tool.name && t.package === tool.package);
            // A partly ticked group ticks the rest; a fully ticked one unticks all.
            next.subagentTools.trusted = next.subagentTools.trusted.filter((tool) => !inSet(tool));
            if (!tools.every(isTicked)) next.subagentTools.trusted.push(...tools.map((tool) => ({ name: tool.name, package: tool.package })));
            return apply(next);
        }
        const key = rows[row]!.key;
        const profile = columns[column]!;
        if (key !== "enabled" && !settings[profile].enabled) return;
        if (key === "enabled" || key === "commands" || key === "network") {
            next[profile][key] = !next[profile][key];
        } else if (key === "storedCredentials") {
            if (next[profile].outsideProject === "write") {
                message = FIXED_CREDENTIALS;
                isError = false;
                requestRender();
                return;
            }
            const current = next[profile][key];
            next[profile][key] = credentialValues[(credentialValues.indexOf(current) + 1) % credentialValues.length]!;
        } else {
            const current = next[profile][key];
            next[profile][key] = fileValues[(fileValues.indexOf(current) + 1) % fileValues.length]!;
        }
        return apply(next);
    }

    async function apply(next: PermissionSettings): Promise<void> {
        if (!settings) return;
        // Space applies at once; a looser change is named, and saving it as defaults still asks.
        const loosened = describeLoosening(settings, next);
        // A group tick loosens once per tool; name them as one count.
        const trusted = loosened.filter((line) => line.startsWith("Subagents: trusted tool "));
        if (trusted.length > 1) loosened.splice(loosened.indexOf(trusted[0]!), trusted.length, `Subagents: ${trusted.length} trusted tools run outside the file rules`);
        busy = true;
        try {
            await handlers.change(snapshot(next));
            settings = next;
            items = toolItems();
            row = Math.min(row, saveRow());
            message = loosened.length ? `Looser (${loosened.join("; ")}).` : "";
            isError = false;
            requestRender();
        } catch (error) {
            report(error);
        } finally {
            busy = false;
        }
    }

    async function save(): Promise<void> {
        if (!settings || busy) return;
        let loosened: string[];
        try {
            loosened = handlers.loosening?.(snapshot(settings)) ?? [];
        } catch (error) {
            report(error);
            return;
        }
        const key = JSON.stringify(settings);
        if (loosened.length && pendingConfirmation !== key) {
            pendingConfirmation = key;
            message = `Looser defaults (${loosened.join("; ")}). Press Enter again to save.`;
            isError = false;
            requestRender();
            return;
        }
        pendingConfirmation = undefined;
        busy = true;
        try {
            await handlers.save(snapshot(settings));
            message = "Defaults saved.";
            isError = false;
            requestRender();
        } catch (error) {
            report(error);
        } finally {
            busy = false;
        }
    }

    return {
        invalidate() {},
        handleInput(data: string) {
            if (!matchesKey(data, Key.enter)) pendingConfirmation = undefined;
            if (matchesKey(data, Key.escape)) {
                close();
            } else if (matchesKey(data, Key.up)) {
                row = Math.max(0, row - 1);
                requestRender();
            } else if (matchesKey(data, Key.down)) {
                row = Math.min(saveRow(), row + 1);
                requestRender();
            } else if (matchesKey(data, Key.left)) {
                if (fold(false)) return;
                column = 0;
                requestRender();
            } else if (matchesKey(data, Key.right)) {
                if (fold(true)) return;
                column = 1;
                requestRender();
            } else if (matchesKey(data, Key.space)) {
                void change();
            } else if (matchesKey(data, Key.enter) && row === saveRow()) {
                void save();
            }
        },
        render(width: number): string[] {
            const w = Math.max(0, Math.floor(width));
            const prefix = w >= 20 ? 2 : 0;
            const gap = w >= 8 ? 1 : 0;
            const minimumCell = Math.max(1, Math.min(10, Math.floor((w - prefix - gap) / 3)));
            const labelWidth = Math.min(28, Math.max(0, w - prefix - gap - 2 * minimumCell));
            const available = Math.max(0, w - prefix - labelWidth - gap);
            const mainWidth = Math.ceil(available / 2);
            const subWidth = available - mainWidth;
            const line = (label: string, main: string, sub: string, selected: boolean, dimMain = false, dimSub = false) => {
                const marker = prefix ? (selected ? "> " : "  ") : "";
                const labelPart = cell(label, labelWidth);
                const mainPart = cell(main, mainWidth);
                const subPart = cell(sub, subWidth);
                return theme.fg(selected ? "accent" : "text", marker + labelPart) + " ".repeat(gap) +
                    theme.fg(dimMain ? "dim" : selected && column === 0 ? "accent" : "text", mainPart) +
                    theme.fg(dimSub ? "dim" : selected && column === 1 ? "accent" : "text", subPart);
            };
            const output = [line("Sandbox permissions", "Main", "Subagents", false), ""];
            for (let i = 0; i < rows.length; i++) {
                const entry = rows[i]!;
                const value = (profile: PermissionProfile): string => {
                    if (entry.key !== "enabled" && !profile.enabled) return "-";
                    if (entry.key === "storedCredentials") {
                        return profile.outsideProject === "write" ? "Off (fixed)" : CREDENTIAL_LABELS[profile.storedCredentials];
                    }
                    const current = profile[entry.key];
                    return typeof current === "boolean" ? (current ? "On" : "Off") : FILE_LABELS[current];
                };
                output.push(line(entry.label, settings ? value(settings.main) : "-", settings ? value(settings.subagents) : "-",
                    row === i, !settings || (i > 0 && !settings.main.enabled), !settings || (i > 0 && !settings.subagents.enabled)));
                if (i === 0) output.push("");
            }
            // Subagents · Tools: which extension tools a confined subagent may use.
            output.push("", theme.fg("text", truncateToWidth(`${prefix ? "  " : ""}Subagents · Tools`, w, "")));
            const label = (item: ToolItem) => item.kind === "group" ? `${item.open ? "▾" : "▸"} ${packageLabel(item.package)}`
                : item.kind === "trusted" ? `${item.nested ? "  " : ""}${item.tool.name}` : item.name;
            const nameWidth = Math.min(40, Math.max(...items.map((item) => visibleWidth(label(item)))), Math.max(0, w - prefix - 8));
            items.forEach((item, index) => {
                if (index === 0) output.push(theme.fg("dim", truncateToWidth(`${prefix ? "  " : ""}  Guarded (follows the file rules)`, w, "")));
                if (index === 1) output.push(theme.fg("dim", truncateToWidth(`${prefix ? "  " : ""}  Trusted (runs outside the file rules)`, w, "")));
                const selected = row === rows.length + index;
                let mark: string;
                let detail: string[];
                if (item.kind === "guarded") {
                    mark = settings?.subagentTools.applyPatch ? "x" : " ";
                    detail = ["harness adapter"];
                } else if (item.kind === "group") {
                    const on = item.tools.filter(isTicked).length;
                    const missing = item.tools.filter((tool) => !tool.loaded).length;
                    mark = on === item.tools.length ? "x" : on ? "-" : " ";
                    detail = [`${on} of ${item.tools.length} on`, ...(item.tools.some((tool) => isNetworkTool(tool.name)) ? ["needs Network On"] : []),
                        ...(missing ? [`${missing} not loaded`] : [])];
                } else {
                    mark = isTicked(item.tool) ? "x" : " ";
                    // A nested tool's package is its group row.
                    detail = [...(item.nested ? [] : [packageLabel(item.tool.package)]), ...(isNetworkTool(item.tool.name) ? ["needs Network On"] : []),
                        ...(item.tool.loaded ? [] : ["not loaded"])];
                }
                const text = `${prefix ? (selected ? "> " : "  ") : ""}  [${mark}] ${cell(label(item), nameWidth)} ${detail.join(" · ")}`;
                output.push(theme.fg(selected ? "accent" : settings ? "text" : "dim", truncateToWidth(text, w, "").trimEnd()));
            });
            if (items.length === 1) {
                output.push(theme.fg("dim", truncateToWidth(`${prefix ? "  " : ""}  Trusted (runs outside the file rules)`, w, "")),
                    theme.fg("dim", truncateToWidth(`${prefix ? "  " : ""}    No other extension tools are installed.`, w, "")));
            }
            output.push("", line("Save as defaults", "", "", row === saveRow()));
            const selected = row < rows.length ? rows[row]!.key : undefined;
            const tool = toolAt(row);
            const contextual = tool ? (tool.kind === "guarded" ? GUARDED_HINT : tool.kind === "group" ? GROUP_HINT : TRUSTED_HINT)
                : selected && settings ? cellHint(selected, settings[columns[column]!]) : undefined;
            for (const hint of [
                "↑↓ Select row · ←→ Select column or fold a group · Space Change · Enter Save · Esc Back",
                "Changes apply to new launches. Background tasks follow their launcher.",
                "Stored credentials: known files only; excludes OS vaults and environment tokens.",
                "Trusted tools run outside the file rules.",
                ...(contextual ? [contextual] : []),
            ]) output.push(theme.fg("dim", truncateToWidth(hint, w, "")));
            if (message) output.push(theme.fg(isError ? "error" : "muted", truncateToWidth(message.replace(/[\r\n]+/g, " "), w, "")));
            return output;
        },
    };
}

export async function openPermissionsPage(ctx: ExtensionContext, handlers: PermissionPageHandlers): Promise<void> {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    await ctx.ui.custom<null>((tui, theme, _keybindings, done) =>
        createPermissionsPage(theme, handlers, () => tui.requestRender(), () => done(null)));
}
