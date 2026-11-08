import { isAbsolute } from "node:path";
import { Input, SelectList, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { OperationList, OperationView } from "./agent-inspection.ts";
import { EFFORT_LEVELS, type SkillExposureEdit } from "./catalog-schema.ts";
import { catalogModelChoices, catalogModelOptionLabel, catalogModelScopeLabel, type ScopedModelLike } from "./catalog-editor.ts";
import type { AgentSessionOverrides, AgentSettingKey } from "./agent-session-settings.ts";

type Theme = { fg(color: string, text: string): string; bg?(color: string, text: string): string; bold?(text: string): string; inverse?(text: string): string };

export interface CatalogEditor {
    get(): OperationList;
    /** Available foreground models, used only when the session scope is empty. */
    models(): readonly string[];
    /** Session model scope (`ctx.scopedModels`). Empty or absent means no scope. */
    scopedModels?(): readonly ScopedModelLike[];
    settings(): AgentSessionOverrides;
    change(id: string, key: AgentSettingKey, value: string | null): void;
    /** Skill exposure is edited through the definition save path, not session settings. */
    changeSkills?(entry: OperationView, edit: SkillExposureEdit): { ok: boolean; message: string };
    save(id: string): { ok: boolean; message: string };
    resetToBundled?(entry: OperationView): { ok: boolean; message: string };
    resetDefinition?(entry: OperationView): { ok: boolean; message: string };
}

function stateLabel(entry: OperationView): string {
    if (entry.launchable === false) return "blocked";
    if (entry.launchable === true) return "ready";
    return "unresolved";
}


function modelLabel(entry: OperationView): string {
    return entry.actualModel ?? entry.requestedModel ?? entry.fields?.model.value ?? "not resolved";
}

/**
 * The definition's visible skill mode. `inherit` is not discovery: an absent
 * value or an explicit null still falls through the global default first.
 */
export function skillsValueLabel(skills: OperationView["skills"]): string {
    if (!skills) return "(unknown)";
    if (skills.value === null) {
        return skills.source === "agent-override" ? "inherit (role list suppressed)" : "inherit";
    }
    if (skills.value.length === 0) return "no skill catalog";
    return `${skills.value.length} selected · ${skills.value.join(", ")}`;
}

/** Where the effective value comes from: agent override, base role, global config, or discovery. */
export function skillsOriginLabel(skills: OperationView["skills"], kind?: string): string {
    if (!skills) return "unknown";
    const own = skills.source === "agent-override" ? "override" : skills.source === "role-default"
        ? kind === "role" ? "role default" : "inherited"
        : undefined;
    const base = skills.effective.source === "session" ? "session"
        : skills.effective.source === "global" ? "global"
        : skills.effective.source === "discovery" ? "discovery" : undefined;
    const effective = base && skills.effective.mode === "error" ? `${base} (invalid)` : base;
    if (own && effective) return `${own} → ${effective}`;
    return own ?? effective ?? "discovery";
}

function skillsSettingLines(entry: OperationView, width: number, marker = "  ", theme?: Theme): string[] {
    if (!entry.skills) return [];
    return settingLines("Skills", skillsValueLabel(entry.skills), skillsOriginLabel(entry.skills, entry.identity.kind), width, marker, theme);
}

/** The picker starts on the definition's own choice, not the inherited effective value. */
function skillChoiceIndex(entry: OperationView): 0 | 1 | 2 {
    const skills = entry.skills;
    if (!skills || skills.value === null) return 0;
    const own = entry.identity.kind === "agent" ? skills.source === "agent-override" : true;
    if (!own) return 0;
    return skills.value.length === 0 ? 1 : 2;
}

function cell(value: string, width: number): string {
    const clipped = truncateToWidth(value.replace(/[\r\n\t]+/g, " "), width);
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export function catalogColumns(entry: OperationView | null, width: number): string {
    const available = Math.max(1, width - 2);
    const sourceWidth = available >= 82 ? 11 : 0;
    const stateWidth = available >= 60 ? 10 : 0;
    const effortWidth = available >= 32 ? 7 : 0;
    const gaps = (sourceWidth ? 2 : 0) + (stateWidth ? 2 : 0) + (effortWidth ? 2 : 0) + 2;
    const modelWidth = Math.min(Math.max(1, available - gaps - effortWidth - sourceWidth - stateWidth - 1), Math.min(28, Math.max(20, Math.floor(available * 0.3))));
    const nameWidth = Math.max(1, available - modelWidth - effortWidth - sourceWidth - stateWidth - gaps);
    const name = entry ? entry.identity.name || entry.id : "NAME";
    const model = entry ? modelLabel(entry) : "MODEL";
    const source = entry ? entry.identity.scope ?? "unknown" : "SOURCE";
    const status = entry ? stateLabel(entry) : "STATE";
    const effort = entry ? entry.actualEffort ?? entry.fields?.effort.value ?? "(unset)" : "EFFORT";
    return [cell(name, nameWidth), cell(model, modelWidth), ...(effortWidth ? [cell(effort, effortWidth)] : []), ...(sourceWidth ? [cell(source, sourceWidth)] : []), ...(stateWidth ? [cell(status, stateWidth)] : [])].join("  ").trimEnd();
}

function wrapLine(text: string, width: number): string[] {
    if (text.includes("\x1b")) return wrapTextWithAnsi(text, width);
    const rows: string[] = [];
    let row = "";
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)) {
        if (row && visibleWidth(row + segment) > width) {
            rows.push(row);
            row = "";
        }
        row += segment;
    }
    rows.push(row);
    return rows;
}

