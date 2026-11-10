import type { Theme } from "@earendil-works/pi-coding-agent";
import * as Tui from "@earendil-works/pi-tui";
import { isConcurrencyCap } from "./config.ts";
import { DELEGATION_MODES, type DelegationMode } from "./delegation.ts";
import type { SkillExposureMode } from "./skills.ts";
import { createSkillPicker, type DiscoveredSkill } from "./skill-picker.ts";
import { validatedTimingMinutes } from "./timing.ts";

export type TimingSettingKey = "toolWaitMinutes" | "stuckMinutes";

export interface SubagentSettingsSnapshot {
    mode: DelegationMode;
    maxConcurrent: number;
    modeSource: "session" | "config";
    capSource: "session" | "config";
    defaultMode: DelegationMode;
    defaultCap: number;
    toolWaitMinutes: number;
    stuckMinutes: number;
    toolWaitSource: "session" | "config" | "default";
    stuckSource: "session" | "config" | "default";
    defaultToolWaitMinutes: number;
    defaultStuckMinutes: number;
    /** A saved timing value the launcher cannot read, kept visible rather than hidden. */
    timingError?: string;
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
    changeTiming(key: TimingSettingKey, minutes: number): void;
    changeSkills(mode: SkillExposureMode, paths: readonly string[]): void;
    /** Loaded Pi skill metadata for the checkbox picker. Absent means manual paths only. */
    discoverSkills?(): readonly DiscoveredSkill[];
    save(): { ok: boolean; message: string };
    reset(): void;
    /** Opens the same catalog as `/agents`. The caller closes this page first. */
    openAgents?(): void;
}

type EditTarget = { kind: "cap" } | { kind: "toolWait" } | { kind: "stuck" };

type Row =
    | { kind: "mode" }
    | { kind: "cap" }
    | { kind: "toolWait" }
    | { kind: "stuck" }
    | { kind: "skills" }
    | { kind: "choose" }
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

function cycleSkillMode(mode: SkillExposureMode): SkillExposureMode {
    return mode === "inherit" ? "none" : "inherit";
}

