import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

import { defaultSandboxPermissions, type CredentialAccess, type FileAccess, type SandboxPermissionProfile as PermissionProfile, type SandboxPermissionSettings as PermissionSettings } from "./permissions.ts";
export type { PermissionProfile, PermissionSettings };

export interface PermissionPageHandlers {
    getConfig(): PermissionSettings;
    toolLoading?(): { main: { name: string; provider: string }[]; subagents?: { name: string; provider: string }[] };
    change(settings: PermissionSettings): void | Promise<void>;
    save(settings: PermissionSettings): void | Promise<void>;
    /** What saving `settings` would loosen versus the saved defaults. Reported after the save. */
    loosening?(settings: PermissionSettings): string[];
}

export const DEFAULT_PERMISSION_SETTINGS = defaultSandboxPermissions();

const rows = [
    { label: "Sandbox", key: "enabled" },
    { label: "Project files", key: "projectFiles" },
    { label: "Outside project", key: "outsideProject" },
    { label: "Stored credentials", key: "storedCredentials" },
    { label: "Run applications", key: "commands" },
    { label: "Shell scripts", key: "shell" },
    { label: "Command time limit", key: "commandTimeoutSeconds" },
    { label: "Network access", key: "network" },
    { label: "Process access", key: "processAccess" },
] as const;
const fileValues: readonly FileAccess[] = ["off", "read", "write", "read-write"];
const credentialValues: readonly CredentialAccess[] = ["off", "read", "read-write"];
const FILE_LABELS: Record<FileAccess, string> = { off: "Off", read: "Read", write: "Write", "read-write": "Write & delete" };
const TIMEOUT_VALUES = [60, 300, 600, 1800, null] as const;