function settingLines(label: string, value: string, origin: string, width: number, marker = "  ", theme?: Theme): string[] {
    const title = (text: string) => theme?.fg(marker === "> " ? "accent" : "muted", text) ?? text;
    const source = (text: string) => theme?.fg("dim", text) ?? text;
    if (width < 54) return [title(`${marker}${label}`), ...wrapLine(`${value}  ${source(origin)}`, Math.max(1, width - 4)).map((row) => `    ${row}`)];
    const valueWidth = Math.max(1, width - 34);
    return wrapLine(value, valueWidth).map((row, index) =>
        `${index === 0 ? title(marker + label.padEnd(10)) : " ".repeat(12)}${cell(row, valueWidth)}  ${index === 0 ? source(origin) : ""}`.trimEnd());
}

export function catalogDetailLines(entry: OperationView, editable = false, width = 80, controls: string[] = [], theme?: Theme): string[] {
    const label = (text: string) => theme?.fg("muted", text) ?? text;
    const heading = (text: string) => label(theme?.bold?.(text) ?? text);
    const contentWidth = Math.max(1, width - 4);
    const columnWidth = width >= 90 ? Math.floor((contentWidth - 4) / 2) : contentWidth;
    const fact = (title: string, value: string) => wrapLine(value, Math.max(1, columnWidth - 13))
        .map((text, index) => `${index === 0 ? label(title.padEnd(13)) : " ".repeat(13)}${text}`);
    const identity = [
        ...fact("ID", entry.id),
        ...fact("Kind", entry.identity.kind ?? "unknown"),
        ...(entry.role ? fact("Base role", `${entry.role.id ?? "(missing)"}${entry.role.found ? "" : " (missing)"}`) : []),
    ];
    const state = [
        ...fact("Status", stateLabel(entry)),
        ...fact("Scope", entry.identity.scope ?? "unknown"),
        ...(entry.instructionMode ? fact("Instructions", entry.instructionMode) : []),
    ];
    const overview = width >= 90
        ? Array.from({ length: Math.max(identity.length, state.length) }, (_, i) =>
            `${cell(identity[i] ?? "", columnWidth)}    ${state[i] ?? ""}`.trimEnd())
        : [...identity, ...state];
    const lines = [
        theme?.fg("accent", `${entry.identity.name || entry.id}  ·  ${entry.identity.kind ?? "unknown"}`) ?? `${entry.identity.name || entry.id}  ·  ${entry.identity.kind ?? "unknown"}`,
        ...(entry.identity.description ? wrapLine(entry.identity.description, contentWidth) : []),
        "",
        ...overview,
        "",
        heading("Configuration"),
        ...(contentWidth >= 54 ? [label(settingLines("SETTING", "VALUE", "ORIGIN", contentWidth)[0])] : []),
        ...controls,
        ...(entry.fields ? [
            ...(!editable ? ["model", "effort"].flatMap((key) => {
                const field = entry.fields![key as "model" | "effort"];
                return settingLines(key === "model" ? "Model" : "Effort", field.value ?? "(unset)", field.inherited || field.source === "role-default" ? "inherited" : field.source === "agent-override" ? "override" : "absent", contentWidth, "  ", theme);
            }) : []),
            ...settingLines("Tier", entry.fields.tier.value ?? "(unset)", entry.fields.tier.source === "role-default" ? "inherited" : entry.fields.tier.source === "agent-override" ? "override" : "absent", contentWidth, "  ", theme),
        ] : []),
        ...skillsSettingLines(entry, contentWidth, "  ", theme),
        `${label("Actual")}   ${entry.actualModel ?? "not resolved"}${entry.actualEffort ? `  ·  ${entry.actualEffort}` : ""}`,
        "",
        heading("Effective prompt"),
        ...(entry.instructions?.trim() ? entry.instructions.split(/\r\n|\r|\n/) : ["(No resolved instructions)"]),
        "",
        heading("Launch resolution"),
        entry.launchabilityReason,
        "",
        heading("Definition source"),
        entry.identity.path ?? "(none)",
        ...(entry.validation.length ? ["", heading("Diagnostics"), ...entry.validation.map((item) => `${item.blocking ? "!" : "·"} ${item.message}`)] : []),
        ...(entry.shadowed.length ? ["", heading("Shadowed sources"), ...entry.shadowed.map((source) => `${source.scope}  ${source.path}`)] : []),
        ...(entry.restrictions.length ? ["", heading("Execution restrictions"), ...entry.restrictions.map((item) => `${item.honored ? "honored" : "not honored"}  ${item.name}`)] : []),
    ];
    return lines.flatMap((text) => text ? wrapLine(text, contentWidth).map((row) => `  ${row}`) : [""]);
}

