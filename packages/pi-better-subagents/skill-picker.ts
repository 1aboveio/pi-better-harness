/**
 * Shared searchable skill checkbox picker.
 *
 * Both selected-skill entry points use this component: `/subagents settings`
 * for the global default and `/agents` for a role or named agent. It only
 * renders metadata and returns paths; it never loads a model or writes files.
 */
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import * as Tui from "@earendil-works/pi-tui";

/** Metadata Pi already loaded for the current session. */
export interface DiscoveredSkill {
    name: string;
    description: string;
    /** Absolute path to SKILL.md. */
    path: string;
    /** Skill directory, when Pi reports one. */
    baseDir?: string;
    /** Resource source, such as a package or user directory. */
    source?: string;
}

export interface SkillPickerApplyResult {
    ok: boolean;
    message?: string;
}

export interface SkillPickerOptions {
    theme: Theme;
    skills: readonly DiscoveredSkill[];
    selected: readonly string[];
    requestRender: () => void;
    /** Caller applies the draft. A failed apply keeps the picker and checked items. */
    apply(paths: string[]): SkillPickerApplyResult;
    finish(): void;
    cancel(): void;
    getHeight?: () => number;
    title?: string;
}

type Row =
    | { kind: "skill"; skill: DiscoveredSkill; key: string }
    | { kind: "extra"; path: string; key: string }
    | { kind: "apply" }
    | { kind: "add" };

function pathKey(path: string): string {
    try { return resolve(path); }
    catch { return path; }
}

function skillKeys(skill: DiscoveredSkill): string[] {
    return [pathKey(skill.path), ...(skill.baseDir ? [pathKey(skill.baseDir)] : [])];
}

