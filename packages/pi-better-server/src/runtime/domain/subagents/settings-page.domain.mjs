// Generated fixed launch domain from packages/pi-better-subagents/settings-page.ts. Do not edit directly.
import * as Tui from "@earendil-works/pi-tui";
import { isConcurrencyCap } from "./config.domain.mjs";
import { DELEGATION_MODES } from "./delegation.domain.mjs";
import { createSkillPicker } from "./skill-picker.domain.mjs";
import { isTimingMinutes, MAX_TIMING_MINUTES, validatedTimingMinutes } from "./timing.domain.mjs";
const SKILL_MODES = [
    { mode: "inherit", label: "Discover automatically" },
    { mode: "none", label: "No skill catalog" },
    { mode: "explicit", label: "Selected skills" },
];
const LABEL_WIDTH = 26;
const NO_LIMIT = "No limit";
function parseRunTimeout(input) {
    const text = input.trim();
    if (text.toLowerCase() === NO_LIMIT.toLowerCase())
        return 0;
    const minutes = Number(text);
    if (!text || !isTimingMinutes(minutes)) {
        throw new Error(`Enter No limit or a duration up to ${MAX_TIMING_MINUTES} minutes.`);
    }
    return minutes;
}
function skillLabel(mode) {
    return SKILL_MODES.find((entry) => entry.mode === mode).label;
}
function cycleSkillMode(mode) {
    return mode === "inherit" ? "none" : "inherit";
}
function skillSource(settings) {
    if (settings.skillsError)
        return `Config error: ${settings.skillsError}`;
    if (settings.skillsSource === "session")
        return "Source: this session (unsaved)";
    if (settings.skillsSource === "config")
        return "Source: config defaultSkills";
    return "Source: discovery default";
}
function cell(text, width) {
    const clipped = Tui.truncateToWidth(text, width, "");
    return clipped + " ".repeat(Math.max(0, width - Tui.visibleWidth(clipped)));
}
export function createSubagentSettingsPage(theme, handlers, requestRender, close, getHeight = () => process.stdout.rows ?? 30) {
    const input = new Tui.Input();
    let focused = false;
    let row = 0;
    let editing;
    let picker;
    let rememberedSkillPaths;
    let viewportStart = 0;
    let message = "";
    let error = false;
    function report(text, failed = false) {
        message = text;
        error = failed;
        requestRender();
    }
    function rowsOf(settings) {
        const rows = [
            { kind: "mode" }, { kind: "cap" }, { kind: "toolWait" }, { kind: "stuck" }, { kind: "timeout" },
            { kind: "skills" }, { kind: "choose" },
        ];
        rows.push({ kind: "agents" }, { kind: "workspace" }, { kind: "reset" });
        return rows;
    }
    function startEditing(target, value) {
        editing = target;
        input.setValue(value);
        input.handleInput("\x05");
        input.focused = focused;
        report(target.kind === "timeout" ? "Enter minutes or No limit." : "");
    }
    function finishEditing(text) {
        input.focused = false;
        editing = undefined;
        report(text);
    }
    function openSkillPicker(initial, previousMode) {
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
                }
                catch (cause) {
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
    function action(settings, selected, key) {
        try {
            if (selected.kind === "workspace") {
                handlers.changeWorkspace(settings.gitWorkspace === "worktree" ? "clone" : "worktree");
            }
            else if (selected.kind === "mode") {
                const next = DELEGATION_MODES[(DELEGATION_MODES.indexOf(settings.mode) + 1) % DELEGATION_MODES.length];
                handlers.changeMode(next);
                report("Session mode updated.");
            }
            else if (selected.kind === "cap") {
                startEditing({ kind: "cap" }, String(settings.maxConcurrent));
            }
            else if (selected.kind === "toolWait") {
                startEditing({ kind: "toolWait" }, String(settings.toolWaitMinutes));
            }
            else if (selected.kind === "stuck") {
                startEditing({ kind: "stuck" }, String(settings.stuckMinutes));
            }
            else if (selected.kind === "timeout") {
                if (key === " ") {
                    handlers.changeTiming("maxMinutes", 0);
                    report("Run timeout set to No limit.");
                }
                else {
                    startEditing(selected, settings.maxMinutes === 0 ? NO_LIMIT : String(settings.maxMinutes));
                }
            }
            else if (selected.kind === "skills") {
                if (settings.skillsMode === "explicit")
                    rememberedSkillPaths = [...settings.skillsPaths];
                const next = cycleSkillMode(settings.skillsMode);
                handlers.changeSkills(next, []);
                report(`Skill exposure: ${skillLabel(next).toLowerCase()}.`);
            }
            else if (selected.kind === "choose") {
                openSkillPicker(settings.skillsMode === "explicit" ? settings.skillsPaths : rememberedSkillPaths ?? [], settings.skillsMode);
                return;
            }
            else if (selected.kind === "agents") {
                handlers.openAgents?.();
            }
            else {
                handlers.reset();
                rememberedSkillPaths = undefined;
                report("Session settings reset to saved defaults.");
            }
        }
        catch (cause) {
            report(cause instanceof Error ? cause.message : String(cause), true);
        }
    }
    const submit = (value) => {
        const target = editing;
        if (!target)
            return;
        if (target.kind === "cap") {
            const cap = /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
            if (!isConcurrencyCap(cap)) {
                report("Enter a positive whole number.", true);
                return;
            }
            try {
                handlers.changeCap(cap);
                finishEditing("Session cap updated.");
            }
            catch (cause) {
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
        }
        catch (cause) {
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
        set focused(value) {
            focused = value;
            input.focused = editing !== undefined && value;
            if (picker)
                picker.focused = value;
        },
        invalidate() { input.invalidate(); picker?.invalidate(); },
        handleInput(data) {
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
            const selected = rows[row];
            if (Tui.matchesKey(data, Tui.Key.escape))
                close();
            else if (Tui.matchesKey(data, Tui.Key.up))
                row = Math.max(0, row - 1);
            else if (Tui.matchesKey(data, Tui.Key.down))
                row = Math.min(rows.length - 1, row + 1);
            else if (Tui.matchesKey(data, Tui.Key.enter) || data === " ")
                action(settings, selected, data);
            else if (Tui.matchesKey(data, "ctrl+s")) {
                const result = handlers.save();
                if (result.ok) {
                    rememberedSkillPaths = settings.skillsMode === "explicit" ? [...settings.skillsPaths] : undefined;
                }
                report(result.message, !result.ok);
            }
            requestRender();
        },
        render(width) {
            if (picker)
                return picker.render(width);
            const settings = handlers.get();
            const rows = rowsOf(settings);
            row = Math.min(row, rows.length - 1);
            const w = Math.max(1, Math.floor(width));
            const compact = w < 40;
            const valueWidth = Math.max(1, w - LABEL_WIDTH - 1);
            const highlight = (text, selected) => selected
                ? theme.bg("selectedBg", theme.bold(cell(text, w))) : text;
            const marker = (selected) => selected ? "> " : "  ";
            const source = skillSource(settings);
            const lines = [theme.fg("accent", theme.bold("  Subagent settings")), ""];
            const pushSetting = (label, value, selected, active) => {
                const title = theme.fg(selected ? "accent" : "text", marker(selected) + label);
                if (compact) {
                    lines.push(highlight(title, selected));
                    lines.push("  " + (selected ? theme.inverse(active) : theme.fg("text", active)));
                }
                else {
                    lines.push(highlight(cell(title, LABEL_WIDTH) + " " +
                        (selected ? theme.inverse(active) : theme.fg("text", active)), selected));
                }
            };
            let selectedStart = 2;
            let selectedEnd = 3;
            rows.forEach((entry, index) => {
                const selected = index === row;
                if (selected)
                    selectedStart = lines.length;
                if (entry.kind === "mode" || entry.kind === "cap" || entry.kind === "toolWait"
                    || entry.kind === "stuck" || entry.kind === "timeout") {
                    const label = entry.kind === "mode" ? "Delegation mode"
                        : entry.kind === "cap" ? "Concurrent subagents"
                            : entry.kind === "toolWait" ? "Tool-wait alert"
                                : entry.kind === "stuck" ? "No-progress alert" : "Run timeout";
                    const value = entry.kind === "mode" ? settings.mode
                        : entry.kind === "cap" ? String(settings.maxConcurrent)
                            : entry.kind === "timeout" ? (settings.maxMinutes === 0 ? NO_LIMIT : `${settings.maxMinutes} min`)
                                : `${entry.kind === "toolWait" ? settings.toolWaitMinutes : settings.stuckMinutes} min`;
                    const active = editing?.kind === entry.kind
                        ? input.render(compact ? Math.max(1, w - 2) : valueWidth)[0]
                        : value;
                    pushSetting(label, value, selected, active);
                    if (entry.kind === "stuck" && settings.timingError) {
                        const sourceLine = compact ? "    " + settings.timingError : " ".repeat(LABEL_WIDTH) + " " + settings.timingError;
                        lines.push(theme.fg("error", Tui.truncateToWidth(sourceLine, w, "")));
                    }
                }
                else if (entry.kind === "skills") {
                    pushSetting("Skill exposure", skillLabel(settings.skillsMode), selected, skillLabel(settings.skillsMode));
                    const sourceLine = compact ? "    " + source : " ".repeat(LABEL_WIDTH) + " " + source;
                    lines.push(theme.fg(settings.skillsError ? "error" : "muted", Tui.truncateToWidth(sourceLine, w, "")));
                }
                else if (entry.kind === "choose") {
                    const value = settings.skillsMode === "explicit" ? `${settings.skillsPaths.length} checked` : "Choose…";
                    pushSetting("Selected skills", value, selected, value);
                }
                else if (entry.kind === "workspace") {
                    const value = settings.gitWorkspace === "worktree" ? "Worktree" : "Clone";
                    pushSetting("Git workspace", value, selected, value);
                }
                else if (entry.kind === "agents") {
                    lines.push(highlight(theme.fg(selected ? "accent" : "text", marker(selected) + "Agents"), selected));
                }
                else {
                    lines.push("");
                    lines.push(highlight(theme.fg(selected ? "accent" : "text", marker(selected) + "Reset to defaults"), selected));
                }
                if (selected)
                    selectedEnd = lines.length;
            });
            const body = lines.slice(2);
            const footer = [];
            if (message)
                footer.push("", theme.fg(error ? "error" : "muted", message));
            const hint = editing
                ? "Enter Apply · Esc Cancel"
                : rows[row]?.kind === "timeout"
                    ? "Space No limit · Enter Edit minutes · ctrl+s Save default · Esc Back"
                    : "Up/Down Select · Space/Enter Change · ctrl+s Save default · Esc Back";
            footer.push("", theme.fg("dim", hint));
            const height = Math.max(1, Math.floor(getHeight()));
            const room = Math.max(1, height - 2 - footer.length);
            if (selectedEnd - 2 > viewportStart + room)
                viewportStart = selectedEnd - 2 - room;
            if (selectedStart - 2 < viewportStart)
                viewportStart = selectedStart - 2;
            viewportStart = Math.max(0, Math.min(viewportStart, body.length - room));
            const visible = [...lines.slice(0, 2), ...body.slice(viewportStart, viewportStart + room), ...footer];
            // A very short terminal prioritizes the active control over chrome.
            const result = height < 2 + footer.length + 1 ? body.slice(selectedStart - 2, selectedStart - 2 + height) : visible;
            return result.map((line) => Tui.truncateToWidth(line, w, ""));
        },
    };
}
