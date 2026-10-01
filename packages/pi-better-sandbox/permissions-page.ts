import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

import { isNetworkTool, packageLabel, type DiscoveredTool } from "./shared-task-tools.ts";
import { defaultSandboxPermissions, type CredentialAccess, type FileAccess, type SandboxPermissionProfile as PermissionProfile, type SandboxPermissionSettings as PermissionSettings } from "./permissions.ts";
export type { PermissionProfile, PermissionSettings };

export interface PermissionPageHandlers {
    getConfig(): PermissionSettings;
    change(settings: PermissionSettings): void | Promise<void>;
    save(settings: PermissionSettings): void | Promise<void>;
    /** What saving `settings` would loosen versus the saved defaults. Reported after the save. */
    loosening?(settings: PermissionSettings): string[];
    /** Trusted-tool candidates registered in the running Pi (builtins and harness tools excluded). */
    discoverTools?(): readonly Pick<DiscoveredTool, "name" | "package">[];
}

type TrustedItem = { kind: "trusted"; name: string; package: string; loaded: boolean; group: string };
type ToolGroup = { kind: "group"; id: string; label: string; tools: TrustedItem[] };
type ToolItem =
    | { kind: "guarded"; name: "apply_patch" }
    | TrustedItem
    | ToolGroup;

const GUARDED_HINT = "apply_patch goes through the guarded file operations: Project files and Outside project apply to it.";
const TRUSTED_HINT = "Trusted tools run in the subagent's Pi process, outside the file rules. Tick only tools you trust.";

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

