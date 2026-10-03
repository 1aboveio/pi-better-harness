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

const labels = ["Delegation mode", "Concurrent subagents", "Reset to defaults"];

function cell(text: string, width: number): string {
    const clipped = Tui.truncateToWidth(text, width, "");
    return clipped + " ".repeat(Math.max(0, width - Tui.visibleWidth(clipped)));
}

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
                const result = handlers.save();
                report(result.message, !result.ok);
            }
            requestRender();
        },
        render(width: number) {
            const settings = handlers.get();
            const w = Math.max(1, Math.floor(width));
            const compact = w < 40;
            const labelWidth = 26;
            const valueWidth = Math.max(1, w - labelWidth - 1);
            const current = [settings.mode, String(settings.maxConcurrent)];
            const highlight = (text: string, selected: boolean): string => selected
                ? theme.bg("selectedBg", theme.bold(cell(text, w))) : text;
            const marker = (selected: boolean) => selected ? "> " : "  ";
            const lines: string[] = [theme.fg("accent", theme.bold("  Subagent settings")), ""];
            labels.forEach((label, index) => {
                const selected = index === row;
                if (index === 2) lines.push("");
                const title = theme.fg(selected ? "accent" : "text", marker(selected) + label);
                if (index >= 2) {
                    lines.push(highlight(title, selected));
                } else if (compact) {
                    lines.push(highlight(title, selected));
                    const active = editing && index === 1 ? input.render(Math.max(1, w - 2))[0]! : current[index]!;
                    lines.push("  " + (selected && !editing ? theme.inverse(active) : active));
                } else {
                    const active = editing && index === 1 ? input.render(valueWidth)[0]! : cell(current[index]!, valueWidth);
                    lines.push(highlight(cell(title, labelWidth) + " " +
                        (selected && !editing ? theme.inverse(active) : theme.fg("text", active)), selected));
                }
            });
            if (message) lines.push("", theme.fg(error ? "error" : "muted", message));
            lines.push("", theme.fg("dim", editing ? "Enter Apply · Esc Cancel" : "Up/Down Select · Space/Enter Change · ctrl+s Save default · Esc Back"));
            return lines.map((line) => Tui.truncateToWidth(line, w, ""));
        },
    };
}