function unavailableName(path: string): string {
    const parent = basename(dirname(path));
    return parent || basename(path);
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function cell(text: string, width: number): string {
    const clipped = Tui.truncateToWidth(text, width, "");
    return clipped + " ".repeat(Math.max(0, width - Tui.visibleWidth(clipped)));
}

export function createSkillPicker(options: SkillPickerOptions): Tui.Component & Tui.Focusable {
    const { theme } = options;
    const search = new Tui.Input();
    const pathInput = new Tui.Input();
    let focused = false;
    let cursor = 0;
    let adding = false;
    let message = "";
    let error = false;
    let scroll = 0;

    const checked = new Map<string, string>();
    for (const path of options.selected) checked.set(pathKey(path), path);
    // Keep saved/manual rows available even after they are unchecked.
    const extraPaths = new Map(checked);

    const skills = [...options.skills].sort((left, right) =>
        left.name.localeCompare(right.name) || left.path.localeCompare(right.path));

    function request(): void {
        options.requestRender();
    }

    function checkedKeysFor(skill: DiscoveredSkill): string[] {
        const keys = new Set(skillKeys(skill));
        return [...checked.keys()].filter((key) => keys.has(key));
    }

    function isChecked(skill: DiscoveredSkill): boolean {
        return checkedKeysFor(skill).length > 0;
    }

    function matches(value: string, query: string): boolean {
        return value.toLowerCase().includes(query);
    }

    function rows(): Row[] {
        const query = search.getValue().trim().toLowerCase();
        const available = skills
            .filter((skill) => !query || matches(skill.name, query) || matches(skill.description, query) || matches(skill.path, query))
            .map((skill): Row => ({ kind: "skill", skill, key: skillKeys(skill)[0]! }));
        const known = new Set(skills.flatMap(skillKeys));
        const extras = [...extraPaths.entries()]
            .filter(([key, path]) => !known.has(key)
                && (!query || matches(path, query) || matches(unavailableName(path), query)))
            .map(([key, path]): Row => ({ kind: "extra", path, key }));
        return [...available, ...extras, { kind: "apply" }, { kind: "add" }];
    }

    function current(entries = rows()): Row | undefined {
        return entries[Math.min(cursor, entries.length - 1)];
    }

    function report(text: string, failed = false): void {
        message = text;
        error = failed;
        request();
    }

    function toggle(row: Row | undefined): void {
        if (!row || row.kind === "apply" || row.kind === "add") return;
        if (row.kind === "skill") {
            const keys = checkedKeysFor(row.skill);
            if (keys.length > 0) keys.forEach((key) => checked.delete(key));
            else checked.set(pathKey(row.skill.path), row.skill.path);
        } else {
            if (checked.has(row.key)) checked.delete(row.key);
            else checked.set(row.key, row.path);
        }
        request();
    }

    function apply(): void {
        const result = options.apply([...checked.values()]);
        if (result.ok) {
            options.finish();
            return;
        }
        report(result.message ?? "Skills were not applied.", true);
    }

    function startAdd(): void {
        adding = true;
        pathInput.setValue("");
        pathInput.handleInput("\x05");
        pathInput.focused = focused;
        message = "";
        error = false;
        request();
    }

    function cancelAdd(): void {
        adding = false;
        pathInput.focused = false;
        message = "Add path cancelled.";
        error = false;
        request();
    }

    function submitAdd(value: string): void {
        const path = value.trim();
        if (!path) {
            report("Enter an absolute path to a SKILL.md file or skill directory. Esc cancels.", true);
            return;
        }
        if (!isAbsolute(path)) {
            report("Enter an absolute path so every child resolves the same skill.", true);
            return;
        }
        if (!existsSync(path)) {
            report("No file or directory exists at that path.", true);
            return;
        }
        const key = pathKey(path);
        if (checked.has(key)) {
            report("That skill path is already selected.", true);
            return;
        }
        checked.set(key, path);
        extraPaths.set(key, path);
        adding = false;
        pathInput.focused = false;
        message = "Skill path added. Press Enter to apply.";
        error = false;
        request();
    }

    pathInput.onSubmit = submitAdd;
    pathInput.onEscape = cancelAdd;

    return {
        get focused() { return focused; },
        set focused(value: boolean) {
            focused = value;
            search.focused = value && !adding;
            pathInput.focused = value && adding;
        },
        invalidate() {
            search.invalidate();
            pathInput.invalidate();
        },
        handleInput(data: string) {
            if (adding) {
                if (Tui.matchesKey(data, Tui.Key.escape)) cancelAdd();
                else {
                    pathInput.handleInput(data);
                    request();
                }
                return;
            }
            const entries = rows();
            if (Tui.matchesKey(data, Tui.Key.escape)) {
                options.cancel();
                return;
            }
            if (Tui.matchesKey(data, Tui.Key.up)) {
                cursor = Math.max(0, Math.min(cursor, entries.length - 1) - 1);
                request();
                return;
            }
            if (Tui.matchesKey(data, Tui.Key.down)) {
                cursor = Math.min(entries.length - 1, Math.min(cursor, entries.length - 1) + 1);
                request();
                return;
            }
            if (Tui.matchesKey(data, Tui.Key.space)) {
                toggle(current(entries));
                return;
            }
            if (Tui.matchesKey(data, Tui.Key.enter)) {
                const row = current(entries);
                if (row?.kind === "add") startAdd();
                else apply();
                return;
            }
            search.handleInput(data);
            cursor = 0;
            scroll = 0;
            request();
        },
        render(width: number) {
            const w = Math.max(1, Math.floor(width));
            const height = Math.max(1, Math.floor(options.getHeight?.() ?? process.stdout.rows ?? 30));
            const title = options.title ?? "Select skills";
            const entries = rows();
            cursor = Math.max(0, Math.min(cursor, entries.length - 1));
            const marker = (isSelected: boolean) => isSelected ? "> " : "  ";
            const highlight = (text: string, isSelected: boolean): string => isSelected
                ? theme.bg("selectedBg", theme.bold?.(cell(text, w)) ?? cell(text, w))
                : text;
            const skillLines = (skill: DiscoveredSkill, ticked: boolean, isSelected: boolean): string[] => {
                const mark = marker(isSelected);
                const box = `[${ticked ? "x" : " "}] `;
                if (w >= 64) {
                    const nameWidth = Math.min(30, Math.max(12, Math.floor(w * 0.3)));
                    const text = `${mark}${box}${cell(skill.name, nameWidth)}${theme.fg("dim", skill.description)}`;
                    return [highlight(text, isSelected)];
                }
                return [
                    highlight(theme.fg(isSelected ? "accent" : "text", `${mark}${box}${skill.name}`), isSelected),
                    theme.fg("dim", `    ${skill.description}`),
                ];
            };
            const extraLines = (path: string, isSelected: boolean): string[] => {
                const mark = marker(isSelected);
                return [
                    highlight(theme.fg(isSelected ? "accent" : "text", `${mark}[${checked.has(pathKey(path)) ? "x" : " "}] ${unavailableName(path)}  (unavailable)`), isSelected),
                    theme.fg("dim", `    ${Tui.truncateToWidth(path, Math.max(1, w - 4), "")}`),
                ];
            };

            const header: string[] = [
                theme.fg("accent", theme.bold?.(`  ${title}`) ?? `  ${title}`),
                theme.fg("dim", "  Up/Down Move · Space Toggle · Enter Apply · Esc Cancel"),
            ];
            if (adding) {
                header.push("", theme.fg("text", "  Add skill path"), theme.fg("dim", "  Absolute SKILL.md or skill directory · Enter add · Esc cancel"));
                header.push("  " + pathOrSearch(pathInput, Math.max(1, w - 2)));
            } else {
                const label = "  Search ";
                const searchWidth = Math.max(1, w - Tui.visibleWidth(label));
                header.push("", label + pathOrSearch(search, searchWidth));
            }

            const body: string[] = [];
            if (skills.length === 0) {
                body.push(theme.fg("dim", "  No loaded skills were reported; use Add skill path."));
            }
            if (entries.every((row) => row.kind === "apply" || row.kind === "add") && search.getValue().trim()) {
                body.push(theme.fg("dim", "  No skills match this filter."));
            }
            let selectedLine = 0;
            const visibleChecked = new Set<string>();
            for (const [index, row] of entries.entries()) {
                if (index === cursor) selectedLine = body.length;
                if (row.kind === "skill") {
                    const ticked = isChecked(row.skill);
                    if (ticked) {
                        for (const key of checkedKeysFor(row.skill)) visibleChecked.add(key);
                    }
                    body.push(...skillLines(row.skill, ticked, index === cursor));
                } else if (row.kind === "extra") {
                    if (checked.has(row.key)) visibleChecked.add(row.key);
                    body.push(...extraLines(row.path, index === cursor));
                } else if (row.kind === "apply") {
                    body.push(highlight(theme.fg(index === cursor ? "accent" : "text", marker(index === cursor) + `✓ Apply selection (${checked.size} checked)`), index === cursor));
                } else {
                    body.push(highlight(theme.fg(index === cursor ? "accent" : "text", marker(index === cursor) + "+ Add skill path…"), index === cursor));
                }
            }
            const hiddenChecked = [...checked.keys()].filter((key) => !visibleChecked.has(key)).length;
            const footer = [
                theme.fg("dim", `  ${checked.size} checked${hiddenChecked ? ` · ${hiddenChecked} checked hidden by filter` : ""}`),
                theme.fg("dim", "  0 checked applies No skill catalog, not discovery."),
            ];
            if (message) footer.unshift(theme.fg(error ? "error" : "muted", "  " + message.replace(/[\r\n]+/g, " ")));
            if (height < header.length + footer.length + 1) {
                const active = adding ? [header[header.length - 1]!, ...(message ? [footer[0]!] : [])]
                    : height === 1 ? [body[selectedLine]!]
                    : [header[header.length - 1]!, body[selectedLine]!];
                return active.slice(0, height).map((line) => Tui.truncateToWidth(line, w, ""));
            }
            const room = Math.max(1, height - header.length - footer.length);
            if (selectedLine < scroll) scroll = selectedLine;
            if (selectedLine >= scroll + room) scroll = selectedLine - room + 1;
            scroll = Math.max(0, Math.min(scroll, Math.max(0, body.length - room)));
            const lines = [...header, ...body.slice(scroll, scroll + room), ...footer];
            if (height < lines.length) lines.splice(0, Math.max(0, lines.length - height));
            return lines.map((line) => Tui.truncateToWidth(line, w, ""));
        },
    };

    function pathOrSearch(input: Tui.Input, width: number): string {
        return input.render(width)[0] ?? "";
    }


}
