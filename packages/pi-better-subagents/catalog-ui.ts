import { Input, SelectList, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { OperationList, OperationView } from "./agent-inspection.ts";
import { EFFORT_LEVELS } from "./catalog-schema.ts";
import type { AgentSessionOverrides, AgentSettingKey } from "./agent-session-settings.ts";

type Theme = { fg(color: string, text: string): string; bg?(color: string, text: string): string; bold?(text: string): string; inverse?(text: string): string };

export interface CatalogEditor {
    get(): OperationList;
    models(): readonly string[];
    settings(): AgentSessionOverrides;
    change(id: string, key: AgentSettingKey, value: string | null): void;
    save(id: string): { ok: boolean; message: string };
}

function stateLabel(entry: OperationView): string {
    if (entry.launchable === false) return "blocked";
    if (entry.launchable === true) return "ready";
    return "unresolved";
}


function modelLabel(entry: OperationView): string {
    return entry.actualModel ?? entry.requestedModel ?? entry.fields?.model.value ?? "not resolved";
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
    let mode: "list" | "detail" | "prompt" = initialId ? "detail" : "list";
    let query = "";
    let scroll = 0;
    let settingRow = 0;
    let settingPositions: number[] = [];
    let revealSetting = false;
    let picker: SelectList | undefined;
    let filterPicker: ((filter: string) => void) | undefined;
    let pickerKey: AgentSettingKey | undefined;
    const search = new Input();
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
    function edit() {
        const current = selected();
        if (!current || !editor) return;
        if (!current.definitionValid) { report("Repair the catalog definition before editing.", true); return; }
        const key: AgentSettingKey = settingRow === 0 ? "model" : "effort";
        const values = key === "model" ? [...new Set([...(editor.models()), ...(current.fields?.model.value ? [current.fields.model.value] : [])])].sort() : [...EFFORT_LEVELS];
        const items = [{ value: "", label: "Inherit" }, ...values.map((value) => ({ value, label: value }))];
        pickerKey = key;
        search.setValue("");
        search.focused = focused && key === "model";
        const pickerTheme: ConstructorParameters<typeof SelectList>[2] = {
            selectedPrefix: (text) => theme.fg("accent", text),
            selectedText: (text) => theme.inverse?.(text) ?? theme.fg("accent", text),
            description: (text) => theme.fg("dim", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: (text) => theme.fg("warning", text),
        };
        const onSelect = (item: { value: string }) => {
            try {
                editor.change(current.id, key, item.value || null);
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
        picker!.setSelectedIndex(Math.max(0, items.findIndex((item) => item.value === current.fields?.[key].value)));
    }
    const filtered = () => catalog.entries.filter((entry) =>
        [entry.id, entry.identity.name, entry.identity.description, entry.role?.id]
            .some((value) => value?.toLowerCase().includes(query.toLowerCase())));
    const selected = () => filtered().find((entry) => entry.id === selectedId);
    const detailRows = (entry: OperationView, width: number, controls: string[] = []) => (mode === "prompt"
        ? [`${entry.identity.name || entry.id}  ·  effective instructions`, "", ...(entry.instructions?.split("\n") ?? ["(none)"])]
        : catalogDetailLines(entry, !!editor, width, controls, theme))
        .flatMap((text) => text ? wrapLine(text, Math.max(1, width - 2)) : [""]);


    return {
        get focused() { return focused; },
        set focused(value: boolean) { focused = value; search.focused = value && !!picker && pickerKey === "model"; },
        render(width: number): string[] {
            const safeWidth = Math.max(1, width);
            const height = Math.max(1, Math.floor(getHeight()));
            const footerRows = (editor && mode !== "prompt" ? 2 : 0) + (message ? 2 : 0);
            const diagnosticRows = Math.min(catalog.diagnostics.length, 3);
            const listSize = Math.max(1, height - 5 - footerRows - diagnosticRows - 1);
            const detailSize = Math.max(1, height - 5 - footerRows);
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

            if (picker) return fit([
                theme.fg("accent", `Agents / ${pickerKey}`), "",
                ...(pickerKey === "model" ? search.render(safeWidth) : []),
                ...picker.render(safeWidth),
                ...(message ? [theme.fg(error ? "error" : "muted", message)] : []),
            ]);
            const controls = editor && mode === "detail" && current ? [
                ...["Model", "Effort"].flatMap((label, index) => {
                    const key = index === 0 ? "model" : "effort";
                    const field = current.fields?.[key];
                    const own = editor?.settings()[current.id];
                    const ownSession = Object.hasOwn(own ?? {}, key);
                    const roleSession = field?.inherited && Object.hasOwn(editor?.settings()[current.role?.id ?? ""] ?? {}, key);
                    const origin = ownSession && own?.[key] === null ? "inherit / session" : ownSession ? "session" : roleSession ? "inherited / session" : field?.inherited ? "inherited" : "catalog";
                    return settingLines(label, field?.value ?? "(unset)", origin, Math.max(1, safeWidth - 4), settingRow === index ? "> " : "  ", theme);
                }),
            ] : [];
            const detailLines = current ? detailRows(current, safeWidth, controls) : [];
            if (editor && mode === "detail") {
                settingPositions = ["Model", "Effort"].map((label) => detailLines.findIndex((text) =>
                    new RegExp(`^  [> ] ${label}(?:\\s|$)`).test(text.replace(/\x1b\[[0-9;]*m/g, ""))));
                if (revealSetting && settingPositions[settingRow] >= 0) {
                    const position = settingPositions[settingRow];
                    if (position < scroll) scroll = position;
                    else if (position >= scroll + detailSize) scroll = position - detailSize + 1;
                }
                revealSetting = false;
            }
            scroll = Math.max(0, Math.min(scroll, detailLines.length - detailSize));
            const lines = mode !== "list" && current ? [
                theme.fg("accent", mode === "prompt" ? "Agents / prompt" : editor ? `Agents / ${current.identity.name || current.id}` : "Agents / inspect"),
                theme.fg("dim", mode === "prompt" ? "← details  ·  ↑↓ scroll  ·  Esc back" : `${editor ? "Enter change  ·  " : ""}p prompt  ·  ← list  ·  ↑↓ ${editor ? "select / scroll" : "scroll"}  ·  Esc back`),
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
            if (editor && mode !== "prompt") lines.push("", theme.fg("dim", "ctrl+s Save selected defaults"));
            if (message) lines.push("", theme.fg(error ? "error" : "muted", message));
            return fit(lines);
        },
        handleInput(data: string): void {
            const rows = filtered();
            if (picker) {
                if (pickerKey === "model" && !(["up", "down", "enter", "escape"] as const).some((key) => matchesKey(data, key))) {
                    search.handleInput(data);
                    filterPicker?.(search.getValue());
                } else picker.handleInput(data);
                requestRender();
                return;
            }
            if (editor && matchesKey(data, "ctrl+s")) { save(); return; }
            if (matchesKey(data, "escape") || matchesKey(data, "left")) {
                if (mode === "prompt") { mode = "detail"; scroll = 0; }
                else if (mode === "detail") { mode = "list"; scroll = 0; }
                else if (query) { query = ""; selectedId = catalog.entries[0]?.id; }
                else { close(); return; }
            } else if (matchesKey(data, "up") || matchesKey(data, "down")) {
                const delta = matchesKey(data, "down") ? 1 : -1;
                if (mode === "detail" && editor && scroll <= (settingPositions[1] ?? 0)
                    && ((delta > 0 && settingRow === 0) || (delta < 0 && settingRow === 1))) {
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
            } else if (mode === "list" && matchesKey(data, "backspace")) {
                query = query.slice(0, -1);
                selectedId = filtered()[0]?.id;
            } else if (mode === "list" && data.length === 1 && !/\p{C}/u.test(data)) {
                query += data;
                selectedId = filtered()[0]?.id;
            }
            requestRender();
        },
        invalidate() { picker?.invalidate(); search.invalidate(); },
    };
}