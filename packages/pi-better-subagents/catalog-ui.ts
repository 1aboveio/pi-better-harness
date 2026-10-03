import { Input, SelectList, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { OperationField, OperationList, OperationView } from "./agent-inspection.ts";
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

function fieldLine(label: string, field: OperationField): string {
    return `${label.padEnd(8)} ${field.value ?? "(unset)"}  ${field.source === "role-default" ? "inherited" : field.source === "agent-override" ? "override" : "absent"}`;
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
    const sourceWidth = available >= 70 ? 11 : 0;
    const stateWidth = available >= 48 ? 10 : 0;
    const gaps = (sourceWidth ? 2 : 0) + (stateWidth ? 2 : 0) + 2;
    const modelWidth = Math.min(Math.max(1, available - gaps - 1), Math.min(28, Math.max(20, Math.floor(available * 0.3))));
    const nameWidth = Math.max(1, available - modelWidth - sourceWidth - stateWidth - gaps);
    const name = entry ? entry.identity.name || entry.id : "NAME";
    const model = entry ? modelLabel(entry) : "MODEL";
    const source = entry ? entry.identity.scope ?? "unknown" : "SOURCE";
    const status = entry ? stateLabel(entry) : "STATE";
    return [cell(name, nameWidth), cell(model, modelWidth), ...(sourceWidth ? [cell(source, sourceWidth)] : []), ...(stateWidth ? [cell(status, stateWidth)] : [])].join("  ").trimEnd();
}

function wrapLine(text: string, width: number): string[] {
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

export function catalogDetailLines(entry: OperationView): string[] {
    const lines = [
        `${entry.identity.name || entry.id}  ·  ${entry.identity.kind ?? "unknown"}`,
        entry.id,
        "",
        `Status    ${stateLabel(entry)}  ·  ${entry.launchabilityReason}`,
        `Source    ${entry.identity.scope ?? "unknown"}  ·  ${entry.identity.path ?? "(none)"}`,
        ...(entry.identity.description ? [`About     ${entry.identity.description}`] : []),
        ...(entry.role ? [`Base role ${entry.role.id ?? "(missing)"}${entry.role.found ? "" : "  ·  missing"}`] : []),
        ...(entry.instructionMode ? [`Instructions ${entry.instructionMode}`] : []),
        "",
        "Configuration",
        ...(entry.fields ? [
            fieldLine("Model", entry.fields.model),
            fieldLine("Effort", entry.fields.effort),
            fieldLine("Tier", entry.fields.tier),
        ] : []),
        `Actual   ${entry.actualModel ?? "not resolved"}${entry.actualEffort ? `  ·  ${entry.actualEffort}` : ""}`,
        ...(entry.validation.length ? ["", "Diagnostics", ...entry.validation.map((item) => `${item.blocking ? "!" : "·"} ${item.message}`)] : []),
        ...(entry.shadowed.length ? ["", "Shadowed sources", ...entry.shadowed.map((source) => `${source.scope}  ${source.path}`)] : []),
        ...(entry.restrictions.length ? ["", "Execution restrictions", ...entry.restrictions.map((item) => `${item.honored ? "honored" : "not honored"}  ${item.name}`)] : []),
        "",
        "Effective prompt",
        "Press p to read the complete resolved instructions.",
    ];
    return lines;
}

export function createCatalogComponent(
    catalog: OperationList,
    theme: Theme,
    requestRender: () => void,
    close: () => void,
    initialId?: string,
    editor?: CatalogEditor,
) {
    let selectedId = initialId ?? catalog.entries[0]?.id;
    let mode: "list" | "detail" | "prompt" | "settings" = initialId ? "detail" : "list";
    let query = "";
    let scroll = 0;
    let settingRow = 0;
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
    const detailRows = (entry: OperationView, width: number) => (mode === "prompt"
        ? [`${entry.identity.name || entry.id}  ·  effective instructions`, "", ...(entry.instructions?.split("\n") ?? ["(none)"])]
        : catalogDetailLines(entry))
        .flatMap((text) => text ? wrapLine(text, Math.max(1, width - 2)) : [""]);
    let lastDetailWidth = 80;

    return {
        get focused() { return focused; },
        set focused(value: boolean) { focused = value; search.focused = value && !!picker && pickerKey === "model"; },
        render(width: number): string[] {
            const safeWidth = Math.max(1, width);
            lastDetailWidth = safeWidth;
            const line = (text: string) => truncateToWidth(text, safeWidth);
            const rows = filtered();
            const current = selected();
            const detailLines = current ? detailRows(current, safeWidth) : [];
            const selectedIndex = rows.findIndex((entry) => entry.id === selectedId);
            const start = Math.max(0, Math.min(selectedIndex - 6, rows.length - 14));
            if (picker) return [
                theme.fg("accent", `Agents / ${pickerKey}`), "",
                ...(pickerKey === "model" ? search.render(safeWidth) : []),
                ...picker.render(safeWidth),
                ...(message ? [theme.fg(error ? "error" : "muted", message)] : []),
            ].map(line);
            const lines = mode === "settings" && current ? [
                theme.fg("accent", `Agents / ${current.identity.name || current.id}`), "",
                ...["Model", "Effort"].flatMap((label, index) => {
                    const key = index === 0 ? "model" : "effort";
                    const field = current.fields?.[key];
                    const own = editor?.settings()[current.id];
                    const ownSession = Object.hasOwn(own ?? {}, key);
                    const roleSession = field?.inherited && Object.hasOwn(editor?.settings()[current.role?.id ?? ""] ?? {}, key);
                    const origin = ownSession && own?.[key] === null ? "inherit / session" : ownSession ? "session" : roleSession ? "inherited / session" : field?.inherited ? "inherited" : "catalog";
                    const value = `${field?.value ?? "(unset)"}  ${origin}`;
                    const text = `${settingRow === index ? "> " : "  "}${label.padEnd(18)} ${value}`;
                    if (safeWidth < 42) {
                        const title = `${settingRow === index ? "> " : "  "}${label}`;
                        return [settingRow === index ? highlight(title, safeWidth) : title, ...wrapLine(value, Math.max(1, safeWidth - 2)).map((line) => `  ${line}`)];
                    }
                    return [settingRow === index ? highlight(text, safeWidth) : text];
                }),
            ] : mode !== "list" && current ? [
                theme.fg("accent", mode === "prompt" ? "Agents / prompt" : "Agents / inspect"),
                theme.fg("dim", mode === "prompt" ? "← details  ·  ↑↓ scroll  ·  Esc close" : `${editor ? "e settings  ·  " : ""}p prompt  ·  ← list  ·  ↑↓ scroll  ·  Esc close`),
                "",
                ...detailLines.slice(scroll, scroll + 22).map((text, i) =>
                    i === 0 && scroll === 0 ? theme.fg("accent", text) : text),
                "",
                theme.fg("dim", `Showing ${scroll + 1}-${Math.min(scroll + 22, detailLines.length)} of ${detailLines.length} lines`),
            ] : [
                theme.fg("accent", `Agents  ·  ${catalog.entries.length} definitions`),
                theme.fg("dim", "Type to filter  ·  ↑↓ select  ·  Enter inspect  ·  Esc close"),
                `Search  ${query || "(all roles and agents)"}`,
                "",
                theme.fg("dim", `  ${catalogColumns(null, safeWidth)}`),
                ...rows.slice(start, start + 14).map((entry) => {
                    const active = selectedId === entry.id;
                    const marker = active ? "›" : " ";
                    const text = `${marker} ${catalogColumns(entry, safeWidth)}`;
                    return active ? highlight(text, safeWidth) : text;
                }),
                ...(rows.length === 0 ? ["  No matching definitions"] : []),
                ...(rows.length > 14 ? [theme.fg("dim", `  ${start + 1}-${Math.min(start + 14, rows.length)} of ${rows.length}`)] : []),
                ...catalog.diagnostics.slice(0, 2).map((diagnostic) => theme.fg("warning", `! ${diagnostic.message}`)),
                ...(catalog.diagnostics.length > 2 ? [theme.fg("warning", `! ${catalog.diagnostics.length - 2} more catalog diagnostics`)] : []),
            ];
            if (editor && mode !== "prompt") lines.push("", theme.fg("dim", mode === "settings" ? "Up/Down Select · Enter Change · ctrl+s Save defaults · Esc Back" : "ctrl+s Save selected defaults"));
            if (message) lines.push("", theme.fg(error ? "error" : "muted", message));
            return lines.map(line);
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
                if (mode === "prompt" || mode === "settings") { mode = "detail"; scroll = 0; }
                else if (mode === "detail") { mode = "list"; scroll = 0; }
                else if (query) { query = ""; selectedId = catalog.entries[0]?.id; }
                else { close(); return; }
            } else if (matchesKey(data, "up") || matchesKey(data, "down")) {
                const delta = matchesKey(data, "down") ? 1 : -1;
                if (mode === "settings") settingRow = Math.max(0, Math.min(1, settingRow + delta));
                else if (mode !== "list" && selected()) scroll = Math.max(0, Math.min(detailRows(selected()!, lastDetailWidth).length - 1, scroll + delta));
                else if (rows.length) selectedId = rows[Math.max(0, Math.min(rows.length - 1, rows.findIndex((entry) => entry.id === selectedId) + delta))]?.id;
            } else if (matchesKey(data, "enter") && mode === "list" && selected()) {
                mode = "detail";
                scroll = 0;
            } else if ((data === "p" || data === "P") && mode === "detail" && selected()) {
                mode = "prompt";
                scroll = 0;
            } else if (editor && (data === "e" || data === "E") && mode === "detail" && selected()) {
                mode = "settings";
                settingRow = 0;
            } else if (mode === "settings" && (matchesKey(data, "enter") || data === " ")) {
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