export function createCatalogComponent(
    catalog: OperationList,
    theme: Theme,
    requestRender: () => void,
    close: () => void,
    initialId?: string,
    editor?: CatalogEditor,
    getHeight: () => number = () => 30,
) {
    let selectedId = initialId ?? catalog.entries[0]?.id;
    let mode: "list" | "detail" | "prompt" | "files" = initialId ? "detail" : "list";
    let query = "";
    let scroll = 0;
    let settingRow = 0;
    let settingPositions: number[] = [];
    let resetPointerRows: number[] = [];
    let resetPointerEntry: OperationView | undefined;
    let pressedReset: OperationView | undefined;
    let pressedResetMode: "detail" | "prompt" | undefined;
    let revealSetting = false;
    let picker: SelectList | undefined;
    let filterPicker: ((filter: string) => void) | undefined;
    let pickerKey: AgentSettingKey | "skills" | undefined;
    let modelScopeNote: string | undefined;
    const search = new Input();
    const skillPaths = new Input();
    let editingSkillPaths = false;
    let focused = false;
    let message = "";
    let error = false;
    const highlight = (text: string, width: number) => theme.bg?.("selectedBg", theme.bold?.(cell(text, width)) ?? cell(text, width)) ?? theme.fg("accent", text);
    function report(text: string, failed = false) { message = text; error = failed; requestRender(); }
    function refresh() { if (editor) catalog = editor.get(); }
    function save() {
        if (!editor || !selected()) return;
        try {
            const result = editor.save(selected()!.id);
            refresh();
            report(result.message, !result.ok);
        } catch (cause) { report(String(cause instanceof Error ? cause.message : cause), true); }
    }
    function canReset(entry: OperationView | undefined): boolean {
        return !!editor?.resetToBundled && !!entry && !Object.values(entry.preferenceSources ?? {}).some(source => source.scope === "project")
            && (entry.identity.scope === "bundled" || entry.identity.scope === "user" && entry.shadowed.some(source => source.scope === "bundled"));
    }
    function canResetDefinition(entry: OperationView | undefined): boolean {
        return !!editor?.resetDefinition && !!entry && (entry.identity.scope === "bundled"
            || entry.identity.scope === "user" && entry.shadowed.some(source => source.scope === "bundled"));
    }
    function reset(entry = selected(), definition = false) {
        if (!entry || !(definition ? canResetDefinition(entry) : canReset(entry))) return;
        try {
            const result = definition ? editor!.resetDefinition!(entry) : editor!.resetToBundled!(entry);
            refresh();
            settingRow = 0;
            scroll = 0;
            resetPointerRows = [];
            resetPointerEntry = undefined;
            report(result.message, !result.ok);
        } catch (cause) { report(cause instanceof Error ? cause.message : String(cause), true); }
    }
    /** Selectable setting rows in display order; Reset is a row, not a save action. */
    function settingKeys(entry: OperationView | undefined): ("model" | "effort" | "skills" | "reset")[] {
        return [
            "model",
            "effort",
            ...(editor?.changeSkills && entry?.skills ? ["skills" as const] : []),
            ...(canReset(entry) ? ["reset" as const] : []),
        ];
    }
    const pickerTheme: ConstructorParameters<typeof SelectList>[2] = {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.inverse?.(text) ?? theme.fg("accent", text),
        description: (text) => theme.fg("dim", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
    };
    function openSkillPaths(current: OperationView) {
        editingSkillPaths = true;
        picker = undefined;
        search.focused = false;
        message = "";
        // Only the definition's own list is prefilled. An inherited list is shown
        // in the picker header; typing here creates an override instead of
        // silently copying the role's value into this definition.
        const own = current.identity.kind === "agent"
            ? current.skills?.source === "agent-override" ? current.skills.value ?? [] : []
            : current.skills?.value ?? [];
        skillPaths.setValue(own.map((path) => JSON.stringify(path)).join(", "));
        skillPaths.handleInput("\x05");
        skillPaths.focused = focused;
    }
    function submitSkillPaths() {
        const current = selected();
        if (!current || !editor?.changeSkills) return;
        const text = skillPaths.getValue().trim();
        let paths: unknown;
        try {
            paths = text.startsWith("[") ? JSON.parse(text)
                : text.startsWith('"') ? JSON.parse(`[${text}]`)
                : text.split(/,\s*(?=\/|[A-Za-z]:[\\/])|\n/);
        } catch {
            report("Check the quoted paths. Separate paths with commas and quote paths containing commas.", true);
            return;
        }
        if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string")) {
            report("Enter paths separated by commas, quoting each path when needed.", true);
            return;
        }
        const unique = [...new Set((paths as string[]).map((entry) => entry.trim()).filter(Boolean))];
        if (unique.length === 0) {
            report("Selected skills needs at least one absolute path. Choose No skill catalog for none.", true);
            return;
        }
        const relative = unique.filter((entry) => !isAbsolute(entry));
        if (relative.length > 0) {
            report(`Skill paths must be absolute: ${relative.join(", ")}.`, true);
            return;
        }
        try {
            const result = editor.changeSkills(current, { mode: "explicit", paths: unique });
            if (result.ok) {
                refresh();
                editingSkillPaths = false;
                skillPaths.focused = false;
            }
            report(result.message, !result.ok);
        } catch (cause) { report(cause instanceof Error ? cause.message : String(cause), true); }
    }
    function editSkills(current: OperationView) {
        if (!editor?.changeSkills) return;
        if (!current.definitionValid) { report("Repair the catalog definition before editing.", true); return; }
        const items = [
            { value: "inherit", label: "Inherit", description: current.identity.kind === "agent" ? "Remove this override; use the base role's list." : "Remove this default; use the global default or discovery." },
            { value: "none", label: "No skill catalog", description: "Load no skills (--no-skills)." },
            { value: "select", label: "Selected skills…", description: "One or more absolute SKILL.md or skill-directory paths." },
        ];
        pickerKey = "skills";
        modelScopeNote = undefined;
        search.focused = false;
        picker = new SelectList(items, 8, pickerTheme);
        picker.onCancel = () => { picker = undefined; };
        picker.onSelect = (item) => {
            if (item.value === "select") { openSkillPaths(current); return; }
            try {
                const result = editor!.changeSkills!(current, item.value === "none" ? { mode: "none" } : { mode: "inherit" });
                refresh();
                picker = undefined;
                report(result.message, !result.ok);
            } catch (cause) { report(cause instanceof Error ? cause.message : String(cause), true); }
        };
        const selectedIndex = skillChoiceIndex(current);
        picker.setSelectedIndex(selectedIndex);
    }
    function edit() {
        const current = selected();
        if (!current || !editor) return;
        const keys = settingKeys(current);
        const key = keys[settingRow];
        if (!key) { settingRow = 0; return; }
        if (key === "reset") { reset(current); return; }
        if (key === "skills") { editSkills(current); return; }
        if (!current.definitionValid) { report("Repair the catalog definition before editing.", true); return; }
        const setting: AgentSettingKey = key === "model" ? "model" : "effort";
        // Pi treats an empty scope as unrestricted. Scoped choices never include
        // an out-of-scope saved value; the detail view still displays it.
        const choices = setting === "model"
            ? catalogModelChoices({ scoped: editor.scopedModels?.(), available: editor.models(), current: current.fields?.model.value })
            : undefined;
        modelScopeNote = choices ? catalogModelScopeLabel(choices) : undefined;
        const items = [{ value: "", label: "Inherit" }, ...(choices
            ? choices.values.map((value) => ({ value, label: catalogModelOptionLabel(choices, value) }))
            : EFFORT_LEVELS.map((value) => ({ value, label: value })))];
        pickerKey = setting;
        search.setValue("");
        search.focused = focused && setting === "model";
        const onSelect = (item: { value: string }) => {
            try {
                editor.change(current.id, setting, item.value || null);
                refresh();
                picker = undefined;
                search.focused = false;
                report("Session settings updated.");
            } catch (cause) { report(cause instanceof Error ? cause.message : String(cause), true); }
        };
        filterPicker = (filter) => {
            picker = new SelectList(items.filter((item) => item.label.toLowerCase().includes(filter.toLowerCase())), 12, pickerTheme);
            picker.onCancel = () => { picker = undefined; search.focused = false; };
            picker.onSelect = onSelect;
        };
        filterPicker("");
        // A saved value the scope does not offer is not in the list. Highlight
        // the first offered model instead of "Inherit" so Enter does not clear
        // the saved preference by accident.
        const currentIndex = items.findIndex((item) => item.value === current.fields?.[setting].value);
        picker!.setSelectedIndex(Math.max(0, currentIndex >= 0 ? currentIndex : choices && choices.scope === "scoped" ? 1 : 0));
    }
    const filtered = () => catalog.entries.filter((entry) =>
        [entry.id, entry.identity.name, entry.identity.description, entry.role?.id]
            .some((value) => value?.toLowerCase().includes(query.toLowerCase())));
    const selected = () => filtered().find((entry) => entry.id === selectedId);
    const detailRows = (entry: OperationView, width: number, controls: string[] = []) => {
        let lines: string[];
        if (mode === "prompt") lines = [
            ...(canResetDefinition(entry) ? [theme.fg("accent", "> Reset to bundled"), theme.fg("dim", "  Restores the prompt; keeps model/effort choices."), ""] : []),
            theme.fg("muted", `Source: ${entry.identity.scope ?? "unknown"} definition`), "", ...(entry.instructions?.split("\n") ?? ["(No resolved instructions)"]),
        ];
        else if (mode === "files") lines = [
            theme.fg("muted", "Definition"), entry.identity.path ?? "(none)", "",
            theme.fg("muted", "Saved preferences"),
            ...([...new Set(Object.values(entry.preferenceSources ?? {}).map(source => `${source.scope}: ${source.path}`))].length
                ? [...new Set(Object.values(entry.preferenceSources ?? {}).map(source => `${source.scope}: ${source.path}`))] : ["No saved preferences for this definition."]),
            "", theme.fg("muted", "Session edits"), ...JSON.stringify(editor?.settings()[entry.id] ?? {}, null, 2).split("\n"),
            ...(entry.shadowed.length ? ["", theme.fg("muted", "Shadowed definitions"), ...entry.shadowed.map(source => `${source.scope}: ${source.path}`)] : []),
        ];
        else lines = [
            ...(editor ? controls : [
                ...(["model", "effort"] as const).flatMap(key => settingLines(key === "model" ? "Model" : "Effort", entry.fields?.[key].value ?? "(unset)", entry.fields?.[key].inherited || entry.fields?.[key].source === "role-default" ? "inherited" : "catalog", Math.max(1, width - 4), "  ", theme)),
                ...skillsSettingLines(entry, Math.max(1, width - 4), "  ", theme),
            ]),
            "", theme.fg("dim", "Model and effort are session edits. Skills save to the definition."), "",
            `ID       ${entry.id}`, `Scope    ${entry.identity.scope ?? "unknown"}`,
            ...(entry.role?.id && entry.identity.kind === "agent" ? [`Role     ${entry.role.id}`] : []),
            `Tier     ${entry.fields?.tier.value ?? "(unset)"}`,
            `Actual   ${entry.actualModel ?? "not resolved"}${entry.actualEffort ? ` · ${entry.actualEffort}` : ""}`,
            "", theme.fg("muted", "Launch resolution"), entry.launchabilityReason,
            ...(entry.validation.length ? ["", theme.fg("muted", "Diagnostics"), ...entry.validation.map(item => `${item.blocking ? "!" : "·"} ${item.message}`)] : []),
            ...(entry.restrictions.length ? ["", theme.fg("muted", "Execution restrictions"), ...entry.restrictions.map(item => `${item.honored ? "honored" : "not honored"}  ${item.name}`)] : []),
        ];
        return lines.flatMap(text => text ? wrapLine(text, Math.max(1, width - 4)).map(row => `  ${row}`) : [""]);
    };


    return {
        get focused() { return focused; },
        set focused(value: boolean) {
            focused = value;
            search.focused = value && !!picker && pickerKey === "model";
            skillPaths.focused = value && editingSkillPaths;
        },
        render(width: number): string[] {
            resetPointerRows = [];
            resetPointerEntry = undefined;
            const safeWidth = Math.max(1, width);
            const height = Math.max(1, Math.floor(getHeight()));
            const messageLines = message ? wrapLine(theme.fg(error ? "error" : "muted", message), safeWidth) : [];
            const footerRows = (editor ? 2 : 0) + (messageLines.length > 0 ? messageLines.length + 1 : 0);
            const diagnosticRows = Math.min(catalog.diagnostics.length, 3);
            const listSize = Math.max(1, height - 5 - footerRows - diagnosticRows - 1);
            const detailSize = Math.max(1, height - 6 - footerRows);
            const fit = (lines: string[]) => {
                const result = lines.slice(0, height).map(line);
                while (result.length < height) result.push("");
                return result;
            };

            const line = (text: string) => truncateToWidth(text, safeWidth);
            const rows = filtered();
            const current = selected();

            const selectedIndex = rows.findIndex((entry) => entry.id === selectedId);
            const start = Math.max(0, Math.min(selectedIndex - Math.floor(listSize / 2), rows.length - listSize));

            if (editingSkillPaths) return fit([
                theme.fg("accent", "Agents / skills · selected"), "",
                ...wrapLine(theme.fg("dim", safeWidth < 60
                    ? "Absolute paths · quote commas · Enter save · Esc cancel"
                    : "Absolute paths separated by commas. Quote paths containing commas."), safeWidth),
                "",
                ...skillPaths.render(safeWidth),
                "",
                ...wrapLine(theme.fg("dim", safeWidth < 60 ? "Empty is an error, not discovery" : "At least one path. Empty is an error; choose No skill catalog for none."), safeWidth),
                ...(messageLines.length ? ["", ...messageLines] : []),
            ]);
            if (picker) return fit([
                theme.fg("accent", `Agents / ${pickerKey}`), "",
                ...(pickerKey === "skills" && current
                    ? [theme.fg("dim", `${skillsValueLabel(current.skills)} · ${skillsOriginLabel(current.skills, current.identity.kind)}`), ""]
                    : []),
                ...(pickerKey === "model" && modelScopeNote ? [theme.fg("dim", modelScopeNote), ""] : []),
                ...(pickerKey === "model" ? search.render(safeWidth) : []),
                ...picker.render(safeWidth),
                ...(messageLines.length ? ["", ...messageLines] : []),
            ]);
            const controls = editor && mode === "detail" && current ? [
                ...["Model", "Effort"].flatMap((label, index) => {
                    const key = index === 0 ? "model" : "effort";
                    const field = current.fields?.[key];
                    const own = editor?.settings()[current.id];
                    const ownSession = Object.hasOwn(own ?? {}, key);
                    const roleSession = field?.inherited && Object.hasOwn(editor?.settings()[current.role?.id ?? ""] ?? {}, key);
                    const saved = current.preferenceSources?.[key];
                    const inherited = current.identity.kind === "agent" && field?.inherited;
                    const origin = ownSession && own?.[key] === null ? "inherit / session" : ownSession ? "session" : roleSession ? "inherited / session"
                        : saved?.bundled ? "bundled" : saved ? `${inherited ? "inherited / " : ""}${saved.scope} config`
                            : current.identity.scope === "bundled" && !inherited ? "bundled" : field?.inherited ? "inherited" : "catalog";
                    return settingLines(label, field?.value ?? "(unset)", origin, Math.max(1, safeWidth - 4), settingRow === index ? "> " : "  ", theme);
                }),
                ...(editor.changeSkills && current.skills ? skillsSettingLines(current, Math.max(1, safeWidth - 4), settingRow === settingKeys(current).indexOf("skills") ? "> " : "  ", theme) : []),
                ...(canReset(current) ? [theme.fg(settingRow === settingKeys(current).indexOf("reset") ? "accent" : "muted", `${settingRow === settingKeys(current).indexOf("reset") ? "> " : "  "}Reset to bundled`), theme.fg("dim", "  Restores model/effort; keeps the role prompt.")] : []),
            ] : [];
            const detailLines = current ? detailRows(current, safeWidth, controls) : [];
            const keys = current ? settingKeys(current) : [];
            if (editor && mode === "detail") {
                settingPositions = ["Model", "Effort", ...(editor.changeSkills && current?.skills ? ["Skills"] : []), ...(canReset(current) ? ["Reset to bundled"] : [])].map((label) => detailLines.findIndex((text) =>
                    new RegExp(`^  [> ] ${label}(?:\\s|$)`).test(text.replace(/\x1b\[[0-9;]*m/g, ""))));
                if (revealSetting && settingPositions[settingRow] >= 0) {
                    const position = settingPositions[settingRow];
                    if (position < scroll) scroll = position;
                    else if (position >= scroll + detailSize) scroll = position - detailSize + 1;
                }
                revealSetting = false;
            }
            scroll = Math.max(0, Math.min(scroll, detailLines.length - detailSize));
            if (mode === "detail" && current && canReset(current)) {
                const position = settingPositions[keys.indexOf("reset")];
                if (position >= scroll && position < scroll + detailSize) {
                    resetPointerRows = [4 + position - scroll];
                    resetPointerEntry = current;
                }
            }
            if (mode === "prompt" && current && canResetDefinition(current) && scroll === 0) {
                resetPointerRows = [4];
                resetPointerEntry = current;
            }
            const lines = mode !== "list" && current ? [
                theme.fg("accent", `Agents / ${current.identity.name || current.id}`),
                ([['detail', 'Settings'], ['prompt', 'Instructions'], ['files', 'Files']] as const).map(([tab, label]) => theme.fg(mode === tab ? "accent" : "dim", mode === tab ? `[${label}]` : label)).join("   "),
                theme.fg("dim", safeWidth < 60 ? "Tab switch · ↑↓ move · Enter · Esc" : `Tab / Shift+Tab switch  ·  ↑↓ ${mode === "detail" && editor ? "select / scroll  ·  Enter change" : mode === "prompt" && canResetDefinition(current) ? "scroll  ·  Enter reset at top" : "scroll"}  ·  Esc list`),
                "",

                ...detailLines.slice(scroll, scroll + detailSize).map((text, i) =>
                    i === 0 && scroll === 0 ? theme.fg("accent", text)
                        : text),
                "",
                theme.fg("dim", `Showing ${scroll + 1}-${Math.min(scroll + detailSize, detailLines.length)} of ${detailLines.length} lines`),
            ] : [
                theme.fg("accent", `Agents  ·  ${catalog.entries.length} definitions`),
                theme.fg("dim", "Type to filter  ·  ↑↓ select  ·  Enter inspect  ·  Esc close"),
                `Search  ${query || "(all roles and agents)"}`,
                "",
                theme.fg("dim", `  ${catalogColumns(null, safeWidth)}`),
                ...rows.slice(start, start + listSize).map((entry) => {
                    const active = selectedId === entry.id;
                    const marker = active ? "›" : " ";
                    const text = `${marker} ${catalogColumns(entry, safeWidth)}`;
                    return active ? highlight(text, safeWidth) : text;
                }),
                ...(rows.length === 0 ? ["  No matching definitions"] : []),
                ...(rows.length > listSize ? [theme.fg("dim", `  ${start + 1}-${Math.min(start + listSize, rows.length)} of ${rows.length}`)] : []),
                ...catalog.diagnostics.slice(0, 2).map((diagnostic) => theme.fg("warning", `! ${diagnostic.message}`)),
                ...(catalog.diagnostics.length > 2 ? [theme.fg("warning", `! ${catalog.diagnostics.length - 2} more catalog diagnostics`)] : []),
            ];
            if (editor) lines.push("", theme.fg("dim", "Ctrl+S Save defaults"));
            if (messageLines.length) lines.push("", ...messageLines);
            return fit(lines);
        },
        handleInput(data: string): void {
            const rows = filtered();
            if (editingSkillPaths) {
                if (matchesKey(data, "escape")) {
                    editingSkillPaths = false;
                    skillPaths.focused = false;
                    message = "";
                    requestRender();
                    return;
                }
                if (matchesKey(data, "enter")) { submitSkillPaths(); requestRender(); return; }
                skillPaths.handleInput(data);
                requestRender();
                return;
            }
            if (picker) {
                if (pickerKey === "model" && !(["up", "down", "enter", "escape"] as const).some((key) => matchesKey(data, key))) {
                    search.handleInput(data);
                    filterPicker?.(search.getValue());
                } else picker.handleInput(data);
                requestRender();
                return;
            }
            if (editor && matchesKey(data, "ctrl+s")) { save(); return; }
            if (mode !== "list" && (matchesKey(data, "tab") || matchesKey(data, "shift+tab"))) {
                const tabs = ["detail", "prompt", "files"] as const;
                const index = tabs.indexOf(mode);
                mode = tabs[(index + (matchesKey(data, "shift+tab") ? 2 : 1)) % 3];
                scroll = 0;
                revealSetting = mode === "detail";
                pressedReset = undefined;
                requestRender();
                return;
            }
            if (matchesKey(data, "escape") || matchesKey(data, "left")) {
                if (mode === "prompt" || mode === "files") { mode = "detail"; scroll = 0; revealSetting = true; }
                else if (mode === "detail") { mode = "list"; scroll = 0; }
                else if (query) { query = ""; selectedId = catalog.entries[0]?.id; }
                else { close(); return; }
            } else if (matchesKey(data, "up") || matchesKey(data, "down")) {
                const delta = matchesKey(data, "down") ? 1 : -1;
                if (mode === "detail" && editor && scroll <= (settingPositions.at(-1) ?? 0)
                    && ((delta > 0 && settingRow < settingPositions.length - 1) || (delta < 0 && settingRow > 0))) {
                    settingRow += delta;
                    revealSetting = true;
                }
                else if (mode !== "list" && selected()) scroll = Math.max(0, scroll + delta);
                else if (rows.length) selectedId = rows[Math.max(0, Math.min(rows.length - 1, rows.findIndex((entry) => entry.id === selectedId) + delta))]?.id;
            } else if (matchesKey(data, "enter") && mode === "list" && selected()) {
                mode = "detail";
                settingRow = 0;
                scroll = 0;
            } else if ((data === "p" || data === "P") && mode === "detail" && selected()) {
                mode = "prompt";
                scroll = 0;
            } else if (editor && (data === "e" || data === "E") && mode === "detail" && selected()) {
                settingRow = 0;
                scroll = 0;
                revealSetting = true;
            } else if (editor && mode === "detail" && (matchesKey(data, "enter") || data === " ")) {
                try { edit(); } catch (cause) { report(cause instanceof Error ? cause.message : String(cause), true); }
            } else if (editor && mode === "prompt" && scroll === 0 && (matchesKey(data, "enter") || data === " ")) {
                reset(selected(), true);
            } else if (mode === "list" && matchesKey(data, "backspace")) {
                query = query.slice(0, -1);
                selectedId = filtered()[0]?.id;
            } else if (mode === "list" && data.length === 1 && !/\p{C}/u.test(data)) {
                query += data;
                selectedId = filtered()[0]?.id;
            }
            requestRender();
        },
        handleMouse(event: { type: string; button: string; x: number; y: number; width: number; shift?: boolean; alt?: boolean; ctrl?: boolean }) {
            const entry = resetPointerEntry;
            const hit = !picker && !editingSkillPaths && (mode === "detail" || mode === "prompt") && entry && event.button === "left" && !event.shift && !event.alt && !event.ctrl
                && event.x >= 0 && event.x < event.width && resetPointerRows.includes(event.y);
            if (event.type === "press") {
                pressedReset = hit ? entry : undefined;
                pressedResetMode = hit ? mode as "detail" | "prompt" : undefined;
                return hit ? { handled: true as const, render: false } : undefined;
            }
            if (event.type !== "click") return undefined;
            const pressed = pressedReset;
            pressedReset = undefined;
            if (!hit || !pressed || pressedResetMode !== mode || pressed.id !== entry.id || pressed.winningSource?.contentDigest !== entry.winningSource?.contentDigest) return undefined;
            reset(pressed, mode === "prompt");
            return { handled: true as const, render: true };
        },
        invalidate() { picker?.invalidate(); search.invalidate(); skillPaths.invalidate(); },
    };
}