/** The context line for the highlighted cell, or undefined. */
function cellHint(key: string, profile: PermissionProfile | undefined): string | undefined {
    if (key === "projectFiles" || key === "outsideProject") {
        const level = profile?.[key];
        const where = key === "projectFiles" ? "in the project" : "outside the project";
        return level === "write"
            ? `Write: git and rename-based saves fail ${where} except in worktree folders; set Write & delete if needed.`
            : "Always deletable: temp, hidden ~/.directories and worktree folders (.worktrees/, *-worktrees/).";
    }
    if (key === "storedCredentials") return "Known credential files follow this row independently of Outside project.";
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

/** Keyboard-driven profiles and a foldable package/provider tool tree. */
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
    const expanded = new Set<string>();
    function toolGroups(): ToolGroup[] {
        const trusted = new Map<string, TrustedItem>();
        const add = (tool: { name: string; package: string }, loaded: boolean) => {
            const provider = /^mcp__(.+?)__/.exec(tool.name)?.[1];
            const group = JSON.stringify([tool.package, provider ?? ""]);
            const key = JSON.stringify([tool.name, tool.package]);
            if (!trusted.has(key)) trusted.set(key, { ...tool, kind: "trusted", loaded, group });
        };
        for (const tool of discovered) add(tool, true);
        for (const tool of settings?.subagentTools.trusted ?? []) add(tool, false);
        const groups = new Map<string, ToolGroup>();
        for (const tool of trusted.values()) {
            if (!groups.has(tool.group)) {
                const provider = JSON.parse(tool.group)[1] as string;
                groups.set(tool.group, { kind: "group", id: tool.group,
                    label: provider ? `${provider} (${packageLabel(tool.package)})` : packageLabel(tool.package), tools: [] });
            }
            groups.get(tool.group)!.tools.push(tool);
        }
        for (const group of groups.values()) group.tools.sort((a, b) => a.name.localeCompare(b.name));
        return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    }
    function toolItems(): ToolItem[] {
        return [{ kind: "guarded", name: "apply_patch" }, ...toolGroups().flatMap((group): ToolItem[] =>
            [group, ...(expanded.has(group.id) ? group.tools : [])])];
    }
    const itemKey = (item: ToolItem) => item.kind === "group" ? item.id
        : item.kind === "guarded" ? "apply_patch" : JSON.stringify([item.name, item.package]);
    let items = toolItems();
    const saveRow = () => rows.length + items.length;
    let row = 0;
    let column = 0;
    let busy = false;

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
            if (item.kind === "guarded") next.subagentTools.applyPatch = !next.subagentTools.applyPatch;
            else if (item.kind === "group") {
                const all = item.tools.every(isTicked);
                for (const tool of item.tools) {
                    if (all) next.subagentTools.trusted = next.subagentTools.trusted.filter((entry) =>
                        !(entry.name === tool.name && entry.package === tool.package));
                    else if (!isTicked(tool)) next.subagentTools.trusted.push({ name: tool.name, package: tool.package });
                }
            } else if (isTicked(item)) {
                next.subagentTools.trusted = next.subagentTools.trusted.filter((tool) => !(tool.name === item.name && tool.package === item.package));
            } else next.subagentTools.trusted.push({ name: item.name, package: item.package });
            return apply(next);
        }
        const key = rows[row]!.key;
        const profile = columns[column]!;
        if (key !== "enabled" && !settings[profile].enabled) return;
        if (key === "enabled" || key === "commands" || key === "network") {
            next[profile][key] = !next[profile][key];
        } else if (key === "storedCredentials") {
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
        busy = true;
        try {
            await handlers.change(snapshot(next));
            const selected = row >= rows.length && row < saveRow() ? items[row - rows.length] : undefined;
            const wasSave = row === saveRow();
            const successors = selected ? items.slice(row - rows.length + 1).map(itemKey) : [];
            settings = next;
            items = toolItems();
            const index = selected ? items.findIndex((item) => itemKey(item) === itemKey(selected)) : -1;
            const successor = successors.map((key) => items.findIndex((item) => itemKey(item) === key)).find((at) => at >= 0);
            row = wasSave ? saveRow() : index >= 0 ? rows.length + index
                : successor !== undefined ? rows.length + successor : Math.min(row, saveRow());
            message = "";
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
        busy = true;
        try {
            await handlers.save(snapshot(settings));
            message = loosened.length ? `Defaults saved. Looser: ${loosened.join("; ")}.` : "Defaults saved.";
            isError = false;
            requestRender();
        } catch (error) {
            report(error);
        } finally {
            busy = false;
        }
    }

    function fold(open?: boolean): void {
        const item = row >= rows.length && row < saveRow() ? items[row - rows.length] : undefined;
        const id = item?.kind === "group" ? item.id : item?.kind === "trusted" && open === false ? item.group : undefined;
        if (!id) return;
        if (open ?? !expanded.has(id)) expanded.add(id);
        else expanded.delete(id);
        items = toolItems();
        row = rows.length + items.findIndex((entry) => entry.kind === "group" && entry.id === id);
        requestRender();
    }

    return {
        invalidate() {},
        handleInput(data: string) {
            if (matchesKey(data, Key.escape)) {
                close();
            } else if (matchesKey(data, Key.up)) {
                row = Math.max(0, row - 1);
                requestRender();
            } else if (matchesKey(data, Key.down)) {
                row = Math.min(saveRow(), row + 1);
                requestRender();
            } else if (matchesKey(data, Key.left)) {
                if (row >= rows.length && row < saveRow()) fold(false);
                else column = 0;
                requestRender();
            } else if (matchesKey(data, Key.right)) {
                if (row >= rows.length && row < saveRow()) fold(true);
                else column = 1;
                requestRender();
            } else if (matchesKey(data, Key.space)) {
                void change();
            } else if (matchesKey(data, "ctrl+s")) {
                void save();
            } else if (matchesKey(data, Key.enter) && row === saveRow()) {
                void save();
            } else if (matchesKey(data, Key.enter)) {
                fold();
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
            const highlight = (text: string, selected: boolean): string => selected
                ? theme.bg("selectedBg", theme.bold(cell(text, w))) : text;
            const line = (label: string, main: string, sub: string, selected: boolean, dimMain = false, dimSub = false) => {
                const marker = prefix ? (selected ? "> " : "  ") : "";
                const labelPart = cell(label, labelWidth);
                const mainPart = theme.fg(dimMain ? "dim" : "text", cell(main, mainWidth));
                const subPart = theme.fg(dimSub ? "dim" : "text", cell(sub, subWidth));
                return highlight(theme.fg(selected ? "accent" : "text", marker + labelPart) + " ".repeat(gap) +
                    (selected && column === 0 ? theme.inverse(mainPart) : mainPart) +
                    (selected && column === 1 ? theme.inverse(subPart) : subPart), selected);
            };
            const output = [line("Sandbox permissions", "Main", "Subagents", false), ""];
            for (let i = 0; i < rows.length; i++) {
                const entry = rows[i]!;
                const value = (profile: PermissionProfile): string => {
                    if (entry.key !== "enabled" && !profile.enabled) return "-";
                    if (entry.key === "storedCredentials") {
                        return CREDENTIAL_LABELS[profile.storedCredentials];
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
            const toolNames = items.flatMap((item) => item.kind === "group" ? [] : [visibleWidth(item.name)]);
            const nameWidth = Math.min(24, Math.max(...toolNames), Math.max(0, w - prefix - 10));
            items.forEach((item, index) => {
                if (index === 0) output.push(theme.fg("dim", truncateToWidth(`${prefix ? "  " : ""}  Guarded (follows the file rules)`, w, "")));
                if (index === 1) output.push(theme.fg("dim", truncateToWidth(`${prefix ? "  " : ""}  Trusted (runs outside the file rules)`, w, "")));
                const selected = row === rows.length + index;
                let text: string;
                if (item.kind === "group") {
                    const count = item.tools.filter(isTicked).length;
                    const tick = count === item.tools.length ? "x" : count ? "-" : " ";
                    text = `  ${expanded.has(item.id) ? "v" : ">"} [${tick}] ${item.label} ${count}/${item.tools.length}`;
                } else {
                    const ticked = item.kind === "guarded" ? !!settings?.subagentTools.applyPatch : isTicked(item);
                    const detail = item.kind === "guarded" ? "harness adapter" : [
                        ...(isNetworkTool(item.name) ? ["needs Network On"] : []), ...(item.loaded ? [] : ["not loaded"])].join(" · ");
                    text = `${item.kind === "guarded" ? "  " : "      "}[${ticked ? "x" : " "}] ${cell(item.name, nameWidth)} ${detail}`;
                }
                output.push(highlight(theme.fg(selected ? "accent" : settings ? "text" : "dim",
                    truncateToWidth(`${prefix ? (selected ? "> " : "  ") : ""}${text}`, w, "")), selected));
            });
            if (items.length === 1) {
                output.push(theme.fg("dim", truncateToWidth(`${prefix ? "  " : ""}  Trusted (runs outside the file rules)`, w, "")),
                    theme.fg("dim", truncateToWidth(`${prefix ? "  " : ""}    No other extension tools are installed.`, w, "")));
            }
            output.push("", line("Save as defaults", "", "", row === saveRow()));
            const selected = row < rows.length ? rows[row]!.key : undefined;
            const tool = row >= rows.length && row < saveRow() ? items[row - rows.length] : undefined;
            const contextual = tool ? (tool.kind === "guarded" ? GUARDED_HINT : TRUSTED_HINT)
                : selected && settings ? cellHint(selected, settings[columns[column]!]) : undefined;
            for (const hint of [
                "↑↓ Select · ←→ Column/fold · Space Toggle · ctrl+s Save · Enter Fold · Esc Back",
                "Changes apply to new launches. Background tasks follow their launcher.",
                "Stored credentials: known files only; excludes OS vaults and environment tokens.",
                "Trusted tools run outside the file rules.",
                ...(contextual ? [contextual] : []),
            ]) output.push(theme.fg("dim", truncateToWidth(hint, w, "")));
            if (message) {
                const clean = message.replace(/[\r\n]+/g, " ");
                const messages = visibleWidth(clean) > w && clean.includes(". ") ? clean.split(/(?<=\. )/) : [clean];
                for (const text of messages) output.push(theme.fg(isError ? "error" : "muted", truncateToWidth(text, w, "")));
            }
            return output;
        },
    };
}

export async function openPermissionsPage(ctx: ExtensionContext, handlers: PermissionPageHandlers): Promise<void> {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    await ctx.ui.custom<null>((tui, theme, _keybindings, done) =>
        createPermissionsPage(theme, handlers, () => tui.requestRender(), () => done(null)));
}
