import type { Theme } from "@earendil-works/pi-coding-agent";
import * as Tui from "@earendil-works/pi-tui";
import { isConcurrencyCap } from "./config.ts";
import { DELEGATION_MODES, type DelegationMode } from "./delegation.ts";
import type { SkillExposureMode } from "./skills.ts";
import { createSkillPicker, type DiscoveredSkill } from "./skill-picker.ts";
import { isTimingMinutes, validatedTimingMinutes } from "./timing.ts";

export type TimingSettingKey = "maxMinutes" | "toolWaitMinutes" | "stuckMinutes";

export interface SubagentSettingsSnapshot {
    mode: DelegationMode;
    gitWorkspace: "clone" | "worktree";
    maxConcurrent: number;
    maxMinutes: number;
    modeSource: "session" | "config";
    capSource: "session" | "config";
    defaultMode: DelegationMode;
    defaultCap: number;
    toolWaitMinutes: number;
    stuckMinutes: number;
    toolWaitSource: "environment" | "session" | "config" | "default";
    stuckSource: "environment" | "session" | "config" | "default";
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
    changeWorkspace(mode: "clone" | "worktree"): void;
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
    settingsChanged?(): void;
}

type EditTarget = { kind: "cap" } | { kind: "toolWait" } | { kind: "stuck" } | { kind: "timeout" };

const rows = [
    { section: "Delegation", kind: "mode", label: "Delegation mode" },
    { section: "Delegation", kind: "cap", label: "Concurrent subagents" },
    { section: "Delegation", kind: "workspace", label: "Git workspace" },
    { section: "Run limits & alerts", kind: "timeout", label: "Run timeout" },
    { section: "Run limits & alerts", kind: "toolWait", label: "Tool-wait alert" },
    { section: "Run limits & alerts", kind: "stuck", label: "No-progress alert" },
    { section: "Skills & agents", kind: "skills", label: "Skill exposure" },
    { section: "Skills & agents", kind: "choose", label: "Selected skills" },
    { section: "Skills & agents", kind: "agents", label: "Agent catalog" },
    { section: "Session defaults", kind: "reset", label: "Reset to defaults" },
] as const;

type Row = typeof rows[number];
const labelWidth = Math.max(...rows.map(({ label }) => Tui.visibleWidth(label)));

const SKILL_MODES: readonly { mode: SkillExposureMode; label: string }[] = [
    { mode: "inherit", label: "Discover automatically" },
    { mode: "none", label: "No skill catalog" },
    { mode: "explicit", label: "Selected skills" },
];

const MAX_TIMEOUT = "24 hours";

function parseRunTimeout(input: string): number {
    const text = input.trim();
    if (["no limit", MAX_TIMEOUT].includes(text.toLowerCase())) return 0;
    const minutes = Number(text);
    if (!text || !isTimingMinutes(minutes) || minutes > 1440) {
        throw new Error("Enter 24 hours or a duration up to 1440 minutes.");
    }
    return minutes;
}

function skillLabel(mode: SkillExposureMode): string {
    return SKILL_MODES.find((entry) => entry.mode === mode)!.label;
}

function cycleSkillMode(mode: SkillExposureMode): SkillExposureMode {
    return mode === "inherit" ? "none" : "inherit";
}

function skillSource(settings: SubagentSettingsSnapshot): string {
    if (settings.skillsSource === "session") return "Source: this session (unsaved)";
    if (settings.skillsSource === "config") return "Source: config defaultSkills";
    return "Source: discovery default";
}

function settingValue(kind: Row["kind"], s: SubagentSettingsSnapshot): string {
    switch (kind) {
        case "mode": return s.mode;
        case "cap": return String(s.maxConcurrent);
        case "workspace": return s.gitWorkspace === "worktree" ? "Worktree" : "Clone";
        case "timeout": return s.maxMinutes === 0 || s.maxMinutes >= 1440 ? MAX_TIMEOUT : `${s.maxMinutes} min`;
        case "toolWait": return s.toolWaitMinutes === 0 ? "Off" : `${s.toolWaitMinutes} min`;
        case "stuck": return s.stuckMinutes === 0 ? "Off" : `${s.stuckMinutes} min`;
        case "skills": return skillLabel(s.skillsMode);
        case "choose": return s.skillsMode === "explicit" ? `${s.skillsPaths.length} checked ›` : "›";
        case "agents": return "›";
        case "reset": return "";
    }
}