function timeoutLabel(seconds: number | null | undefined): string {
    if (seconds == null) return "No limit";
    return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds}s`;
}

/** The context line for the highlighted cell, or undefined. */
function cellHint(key: string, profile: PermissionProfile | undefined, column?: string): string | undefined {
    if (key === "projectFiles" || key === "outsideProject") {
        const level = profile?.[key];
        const where = key === "projectFiles" ? "in the project" : "outside the project";
        return level === "write"
            ? `Write: git and rename-based saves fail ${where} except in worktree folders; set Write & delete if needed.`
            : "Always deletable: temp, hidden ~/.directories and worktree folders (.worktrees/, *-worktrees/).";
    }
    if (key === "storedCredentials") return "Known credential files follow this row independently of Outside project.";
    if (key === "commands") return "Run applications is the master switch for command execution, including Shell scripts.";
    if (key === "shell") return "Shell scripts run inside the sandbox. Requires Run applications.";
    if (key === "commandTimeoutSeconds") return "Commands stop after this long. No limit lets them run until they finish.";
    if (key === "processAccess") return column === "background"
        ? "Task status diagnostics: gated by this row when Background tasks is On. Unavailable under Main confinement."
        : "Fixed process reads and macOS ps identity. This setting applies while the profile is On. No process control.";
    return undefined;
}
const columns = ["main", "subagents", "background"] as const;

function snapshot(settings: PermissionSettings): PermissionSettings {
    return { main: { ...settings.main }, subagents: { ...settings.subagents }, background: { ...settings.background }, subagentTools: {
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

/** Keyboard-driven resource permissions and tool inventory. */
export function createPermissionsPage(
    theme: Theme,
    handlers: PermissionPageHandlers,
    requestRender: () => void,
    close: () => void,
): Component {
    let settings: PermissionSettings | undefined;
    let section: "permissions" | "loading" = "permissions";
    let loadingRows: string[] = [];
    let loadingOffset = 0;
    const loadingWindow = 14;
    function readLoading(): string[] {
        try {
            const inventory = handlers.toolLoading?.();
            const entries = (tools: { name: string; provider: string }[]) =>
                tools.map(tool => `  ${tool.name}  ·  ${tool.provider}`);
            return [
                "Ordinary subagent defaults",
                ...(inventory?.subagents === undefined ? ["  Subagents extension unavailable"]
                    : inventory.subagents.length ? entries(inventory.subagents) : ["  No default tools selected"]),
                "", "Local Background tasks run commands through the Background adapter.",
                "", "Active Main tools",
                ...(inventory ? entries(inventory.main) : ["  Tool inventory unavailable"]),
            ];
        } catch (error) {
            return [`Tool inventory unavailable: ${errorText(error)}`];
        }
    }
    let message = "";
    let isError = false;
    try {
        settings = snapshot(handlers.getConfig());
    } catch (error) {
        message = errorText(error);
        isError = true;
    }
    let row = 0;
    let column = 0;
    let busy = false;

    function report(error: unknown): void {
        message = errorText(error);
        isError = true;
        requestRender();
    }

    async function change(): Promise<void> {
        if (!settings || busy) return;
        const next = snapshot(settings);
        const key = rows[row]!.key;
        const profile = columns[column]!;
        if (key !== "enabled" && !settings[profile].enabled) return;
        // Shell scripts and the time limit only apply while Run applications is On.
        if ((key === "shell" || key === "commandTimeoutSeconds") && !settings[profile].commands) return;
        if (key === "enabled" || key === "commands" || key === "network") {
            next[profile][key] = !next[profile][key];
        } else if (key === "shell") {
            next[profile].shell = next[profile].shell === false;
        } else if (key === "commandTimeoutSeconds") {
            const current = next[profile].commandTimeoutSeconds ?? null;
            const index = TIMEOUT_VALUES.findIndex((value) => value === current);
            next[profile].commandTimeoutSeconds = TIMEOUT_VALUES[(index + 1) % TIMEOUT_VALUES.length]!;
        } else if (key === "processAccess") {
            next[profile][key] = next[profile][key] === "off" ? "read" : "off";
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
            settings = next;
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

    return {
        invalidate() {},
        handleInput(data: string) {
            if (matchesKey(data, Key.escape)) {
                close();
            } else if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
                section = section === "permissions" ? "loading" : "permissions";
                if (section === "loading") {
                    loadingRows = readLoading();
                    loadingOffset = 0;
                }
                requestRender();
            } else if (section === "loading") {
                if (matchesKey(data, Key.up)) loadingOffset = Math.max(0, loadingOffset - 1);
                else if (matchesKey(data, Key.down)) loadingOffset = Math.min(Math.max(0, loadingRows.length - loadingWindow), loadingOffset + 1);
                else return;
                requestRender();
            } else if (matchesKey(data, Key.up)) {
                row = Math.max(0, row - 1);
                requestRender();
            } else if (matchesKey(data, Key.down)) {
                row = Math.min(rows.length - 1, row + 1);
                requestRender();
            } else if (matchesKey(data, Key.left)) {
                column = Math.max(0, column - 1);
                requestRender();
            } else if (matchesKey(data, Key.right)) {
                column = Math.min(columns.length - 1, column + 1);
                requestRender();
            } else if (matchesKey(data, Key.space)) {
                void change();
            } else if (matchesKey(data, "ctrl+s")) {
                void save();
            }
        },
        render(width: number): string[] {
            const w = Math.max(0, Math.floor(width));
            const activeTitle = section === "loading" ? "Tool loading" : "Use permissions";
            const tabs = ["Tool loading", "Use permissions"]
                .map(title => title === activeTitle ? theme.inverse(` ${title} `) : ` ${title} `).join("  ");
            const heading = truncateToWidth((visibleWidth(tabs) <= w ? tabs : theme.inverse(activeTitle)) + "   Tab switch", w, "");
            if (section === "loading") {
                return [heading, "", ...loadingRows.slice(loadingOffset, loadingOffset + loadingWindow),
                    "", "Role, tool list and exclusions determine each worker's tools.",
                    "↑↓ Scroll · Tab Use permissions · Esc Back"].map(text => truncateToWidth(text, w, ""));
            }
            const prefix = w >= 20 ? 2 : 0;
            const gap = w >= 8 ? 1 : 0;
            const minimumCell = Math.max(1, Math.min(16, Math.floor((w - prefix - gap) / 4)));
            const labelWidth = Math.min(28, Math.max(0, w - prefix - gap - columns.length * minimumCell));
            const available = Math.max(0, w - prefix - labelWidth - gap);
            const widths = columns.map((_profile, index) => Math.floor(available / columns.length) +
                (index < available % columns.length ? 1 : 0));
            const highlight = (text: string, selected: boolean): string => selected
                ? theme.bg("selectedBg", theme.bold(cell(text, w))) : text;
            const line = (label: string, values: readonly string[], selected: boolean, dim: readonly boolean[] = []) => {
                const marker = prefix ? (selected ? "> " : "  ") : "";
                const labelPart = cell(label, labelWidth);
                const cells = values.map((value, index) => {
                    const part = theme.fg(dim[index] ? "dim" : "text", cell(value, widths[index]!));
                    return selected && column === index ? theme.inverse(part) : part;
                });
                return highlight(theme.fg(selected ? "accent" : "text", marker + labelPart) + " ".repeat(gap) +
                    cells.join(""), selected);
            };
            const output = [heading, "", line("Sandbox permissions", ["Main", "Subagents", "Background tasks"], false), ""];
            for (let i = 0; i < rows.length; i++) {
                const entry = rows[i]!;
                const value = (profile: PermissionProfile): string => {
                    if (entry.key !== "enabled" && !profile.enabled) return "-";
                    if (entry.key === "enabled") return profile.enabled ? "On" : "Off";
                    if (entry.key === "commands") return profile.commands ? "On" : "Off";
                    if (entry.key === "shell") return !profile.commands ? "-" : profile.shell === false ? "Off" : "On";
                    if (entry.key === "commandTimeoutSeconds") {
                        if (!profile.commands) return "-";
                        return timeoutLabel(profile.commandTimeoutSeconds);
                    }
                    if (entry.key === "network") return profile.network ? "On" : "Off";
                    if (entry.key === "processAccess") return profile.processAccess === "read" ? "Read" : "Off";
                    return FILE_LABELS[profile[entry.key]];
                };
                output.push(line(entry.label, columns.map((profile) => settings ? value(settings[profile]) : "-"),
                    row === i, columns.map((profile) => !settings || (i > 0 && !settings[profile].enabled) ||
                        ((entry.key === "shell" || entry.key === "commandTimeoutSeconds") && !settings[profile].commands))));
                if (i === 0) output.push("");
            }
            output.push("");
            const contextual = settings ? cellHint(rows[row]!.key, settings[columns[column]!], columns[column]) : undefined;
            for (const hint of [
                "↑↓ Select · ←→ Column · Space Toggle · ctrl+s Save default · Esc Back",
                "Changes apply to new launches.",
                "Stored credentials: known files only; excludes OS vaults and environment tokens.",
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