function skillSource(settings: SubagentSettingsSnapshot): string {
    if (settings.skillsError) return `Config error: ${settings.skillsError}`;
    if (settings.skillsSource === "session") return "Source: this session (unsaved)";
    if (settings.skillsSource === "config") return "Source: config defaultSkills";
    return "Source: discovery default";
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
    getHeight: () => number = () => process.stdout.rows ?? 30,
): Tui.Component & Tui.Focusable {
    const input = new Tui.Input();
    let focused = false;
    let row = 0;
    let editing: EditTarget | undefined;
    let picker: ReturnType<typeof createSkillPicker> | undefined;
    let rememberedSkillPaths: string[] | undefined;
    let viewportStart = 0;
    let message = "";
    let error = false;

    function report(text: string, failed = false): void {
        message = text;
        error = failed;
        requestRender();
    }

    function rowsOf(settings: SubagentSettingsSnapshot): Row[] {
        const rows: Row[] = [
            { kind: "mode" }, { kind: "cap" }, { kind: "toolWait" }, { kind: "stuck" },
            { kind: "skills" }, { kind: "choose" },
        ];
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

    function openSkillPicker(initial: readonly string[], previousMode: SkillExposureMode): void {
        picker = createSkillPicker({
            theme,
            skills: handlers.discoverSkills?.() ?? [],
            selected: initial,
            requestRender,
            getHeight,
            title: "Selected skills",
            apply(paths) {
                try {
                    if (paths.length === 0) {
                        handlers.changeSkills("none", []);
                        rememberedSkillPaths = [];
                        report("No skills checked. Skill exposure set to No skill catalog.");
                        return { ok: true, message: "No skill catalog selected." };
                    }
                    handlers.changeSkills("explicit", paths);
                    rememberedSkillPaths = [...paths];
                    report(`${paths.length} skill${paths.length === 1 ? "" : "s"} selected.`);
                    return { ok: true, message: `${paths.length} selected.` };
                } catch (cause) {
                    return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
                }
            },
            finish() { picker = undefined; requestRender(); },
            cancel() {
                picker = undefined;
                report(previousMode === "explicit" ? "Skill selection unchanged." : "Skill mode unchanged.");
                requestRender();
            },
        });
        picker.focused = focused;
        requestRender();
    }

    function action(settings: SubagentSettingsSnapshot, selected: Row): void {
        try {
            if (selected.kind === "mode") {
                const next = DELEGATION_MODES[(DELEGATION_MODES.indexOf(settings.mode) + 1) % DELEGATION_MODES.length]!;
                handlers.changeMode(next);
                report("Session mode updated.");
            } else if (selected.kind === "cap") {
                startEditing({ kind: "cap" }, String(settings.maxConcurrent));
            } else if (selected.kind === "toolWait") {
                startEditing({ kind: "toolWait" }, String(settings.toolWaitMinutes));
            } else if (selected.kind === "stuck") {
                startEditing({ kind: "stuck" }, String(settings.stuckMinutes));
            } else if (selected.kind === "skills") {
                if (settings.skillsMode === "explicit") rememberedSkillPaths = [...settings.skillsPaths];
                const next = cycleSkillMode(settings.skillsMode);
                handlers.changeSkills(next, []);
                report(`Skill exposure: ${skillLabel(next).toLowerCase()}.`);
            } else if (selected.kind === "choose") {
                openSkillPicker(
                    settings.skillsMode === "explicit" ? settings.skillsPaths : rememberedSkillPaths ?? [],
                    settings.skillsMode,
                );
                return;
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
        const key = target.kind === "toolWait" ? "toolWaitMinutes" : "stuckMinutes";
        try {
            const minutes = validatedTimingMinutes(value.trim(), key);
            handlers.changeTiming(key, minutes);
            finishEditing(`${target.kind === "toolWait" ? "Tool-wait" : "No-progress"} alert updated.`);
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
        set focused(value: boolean) {
            focused = value;
            input.focused = editing !== undefined && value;
            if (picker) picker.focused = value;
        },
        invalidate() { input.invalidate(); picker?.invalidate(); },
        handleInput(data: string) {
            if (picker) {
                picker.handleInput(data);
                requestRender();
                return;
            }
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
            else if (Tui.matchesKey(data, Tui.Key.enter) || data === " ") action(settings, selected);
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
            if (picker) return picker.render(width);
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

            let selectedStart = 2;
            let selectedEnd = 3;
            rows.forEach((entry, index) => {
                const selected = index === row;
                if (selected) selectedStart = lines.length;
                if (entry.kind === "mode" || entry.kind === "cap" || entry.kind === "toolWait" || entry.kind === "stuck") {
                    const label = entry.kind === "mode" ? "Delegation mode"
                        : entry.kind === "cap" ? "Concurrent subagents"
                        : entry.kind === "toolWait" ? "Tool-wait alert" : "No-progress alert";
                    const value = entry.kind === "mode" ? settings.mode
                        : entry.kind === "cap" ? String(settings.maxConcurrent)
                        : `${entry.kind === "toolWait" ? settings.toolWaitMinutes : settings.stuckMinutes} min`;
                    const active = editing?.kind === entry.kind
                        ? input.render(compact ? Math.max(1, w - 2) : valueWidth)[0]!
                        : value;
                    pushSetting(label, value, selected, active);
                    if (entry.kind === "stuck" && settings.timingError) {
                        const sourceLine = compact ? "    " + settings.timingError : " ".repeat(LABEL_WIDTH) + " " + settings.timingError;
                        lines.push(theme.fg("error", Tui.truncateToWidth(sourceLine, w, "")));
                    }
                } else if (entry.kind === "skills") {
                    pushSetting("Skill exposure", skillLabel(settings.skillsMode), selected, skillLabel(settings.skillsMode));
                    const sourceLine = compact ? "    " + source : " ".repeat(LABEL_WIDTH) + " " + source;
                    lines.push(theme.fg(settings.skillsError ? "error" : "muted",
                        Tui.truncateToWidth(sourceLine, w, "")));
                } else if (entry.kind === "choose") {
                    const value = settings.skillsMode === "explicit" ? `${settings.skillsPaths.length} checked` : "Choose…";
                    pushSetting("Selected skills", value, selected, value);
                } else if (entry.kind === "agents") {
                    lines.push(highlight(theme.fg(selected ? "accent" : "text", marker(selected) + "Agents"), selected));
                } else {
                    lines.push("");
                    lines.push(highlight(theme.fg(selected ? "accent" : "text", marker(selected) + "Reset to defaults"), selected));
                }
                if (selected) selectedEnd = lines.length;
            });

            const body = lines.slice(2);
            const footer: string[] = [];
            if (message) footer.push("", theme.fg(error ? "error" : "muted", message));
            footer.push("", theme.fg("dim", editing
                ? "Enter Apply · Esc Cancel"
                : "Up/Down Select · Space/Enter Change · ctrl+s Save default · Esc Back"));
            const height = Math.max(1, Math.floor(getHeight()));
            const room = Math.max(1, height - 2 - footer.length);
            if (selectedEnd - 2 > viewportStart + room) viewportStart = selectedEnd - 2 - room;
            if (selectedStart - 2 < viewportStart) viewportStart = selectedStart - 2;
            viewportStart = Math.max(0, Math.min(viewportStart, body.length - room));
            const visible = [...lines.slice(0, 2), ...body.slice(viewportStart, viewportStart + room), ...footer];
            // A very short terminal prioritizes the active control over chrome.
            const result = height < 2 + footer.length + 1 ? body.slice(selectedStart - 2, selectedStart - 2 + height) : visible;
            return result.map((line) => Tui.truncateToWidth(line, w, ""));
        },
    };
}