function description(kind: Row["kind"], s: SubagentSettingsSnapshot): string {
    switch (kind) {
        case "mode": return {
            manual: "Delegate when you ask or when the active workflow requires it.",
            adaptive: "Delegate independent work when a suitable agent is available.",
            coordinator: "Delegate work covered by an agent role. Keep coordination and verification in the foreground.",
        }[s.mode];
        case "cap": return "Set how many subagents can run at the same time.";
        case "workspace": return s.gitWorkspace === "worktree"
            ? "Create a linked worktree that shares the repository’s Git metadata."
            : "Create a separate local clone for each isolated Git workspace.";
        case "timeout": return "Stop a subagent when its run reaches this limit. The maximum is 24 hours.";
        case "toolWait": return "Notify the parent when a tool call stays open this long. Enter 0 to turn this alert off.";
        case "stuck": return "Notify the parent after this long without progress. Time spent waiting for a tool is excluded. Enter 0 to turn this alert off.";
        case "skills": return "Choose how new subagents discover skills.\n" + skillSource(s);
        case "choose": return "Choose the skills to load for new subagents.";
        case "agents": return "Browse agent roles and edit their profiles in /agents.";
        case "reset": return "Restore saved defaults for this session, including its workspace, limits, and skills.";
    }
}

function primaryKey(action: Tui.Keybinding, excludeSpace = false): string | undefined {
    const key = Tui.getKeybindings().getKeys(action).find(key => !excludeSpace || key !== "space");
    if (!key) return undefined;
    if (key === "escape") return "Esc";
    return key.split("+").map(part => part.length === 1 ? part : part[0]!.toUpperCase() + part.slice(1)).join("+");
}

function shortcuts(kind: Row["kind"], editing: boolean): string {
    const cancel = primaryKey("tui.select.cancel");
    const confirm = primaryKey(editing ? "tui.input.submit" : "tui.select.confirm", !editing);
    const change = confirm ? `${confirm}/Space` : "Space";
    const verb = kind === "agents" || kind === "choose" ? "open" : kind === "reset" ? "restore" : "change";
    const actions = editing ? [confirm && `${confirm} to apply`]
        : kind === "timeout" ? ["Space for 24 hours", confirm && `${confirm} to edit minutes`]
        : [`${change} to ${verb}`];
    if (!editing) actions.push("Ctrl+S to save defaults");
    if (cancel) actions.push(`${cancel} to ${editing ? "cancel" : "go back"}`);
    return actions.filter(Boolean).join(" · ");
}

