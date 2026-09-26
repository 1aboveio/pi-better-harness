import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, visibleWidth, type Component } from "@earendil-works/pi-tui";

import {
    DEFAULT_PERMISSION_SETTINGS,
    createPermissionsPage,
    openPermissionsPage,
    type PermissionSettings,
    type PermissionPageHandlers,
} from "../permissions-page.ts";

const theme = {
    fg(color: string, text: string) {
        return `\x1b[${color === "dim" ? 2 : color === "error" ? 31 : color === "accent" ? 36 : 0}m${text}\x1b[0m`;
    },
} as Theme;

function plain(text: string): string {
    return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function table(page: Component, width = 80): string[] {
    return page.render(width).filter((line) => plain(line).trim()).slice(0, 8);
}

function harness(overrides: Partial<PermissionPageHandlers> = {}) {
    const initial: PermissionSettings = structuredClone(DEFAULT_PERMISSION_SETTINGS);
    let current = structuredClone(initial);
    const changes: PermissionSettings[] = [];
    const saved: PermissionSettings[] = [];
    let renders = 0;
    let closes = 0;
    const handlers: PermissionPageHandlers = {
        getConfig: () => structuredClone(current),
        change: (next) => { changes.push(structuredClone(next)); current = structuredClone(next); },
        save: (next) => { saved.push(structuredClone(next)); },
        ...overrides,
    };
    const page = createPermissionsPage(theme, handlers, () => { renders++; }, () => { closes++; });
    const input: Record<string, string> = {
        [Key.up]: "\x1b[A", [Key.down]: "\x1b[B", [Key.left]: "\x1b[D", [Key.right]: "\x1b[C",
        [Key.space]: " ", [Key.enter]: "\r", [Key.escape]: "\x1b",
    };
    const press = (...keys: string[]) => keys.forEach((key) => page.handleInput?.(input[key] ?? key));
    return { page, press, changes, saved, initial, get current() { return current; }, get renders() { return renders; }, get closes() { return closes; } };
}

async function settle() {
    await new Promise<void>((resolve) => setImmediate(resolve));
}

test("default table has the locked rows and independent Main/Subagents values", () => {
    const h = harness();
    const lines = table(h.page, 84).map(plain);
    assert.equal(lines.length, 8);
    assert.match(lines[0]!, /Sandbox permissions\s+Main\s+Subagents/);
    assert.match(lines[1]!, /Sandbox\s+Off\s+On/);
    assert.match(lines[2]!, /Project files\s+-\s+Read \/ write/);
    assert.match(lines[3]!, /Outside project\s+-\s+Read/);
    assert.match(lines[4]!, /Stored credentials\s+-\s+Read/);
    assert.match(lines[5]!, /Run commands & applications\s+-\s+On/);
    assert.match(lines[6]!, /Network access\s+-\s+On/);
    assert.match(lines[7]!, /Save as defaults/);
});

test("disabled details are dimmed and inactive but survive off/on toggles", async () => {
    const h = harness();
    assert.match(table(h.page)[2]!, /\x1b\[2m- /);
    h.press(Key.down, Key.space);
    await settle();
    assert.equal(h.changes.length, 0);
    h.press(Key.up, Key.space);
    await settle();
    assert.equal(h.current.main.enabled, true);
    assert.match(plain(table(h.page)[2]!), /Project files\s+Read \/ write\s+Read \/ write/);
    h.press(Key.down, Key.space);
    await settle();
    assert.equal(h.current.main.projectFiles, "off");
    h.press(Key.up, Key.space);
    await settle();
    assert.equal(h.current.main.enabled, false);
    assert.equal(h.current.main.projectFiles, "off");
    assert.match(plain(table(h.page)[2]!), /Project files\s+-\s+Read \/ write/);
    h.press(Key.space);
    await settle();
    assert.match(plain(table(h.page)[2]!), /Project files\s+Off\s+Read \/ write/);
});

test("arrows select rows and columns, Space cycles, Enter saves only on action, Escape closes", async () => {
    const h = harness();
    h.press(Key.right, Key.down, Key.space);
    await settle();
    assert.equal(h.current.subagents.projectFiles, "off");
    h.press(Key.space);
    await settle();
    assert.equal(h.current.subagents.projectFiles, "read");
    h.press(Key.space);
    await settle();
    assert.equal(h.current.subagents.projectFiles, "read-write");
    h.press(Key.down, Key.down, Key.down, Key.down, Key.space);
    await settle();
    assert.equal(h.current.subagents.network, false);
    h.press(Key.enter, Key.down, Key.space);
    await settle();
    assert.equal(h.saved.length, 0);
    h.press(Key.enter);
    await settle();
    assert.deepEqual(h.saved, [h.current]);
    assert.match(plain(h.page.render(80).at(-1)!), /Defaults saved/);
    h.press(Key.left, Key.up, Key.escape);
    assert.equal(h.closes, 1);
    assert.ok(h.renders > 0);
});

test("change and save failures stay inline without optimistic state or closing", async () => {
    let failChange = true;
    let failSave = true;
    const h = harness({
        change: () => { if (failChange) throw new Error("change failed"); },
        save: () => { if (failSave) throw new Error("save failed"); },
    });
    h.press(Key.right, Key.space);
    await settle();
    assert.match(plain(h.page.render(80).at(-1)!), /change failed/);
    assert.match(plain(table(h.page)[1]!), /Sandbox\s+Off\s+On/);
    failChange = false;
    h.press(Key.space);
    await settle();
    assert.match(plain(table(h.page)[1]!), /Sandbox\s+Off\s+Off/);
    h.press(...Array(6).fill(Key.down));
    h.press(Key.enter);
    await settle();
    assert.match(plain(h.page.render(80).at(-1)!), /save failed/);
    assert.equal(h.closes, 0);
    failSave = false;
    h.press(Key.enter);
    await settle();
    assert.match(plain(h.page.render(80).at(-1)!), /Defaults saved/);
});

test("getConfig failures are inline and prevent mutation or save", async () => {
    let called = 0;
    const h = harness({
        getConfig: () => { throw new Error("config unavailable"); },
        change: () => { called++; },
        save: () => { called++; },
    });
    assert.match(plain(h.page.render(40).at(-1)!), /config unavailable/);
    h.press(Key.space, ...Array(6).fill(Key.down), Key.enter);
    await settle();
    assert.equal(called, 0);
});

test("render obeys cell widths including narrow terminals, Unicode and long errors", async () => {
    const h = harness({ save: () => { throw new Error("保存失敗: very long message 🧪".repeat(8)); } });
    h.press(...Array(6).fill(Key.down), Key.enter);
    await settle();
    assert.match(plain(h.page.render(80).at(-1)!), /保存失敗/);
    for (const width of [0, 1, 2, 7, 8, 12, 20, 32, 40, 80]) {
        for (const line of h.page.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${plain(line)}`);
    }
});

test("open uses custom only for interactive TUI and resolves on Escape", async () => {
    let factory: Parameters<ExtensionContext["ui"]["custom"]>[0] | undefined;
    const ctx = {
        mode: "tui", hasUI: true,
        ui: { custom: (value: typeof factory) => {
            factory = value;
            return new Promise<null>((resolve) => {
                const page = value!({ requestRender() {} } as never, theme, {} as never, (result) => resolve(result as null)) as Component;
                page.handleInput?.("\x1b");
            });
        } },
    } as unknown as ExtensionContext;
    await openPermissionsPage(ctx, {
        getConfig: () => structuredClone(DEFAULT_PERMISSION_SETTINGS), change() {}, save() {},
    });
    assert.ok(factory);
    factory = undefined;
    await openPermissionsPage({ ...ctx, mode: "rpc" }, {
        getConfig: () => structuredClone(DEFAULT_PERMISSION_SETTINGS), change() {}, save() {},
    });
    assert.equal(factory, undefined);
});
