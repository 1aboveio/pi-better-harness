import type { Theme } from "@earendil-works/pi-coding-agent";
import * as Tui from "@earendil-works/pi-tui";
import { isConcurrencyCap } from "./config.ts";
import { DELEGATION_MODES, type DelegationMode } from "./delegation.ts";

export interface SubagentSettingsSnapshot {
    mode: DelegationMode;
    maxConcurrent: number;
    modeSource: "session" | "config";
    capSource: "session" | "config";
    defaultMode: DelegationMode;
    defaultCap: number;
}

export interface SubagentSettingsHandlers {
    get(): SubagentSettingsSnapshot;
    changeMode(mode: DelegationMode): void;
    changeCap(cap: number): void;
    save(): { ok: boolean; message: string };
    reset(): void;
}

const labels = ["Delegation mode", "Concurrent subagents", "Save as defaults", "Reset to defaults"];

export function createSubagentSettingsPage(
    theme: Theme,
    handlers: SubagentSettingsHandlers,
    requestRender: () => void,
    close: () => void,
): Tui.Component & Tui.Focusable {
    const input = new Tui.Input();
    let focused = false;
    let row = 0;
    let editing = false;
    let message = "";
    let error = false;
    function report(text: string, failed = false): void {
        message = text;
        error = failed;
        requestRender();
    }
    function action(): void {
        try {
            const settings = handlers.get();
            if (row === 0) {
                const next = DELEGATION_MODES[(DELEGATION_MODES.indexOf(settings.mode) + 1) % DELEGATION_MODES.length]!;
                handlers.changeMode(next);
                report("Session mode updated.");
            } else if (row === 1) {
                editing = true;
                input.setValue(String(settings.maxConcurrent));
                input.handleInput("\x05");
                input.focused = focused;
                report("");
            } else if (row === 2) {
                const result = handlers.save();
                report(result.message, !result.ok);
            } else {
                handlers.reset();
                report("Session settings reset to saved defaults.");
            }
        } catch (cause) {
            report(cause instanceof Error ? cause.message : String(cause), true);
        }
    }
    input.onSubmit = (value) => {
        const cap = /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
        if (!isConcurrencyCap(cap)) {
            report("Enter a positive whole number.", true);
            return;
        }
        try {
            handlers.changeCap(cap);
            editing = false;
            input.focused = false;
            report("Session cap updated.");
        } catch (cause) {
            report(cause instanceof Error ? cause.message : String(cause), true);
        }
    };
    input.onEscape = () => {
        editing = false;
        input.focused = false;
        report("");
    };
    return {
        get focused() { return focused; },
        set focused(value: boolean) { focused = value; input.focused = editing && value; },
        invalidate() { input.invalidate(); },
        handleInput(data: string) {
            if (editing) {
                input.handleInput(data);
                requestRender();
                return;
            }
            if (Tui.matchesKey(data, Tui.Key.escape)) close();
            else if (Tui.matchesKey(data, Tui.Key.up)) row = Math.max(0, row - 1);
            else if (Tui.matchesKey(data, Tui.Key.down)) row = Math.min(labels.length - 1, row + 1);
            else if (Tui.matchesKey(data, Tui.Key.enter) || data === " ") action();
            else if (Tui.matchesKey(data, "ctrl+s")) {
                const selected = row;
                row = 2;
                action();
                row = selected;
            }
            requestRender();
        },
        render(width: number) {
            const settings = handlers.get();
            const values = [
                `${settings.mode} (${settings.modeSource})`,
                `${settings.maxConcurrent} (${settings.capSource})`,
                "",
                "",
            ];
            const lines = [theme.fg("accent", theme.bold("Subagent settings")), ""];
            labels.forEach((label, index) => {
                const text = `${index === row ? ">" : " "} ${label}${values[index] ? `: ${values[index]}` : ""}`;
                lines.push(index === row ? theme.fg("accent", theme.bold(text)) : text);
            });
            if (editing) lines.push("", ...input.render(Math.max(1, width)));
            lines.push("", theme.fg("muted", `Saved defaults: ${settings.defaultMode}, cap ${settings.defaultCap}`));
            if (message) lines.push(theme.fg(error ? "error" : "success", message));
            lines.push("", theme.fg("dim", editing ? "Enter apply  Esc cancel" : "Up/Down select  Enter change  Ctrl+S save  Esc close"));
            return lines.map((line) => Tui.truncateToWidth(line, Math.max(1, width), ""));
        },
    };
}