export function createSubagentSettingsPage(
    theme: Theme,
    handlers: SubagentSettingsHandlers,
    requestRender: () => void,
    close: () => void,
    getHeight: () => number = () => process.stdout.rows ?? 30,
    selected?: Row["kind"],
): Tui.Component & Tui.Focusable {
    const input = new Tui.Input();
    let settings = handlers.get();
    let focused = false;
    let row = Math.max(0, rows.findIndex(entry => entry.kind === selected));
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

    function reportChange(text: string): void {
        settings = handlers.get();
        handlers.settingsChanged?.();
        report(text);
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
        reportChange(text);
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
                        reportChange("No skills checked. Skill exposure set to No skill catalog.");
                        return { ok: true, message: "No skill catalog selected." };
                    }
                    handlers.changeSkills("explicit", paths);
                    rememberedSkillPaths = [...paths];
                    reportChange(`${paths.length} skill${paths.length === 1 ? "" : "s"} selected.`);
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

    function action(selected: Row, key: string): void {
        try {
            // Defaults may have changed in a second Pi session since this page opened.
            settings = handlers.get();
            if (selected.kind === "workspace") {
                handlers.changeWorkspace(settings.gitWorkspace === "worktree" ? "clone" : "worktree");
                reportChange("Session workspace updated.");
            } else if (selected.kind === "mode") {
                const next = DELEGATION_MODES[(DELEGATION_MODES.indexOf(settings.mode) + 1) % DELEGATION_MODES.length]!;
                handlers.changeMode(next);
                reportChange("Session mode updated.");
            } else if (selected.kind === "cap") {
                startEditing({ kind: "cap" }, String(settings.maxConcurrent));
            } else if (selected.kind === "toolWait") {
                startEditing({ kind: "toolWait" }, String(settings.toolWaitMinutes));
            } else if (selected.kind === "stuck") {
                startEditing({ kind: "stuck" }, String(settings.stuckMinutes));
            } else if (selected.kind === "timeout") {
                if (key === " ") {
                    handlers.changeTiming("maxMinutes", 0);
                    reportChange("Run timeout set to 24 hours.");
                } else {
                    startEditing(selected, settings.maxMinutes === 0 || settings.maxMinutes >= 1440 ? MAX_TIMEOUT : String(settings.maxMinutes));
                }
            } else if (selected.kind === "skills") {
                if (settings.skillsMode === "explicit") rememberedSkillPaths = [...settings.skillsPaths];
                const next = cycleSkillMode(settings.skillsMode);
                handlers.changeSkills(next, []);
                reportChange(`Skill exposure: ${skillLabel(next).toLowerCase()}.`);
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
                reportChange("Session settings reset to saved defaults.");
            }
        } catch (cause) {
            report(cause instanceof Error ? cause.message : String(cause), true);
        }
    }

    const submit = (value: string) => {
        const target = editing;
        if (!target) return;
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
        const key = target.kind === "toolWait" ? "toolWaitMinutes"
            : target.kind === "stuck" ? "stuckMinutes" : "maxMinutes";
        try {
            const minutes = target.kind === "timeout" ? parseRunTimeout(value) : validatedTimingMinutes(value.trim(), key);
            handlers.changeTiming(key, minutes);
            finishEditing(target.kind === "toolWait" ? "Tool-wait alert updated."
                : target.kind === "stuck" ? "No-progress alert updated." : "Timeout updated.");
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
        invalidate() {
            settings = handlers.get();
            input.invalidate();
            picker?.invalidate();
        },
        handleInput(data: string) {
            if (picker) {
                picker.handleInput(data);
                requestRender();
                return;
            }
            if (editing) {
                input.handleInput(data);
                requestRender();
                return;
            }
            const selected = rows[row]!;
            const keys = Tui.getKeybindings();
            if (keys.matches(data, "tui.select.cancel")) close();
            else if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down")) {
                row = Math.max(0, Math.min(rows.length - 1, row + (keys.matches(data, "tui.select.up") ? -1 : 1)));
                message = "";
            } else if (keys.matches(data, "tui.select.confirm") || data === " ") action(selected, data);
            else if (Tui.matchesKey(data, "ctrl+s")) {
                const result = handlers.save();
                if (result.ok) {
                    rememberedSkillPaths = settings.skillsMode === "explicit" ? [...settings.skillsPaths] : undefined;
                    reportChange(result.message);
                } else report(result.message, true);
            }
            requestRender();
        },
        render(width: number) {
            if (picker) return picker.render(width);
            const w = Math.max(1, Math.floor(width));
            const height = Math.max(1, Math.floor(getHeight()));
            const valueColumn = 2 + labelWidth + 2;
            const body: string[] = [];
            let selectedStart = 0;
            let selectedEnd = 0;
            for (const [index, entry] of rows.entries()) {
                const startsSection = rows[index - 1]?.section !== entry.section;
                if (startsSection) {
                    if (index > 0) body.push("");
                    body.push(theme.fg("muted", theme.bold(entry.section)));
                }
                const active = index === row;
                const value = settingValue(entry.kind, settings);
                const stacked = valueColumn + Math.max(Tui.visibleWidth(value), editing?.kind === entry.kind ? 8 : 0) > w;
                const column = stacked ? Math.min(4, Math.max(0, w - 1)) : valueColumn;
                const valueText = editing?.kind === entry.kind
                    ? input.render(Math.max(1, w - column))[0] ?? ""
                    : active && entry.kind !== "choose" && entry.kind !== "agents" ? theme.inverse(value) : theme.fg(active ? "accent" : "muted", value);
                const label = (active ? "> " : "  ") + theme.fg(active ? "accent" : "text", entry.label);
                if (active) selectedStart = body.length;
                if (!value) {
                    body.push(label);
                } else if (stacked) {
                    const valueLines = Tui.wrapTextWithAnsi(valueText, Math.max(1, w - column));
                    body.push(label, ...valueLines.map(line => " ".repeat(column) + line));
                } else {
                    body.push(label + " ".repeat(valueColumn - Tui.visibleWidth(label)) + valueText);
                }
                if (active) selectedEnd = body.length;
            }

            const selected = rows[row]!.kind;
            const hint = shortcuts(selected, editing !== undefined);
            const wrap = (text: string, color: Parameters<Theme["fg"]>[0]) =>
                Tui.wrapTextWithAnsi(text, Math.max(1, w - 2)).map(line => "  " + theme.fg(color, line));
            const help = wrap(description(selected, settings), "text");
            const feedback = [
                ...(settings.timingError ? wrap(settings.timingError, "error") : []),
                ...(settings.skillsError ? wrap(`Config error: ${settings.skillsError}`, "error") : []),
                ...(message ? wrap(message, error ? "error" : "muted") : []),
            ];
            const title = theme.bold(theme.fg("text", "Subagent settings"));
            const header = height >= 6 ? [title, ""] : [];
            // Reserve space for the focused control and validation before its help or shortcuts.
            const footerRoom = Math.max(0, height - header.length - (selectedEnd - selectedStart));
            const status = feedback.slice(0, footerRoom);
            const hints = wrap(hint, "dim");
            const footer = [...help, "", ...hints];
            const budget = footerRoom - status.length;
            const visibleHelp = footer.length + 1 <= budget ? ["", ...footer]
                : editing ? hints.slice(0, budget) : help.slice(0, Math.min(budget, 2));
            const room = Math.max(1, height - header.length - visibleHelp.length - status.length);
            viewportStart = Math.max(0, Math.min(viewportStart, body.length - room));
            if (selectedEnd > viewportStart + room) viewportStart = selectedEnd - room;
            if (selectedStart < viewportStart) viewportStart = selectedStart;
            return [...header, ...body.slice(viewportStart, viewportStart + room), ...visibleHelp, ...status]
                .map(line => Tui.truncateToWidth(line, w, ""));
        },
    };
}
