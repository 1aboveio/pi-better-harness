import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import * as Tui from "@earendil-works/pi-tui";
import { isConcurrencyCap } from "./config.ts";
import { DELEGATION_MODES, type DelegationMode } from "./delegation.ts";
import type { SkillExposureMode } from "./skills.ts";

export interface SubagentSettingsSnapshot {
    mode: DelegationMode;
    maxConcurrent: number;
    modeSource: "session" | "config";
    capSource: "session" | "config";
    defaultMode: DelegationMode;
    defaultCap: number;
    /** Session draft, or the saved global default when this session has no override. */
    skillsMode: SkillExposureMode;
    skillsPaths: readonly string[];
    skillsSource: "session" | "config" | "default";
    /** A saved `defaultSkills` value the launcher cannot read, kept visible rather than hidden. */
    skillsError?: string;
}

export interface SubagentSettingsHandlers {
    get(): SubagentSettingsSnapshot;
    changeMode(mode: DelegationMode): void;
    changeCap(cap: number): void;
    changeSkills(mode: SkillExposureMode, paths: readonly string[]): void;
    save(): { ok: boolean; message: string };
    reset(): void;
    /** Opens the same catalog as `/agents`. The caller closes this page first. */
    openAgents?(): void;
}

type EditTarget = { kind: "cap" } | { kind: "skill"; index: number } | { kind: "add" };

type Row =
    | { kind: "mode" }
    | { kind: "cap" }
    | { kind: "skills" }
    | { kind: "path"; index: number; path: string }
    | { kind: "add" }
    | { kind: "agents" }
    | { kind: "reset" };

const SKILL_MODES: readonly { mode: SkillExposureMode; label: string }[] = [
    { mode: "inherit", label: "Discover automatically" },
    { mode: "none", label: "No skill catalog" },
    { mode: "explicit", label: "Selected skills" },
];

const LABEL_WIDTH = 26;

function skillLabel(mode: SkillExposureMode): string {
    return SKILL_MODES.find((entry) => entry.mode === mode)!.label;
}

function nextSkillMode(mode: SkillExposureMode): SkillExposureMode {
    const index = SKILL_MODES.findIndex((entry) => entry.mode === mode);
    return SKILL_MODES[(index + 1) % SKILL_MODES.length]!.mode;
}

function skillSource(settings: SubagentSettingsSnapshot): string {
    if (settings.skillsError) return `Config error: ${settings.skillsError}`;
    if (settings.skillsSource === "session") return "Source: this session (unsaved)";
    if (settings.skillsSource === "config") return "Source: config defaultSkills";
    return "Source: discovery default";
}

