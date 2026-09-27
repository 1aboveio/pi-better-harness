import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { OperationField, OperationList, OperationView } from "./agent-inspection.ts";

type Theme = { fg(color: string, text: string): string };

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
) {
    let selectedId = initialId ?? catalog.entries[0]?.id;
    let mode: "list" | "detail" | "prompt" = initialId ? "detail" : "list";
    let query = "";
    let scroll = 0;
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
        render(width: number): string[] {
            const safeWidth = Math.max(1, width);
            lastDetailWidth = safeWidth;
            const line = (text: string) => truncateToWidth(text, safeWidth);
            const rows = filtered();
            const current = selected();
            const detailLines = current ? detailRows(current, safeWidth) : [];
            const selectedIndex = rows.findIndex((entry) => entry.id === selectedId);
            const start = Math.max(0, Math.min(selectedIndex - 6, rows.length - 14));
            const lines = mode !== "list" && current ? [
                theme.fg("accent", mode === "prompt" ? "Agents / prompt" : "Agents / inspect"),
                theme.fg("dim", mode === "prompt" ? "← details  ·  ↑↓ scroll  ·  Esc close" : "p prompt  ·  ← list  ·  ↑↓ scroll  ·  Esc close"),
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
                    return active ? theme.fg("accent", text) : text;
                }),
                ...(rows.length === 0 ? ["  No matching definitions"] : []),
                ...(rows.length > 14 ? [theme.fg("dim", `  ${start + 1}-${Math.min(start + 14, rows.length)} of ${rows.length}`)] : []),
                ...catalog.diagnostics.slice(0, 2).map((diagnostic) => theme.fg("warning", `! ${diagnostic.message}`)),
                ...(catalog.diagnostics.length > 2 ? [theme.fg("warning", `! ${catalog.diagnostics.length - 2} more catalog diagnostics`)] : []),
            ];
            return lines.map(line);
        },
        handleInput(data: string): void {
            const rows = filtered();
            if (matchesKey(data, "escape") || matchesKey(data, "left")) {
                if (mode === "prompt") { mode = "detail"; scroll = 0; }
                else if (mode === "detail") { mode = "list"; scroll = 0; }
                else if (query) { query = ""; selectedId = catalog.entries[0]?.id; }
                else { close(); return; }
            } else if (matchesKey(data, "up") || matchesKey(data, "down")) {
                const delta = matchesKey(data, "down") ? 1 : -1;
                if (mode !== "list" && selected()) scroll = Math.max(0, Math.min(detailRows(selected()!, lastDetailWidth).length - 1, scroll + delta));
                else if (rows.length) selectedId = rows[Math.max(0, Math.min(rows.length - 1, rows.findIndex((entry) => entry.id === selectedId) + delta))]?.id;
            } else if (matchesKey(data, "enter") && mode === "list" && selected()) {
                mode = "detail";
                scroll = 0;
            } else if ((data === "p" || data === "P") && mode === "detail" && selected()) {
                mode = "prompt";
                scroll = 0;
            } else if (mode === "list" && matchesKey(data, "backspace")) {
                query = query.slice(0, -1);
                selectedId = filtered()[0]?.id;
            } else if (mode === "list" && data.length === 1 && !/\p{C}/u.test(data)) {
                query += data;
                selectedId = filtered()[0]?.id;
            }
            requestRender();
        },
        invalidate() {},
    };
}