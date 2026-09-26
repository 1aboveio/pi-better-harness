import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

import { defaultSandboxPermissions, type FileAccess, type SandboxPermissionProfile as PermissionProfile, type SandboxPermissionSettings as PermissionSettings } from "./permissions.ts";
export type { PermissionProfile, PermissionSettings };

export interface PermissionPageHandlers {
    getConfig(): PermissionSettings;
    change(settings: PermissionSettings): void | Promise<void>;
    save(settings: PermissionSettings): void | Promise<void>;
}

export const DEFAULT_PERMISSION_SETTINGS = defaultSandboxPermissions();

const rows = [
    { label: "Sandbox", key: "enabled" },
    { label: "Project files", key: "projectFiles" },
    { label: "Outside project", key: "outsideProject" },
    { label: "Stored credentials", key: "storedCredentials" },
    { label: "Run commands & applications", key: "commands" },
    { label: "Network access", key: "network" },
] as const;
const fileValues: readonly FileAccess[] = ["off", "read", "read-write"];
const columns = ["main", "subagents"] as const;

function snapshot(settings: PermissionSettings): PermissionSettings {
    return { main: { ...settings.main }, subagents: { ...settings.subagents } };
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
    let row = 0;
    let column = 0;
    let busy = false;

    function report(error: unknown): void {
        message = errorText(error);
        isError = true;
        requestRender();
    }

    async function change(): Promise<void> {
        if (!settings || busy || row === rows.length) return;
        const key = rows[row]!.key;
        const profile = columns[column]!;
        if (key !== "enabled" && !settings[profile].enabled) return;
        const next = snapshot(settings);
        if (key === "enabled" || key === "commands" || key === "network") {
            next[profile][key] = !next[profile][key];
        } else {
            const current = next[profile][key];
            next[profile][key] = fileValues[(fileValues.indexOf(current) + 1) % fileValues.length]!;
        }
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
            if (matchesKey(data, Key.escape)) {
                close();
            } else if (matchesKey(data, Key.up)) {
                row = Math.max(0, row - 1);
                requestRender();
            } else if (matchesKey(data, Key.down)) {
                row = Math.min(rows.length, row + 1);
                requestRender();
            } else if (matchesKey(data, Key.left)) {
                column = 0;
                requestRender();
            } else if (matchesKey(data, Key.right)) {
                column = 1;
                requestRender();
            } else if (matchesKey(data, Key.space)) {
                void change();
            } else if (matchesKey(data, Key.enter) && row === rows.length) {
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
                    const current = profile[entry.key];
                    return typeof current === "boolean" ? (current ? "On" : "Off") :
                        current === "read-write" ? "Read / write" : current === "read" ? "Read" : "Off";
                };
                output.push(line(entry.label, settings ? value(settings.main) : "-", settings ? value(settings.subagents) : "-",
                    row === i, !settings || (i > 0 && !settings.main.enabled), !settings || (i > 0 && !settings.subagents.enabled)));
                if (i === 0) output.push("");
            }
            output.push("", line("Save as defaults", "", "", row === rows.length));
            for (const hint of [
                "↑↓ Select row · ←→ Select column · Space Change · Enter Save · Esc Back",
                "Changes apply to new launches. Background tasks follow their launcher.",
                "Stored credentials: known files only; excludes OS vaults and environment tokens.",
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