function skillPathProblem(value: string, paths: readonly string[], except?: number): { path?: string; problem?: string } {
    const path = value.trim();
    if (!path) return { problem: "Enter an absolute path to a SKILL.md file or skill directory. Esc cancels." };
    if (!isAbsolute(path)) return { problem: "Enter an absolute path so every child resolves the same skill." };
    if (paths.some((entry, index) => index !== except && entry === path)) {
        return { problem: "That skill path is already listed." };
    }
    if (!existsSync(path)) return { problem: "No file or directory exists at that path." };
    return { path };
}

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
    let editing: EditTarget | undefined;
    let rememberedSkillPaths: string[] | undefined;
    let message = "";
    let error = false;

    function report(text: string, failed = false): void {
        message = text;
        error = failed;
        requestRender();
    }

    function rowsOf(settings: SubagentSettingsSnapshot): Row[] {
        const rows: Row[] = [{ kind: "mode" }, { kind: "cap" }, { kind: "skills" }];
        if (settings.skillsMode === "explicit") {
            settings.skillsPaths.forEach((path, index) => rows.push({ kind: "path", index, path }));
            rows.push({ kind: "add" });
        }
        rows.push({ kind: "agents" }, { kind: "reset" });
        return rows;
    }

    function startEditing(target: EditTarget, value: string): void {
        editing = target;
        input.setValue(value);
        input.handleInput("\x05");
        input.focused = focused;
        report("");
    }

    function finishEditing(text: string): void {
        input.focused = false;
        editing = undefined;
        report(text);
    }

    function action(settings: SubagentSettingsSnapshot, selected: Row): void {
        try {
            if (selected.kind === "mode") {
                const next = DELEGATION_MODES[(DELEGATION_MODES.indexOf(settings.mode) + 1) % DELEGATION_MODES.length]!;
                handlers.changeMode(next);
                report("Session mode updated.");
            } else if (selected.kind === "cap") {
                startEditing({ kind: "cap" }, String(settings.maxConcurrent));
            } else if (selected.kind === "skills") {
                if (settings.skillsMode === "explicit") rememberedSkillPaths = [...settings.skillsPaths];
                const next = nextSkillMode(settings.skillsMode);
                const paths = next === "explicit"
                    ? rememberedSkillPaths ?? [...settings.skillsPaths]
                    : [];
                handlers.changeSkills(next, paths);
                if (next === "explicit") rememberedSkillPaths = [...paths];
                if (next === "explicit" && paths.length === 0) {
                    report("Add at least one skill path, or choose No skill catalog to load none.");
                } else {
                    report(`Skill exposure: ${skillLabel(next).toLowerCase()}.`);
                }
            } else if (selected.kind === "path") {
                startEditing({ kind: "skill", index: selected.index }, selected.path);
            } else if (selected.kind === "add") {
                startEditing({ kind: "add" }, "");
            } else if (selected.kind === "agents") {
                handlers.openAgents?.();
            } else {
                handlers.reset();
                rememberedSkillPaths = undefined;
                report("Session settings reset to saved defaults.");
            }
        } catch (cause) {
            report(cause instanceof Error ? cause.message : String(cause), true);
        }
    }

    function removePath(settings: SubagentSettingsSnapshot, index: number): void {
        const paths = settings.skillsPaths.filter((_, position) => position !== index);
        handlers.changeSkills("explicit", paths);
        rememberedSkillPaths = [...paths];
        report(paths.length === 0
            ? "No skills selected. Add a path or choose No skill catalog to save none."
            : "Skill path removed.");
    }

    const submit = (value: string) => {
        const target = editing;
        if (!target) return;
        const settings = handlers.get();
        if (target.kind === "cap") {
            const cap = /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
            if (!isConcurrencyCap(cap)) {
                report("Enter a positive whole number.", true);
                return;
            }
            try {
                handlers.changeCap(cap);
                finishEditing("Session cap updated.");
            } catch (cause) {
                report(cause instanceof Error ? cause.message : String(cause), true);
            }
            return;
        }
        const checked = skillPathProblem(value, settings.skillsPaths, target.kind === "skill" ? target.index : undefined);
        if (!checked.path) {
            report(checked.problem!, true);
            return;
        }
        try {
            if (target.kind === "add") {
                const paths = [...settings.skillsPaths, checked.path];
                handlers.changeSkills("explicit", paths);
                rememberedSkillPaths = [...paths];
                finishEditing("Skill path added.");
            } else {
                const paths = [...settings.skillsPaths];
                paths[target.index] = checked.path;
                handlers.changeSkills("explicit", paths);
                rememberedSkillPaths = [...paths];
                finishEditing("Skill path updated.");
            }
        } catch (cause) {
            report(cause instanceof Error ? cause.message : String(cause), true);
        }
    };
    input.onSubmit = submit;
    input.onEscape = () => {
        input.focused = false;
        editing = undefined;
        report("Edit cancelled.");
    };

    return {
        get focused() { return focused; },
        set focused(value: boolean) { focused = value; input.focused = editing !== undefined && value; },
        invalidate() { input.invalidate(); },
        handleInput(data: string) {
            const settings = handlers.get();
            if (editing) {
                input.handleInput(data);
                requestRender();
                return;
            }
            const rows = rowsOf(settings);
            row = Math.min(row, rows.length - 1);
            const selected = rows[row]!;
            if (Tui.matchesKey(data, Tui.Key.escape)) close();
            else if (Tui.matchesKey(data, Tui.Key.up)) row = Math.max(0, row - 1);
            else if (Tui.matchesKey(data, Tui.Key.down)) row = Math.min(rows.length - 1, row + 1);
            else if (selected.kind === "path" && (data === "x" || Tui.matchesKey(data, Tui.Key.delete))) {
                removePath(settings, selected.index);
                row = Math.min(row, rowsOf(handlers.get()).length - 1);
            } else if (Tui.matchesKey(data, Tui.Key.enter) || data === " ") action(settings, selected);
            else if (Tui.matchesKey(data, "ctrl+s")) {
                const result = handlers.save();
                if (result.ok) {
                    rememberedSkillPaths = settings.skillsMode === "explicit" ? [...settings.skillsPaths] : undefined;
                }
                report(result.message, !result.ok);
            }
            requestRender();
        },
        render(width: number) {
            const settings = handlers.get();
            const rows = rowsOf(settings);
            row = Math.min(row, rows.length - 1);
            const w = Math.max(1, Math.floor(width));
            const compact = w < 40;
            const valueWidth = Math.max(1, w - LABEL_WIDTH - 1);
            const highlight = (text: string, selected: boolean): string => selected
                ? theme.bg("selectedBg", theme.bold(cell(text, w))) : text;
            const marker = (selected: boolean) => selected ? "> " : "  ";
            const source = skillSource(settings);
            const lines: string[] = [theme.fg("accent", theme.bold("  Subagent settings")), ""];

            const pushSetting = (label: string, value: string, selected: boolean, active: string): void => {
                const title = theme.fg(selected ? "accent" : "text", marker(selected) + label);
                if (compact) {
                    lines.push(highlight(title, selected));
                    lines.push("  " + (selected ? theme.inverse(active) : theme.fg("text", active)));
                } else {
                    lines.push(highlight(cell(title, LABEL_WIDTH) + " " +
                        (selected ? theme.inverse(active) : theme.fg("text", active)), selected));
                }
            };

            rows.forEach((entry, index) => {
                const selected = index === row;
                if (entry.kind === "mode" || entry.kind === "cap") {
                    const label = entry.kind === "mode" ? "Delegation mode" : "Concurrent subagents";
                    const value = entry.kind === "mode" ? settings.mode : String(settings.maxConcurrent);
                    const active = editing?.kind === "cap" && entry.kind === "cap"
                        ? input.render(compact ? Math.max(1, w - 2) : valueWidth)[0]!
                        : value;
                    pushSetting(label, value, selected, active);
                } else if (entry.kind === "skills") {
                    pushSetting("Skill exposure", skillLabel(settings.skillsMode), selected, skillLabel(settings.skillsMode));
                    const sourceLine = compact ? "    " + source : " ".repeat(LABEL_WIDTH) + " " + source;
                    lines.push(theme.fg(settings.skillsError ? "error" : "muted",
                        Tui.truncateToWidth(sourceLine, w, "")));
                } else if (entry.kind === "path") {
                    if (selected && editing?.kind === "skill" && editing.index === entry.index) {
                        lines.push(input.render(w)[0]!);
                    } else {
                        const indent = selected ? ">   " : "    ";
                        const line = indent + Tui.truncateToWidth(entry.path, Math.max(1, w - 4), "");
                        lines.push(selected ? highlight(line, true) : theme.fg("text", line));
                    }
                } else if (entry.kind === "add") {
                    if (selected && editing?.kind === "add") {
                        lines.push(input.render(w)[0]!);
                    } else {
                        const text = marker(selected) + "  + Add a skill path";
                        lines.push(selected ? highlight(text, true) : theme.fg("dim", text));
                    }
                } else if (entry.kind === "agents") {
                    lines.push(highlight(theme.fg(selected ? "accent" : "text", marker(selected) + "Agents"), selected));
                } else {
                    lines.push("");
                    lines.push(highlight(theme.fg(selected ? "accent" : "text", marker(selected) + "Reset to defaults"), selected));
                }
            });

            if (message) lines.push("", theme.fg(error ? "error" : "muted", message));
            const removeHint = settings.skillsMode === "explicit" && !editing ? " · x Remove path" : "";
            lines.push("", theme.fg("dim", editing
                ? "Enter Apply · Esc Cancel"
                : `Up/Down Select · Space/Enter Change · ctrl+s Save default${removeHint} · Esc Back`));
            return lines.map((line) => Tui.truncateToWidth(line, w, ""));
        },
    };
}
