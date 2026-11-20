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
    bg(_color: string, text: string) { return `\x1b[44m${text}\x1b[49m`; },
    bold(text: string) { return `\x1b[1m${text}\x1b[22m`; },
    inverse(text: string) { return `\x1b[7m${text}\x1b[27m`; },
} as Theme;

function plain(text: string): string {
    return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function table(page: Component, width = 80): string[] {
    const lines = page.render(width).filter((line) => plain(line).trim());
    const footer = lines.findIndex((line) => plain(line).includes("ctrl+s Save default"));
    assert.ok(footer >= 0, "the footer must expose the save-default shortcut");
    assert.ok(!lines.some((line) => plain(line).includes("Save as defaults")), "saving is not a selectable row");
    return lines.slice(1, footer);
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
        [Key.tab]: "\t", [Key.space]: " ", [Key.enter]: "\r", [Key.escape]: "\x1b",
    };
    const press = (...keys: string[]) => keys.forEach((key) => page.handleInput?.(input[key] ?? key));
    return { page, press, changes, saved, initial, get current() { return current; }, get renders() { return renders; }, get closes() { return closes; } };
}

/** Down is clamped at the final tool row. */
const toBottom: string[] = Array(30).fill(Key.down);

async function settle() {
    await new Promise<void>((resolve) => setImmediate(resolve));
}

test("Tab shows tool providers independently of saved permissions", async () => {
    const h = harness({ toolLoading: () => ({
        main: [{ name: "main_tool", provider: "main-package" }],
        subagents: [{ name: "apply_patch", provider: "Harness" }, { name: "optional", provider: "No provider mapped" }],
    }) });
    assert.match(plain(h.page.render(16)[0]!), /Use permissions/);
    h.press(Key.right, Key.tab);
    assert.match(plain(h.page.render(16)[0]!), /Tool loading/);
    const text = h.page.render(100).map(plain).join("\n");
    assert.match(text, /Tool loading.*Use permissions/);
    assert.match(text, /Ordinary subagent defaults[\s\S]*apply_patch.*Harness/);
    assert.match(text, /optional.*No provider mapped/);
    assert.match(text, /Active Main tools[\s\S]*main_tool.*main-package/);
    h.press(Key.space, "\x13");
    await settle();
    assert.deepEqual(h.changes, []);
    assert.deepEqual(h.saved, []);
    h.press("\x1b[Z", Key.space);
    await settle();
    assert.equal(h.current.subagents.enabled, true);
    assert.equal(h.current.main.enabled, false);
});

test("default table starts all profiles Off and hides retained details", () => {
    const h = harness();
    const lines = table(h.page, 84).map(plain);
    assert.match(lines[0]!, /Sandbox permissions\s+Main\s+Subagents\s+Background tasks/);
    assert.match(lines[1]!, /Sandbox\s+Off\s+Off\s+Off/);
    for (const line of lines.slice(2, 10)) assert.match(line, /\s+-\s+-\s+-\s*$/);
    assert.match(lines[5]!, /Run applications\s+-\s+-\s+-\s*$/);
    assert.match(lines[6]!, /Shell scripts\s+-\s+-\s+-\s*$/);
    assert.match(lines[7]!, /Command time limit\s+-\s+-\s+-\s*$/);
    assert.equal(lines.length, 10);
    assert.doesNotMatch(h.page.render(100).map(plain).join("\n"), /\[[ x]\]|Guarded|Trusted/);
});

test("Shell scripts and Command time limit follow Run applications and save independently", async () => {
    const h = harness();
    h.press(Key.space); // Main On.
    await settle();
    h.press(...Array(5).fill(Key.down)); // Shell scripts.
    assert.match(plain(table(h.page, 100)[6]!), /Shell scripts\s+On\s+-\s+-\s*$/);
    h.press(Key.space);
    await settle();
    assert.equal(h.current.main.shell, false);
    assert.equal(h.current.main.commands, true);
    assert.deepEqual(h.current.subagents, h.initial.subagents);
    assert.deepEqual(h.current.background, h.initial.background);
    h.press(Key.space);
    await settle();
    assert.equal(h.current.main.shell, true, "Space toggles Shell scripts both ways");
    h.press(Key.down); // Command time limit.
    assert.match(plain(table(h.page, 100)[7]!), /Command time limit\s+No limit\s+-\s+-\s*$/);
    for (const expected of [60, 300, 600, 1800, null]) {
        h.press(Key.space);
        await settle();
        assert.equal(h.current.main.commandTimeoutSeconds, expected);
    }
    assert.equal(h.current.main.shell, true);
    // Run applications Off dims both dependent rows and makes them inert.
    h.press(Key.up, Key.up, Key.space);
    await settle();
    assert.equal(h.current.main.commands, false);
    assert.match(plain(table(h.page, 100)[5]!), /Run applications\s+Off\s+-\s+-\s*$/);
    assert.match(plain(table(h.page, 100)[6]!), /Shell scripts\s+-\s+-\s+-\s*$/);
    assert.match(plain(table(h.page, 100)[7]!), /Command time limit\s+-\s+-\s+-\s*$/);
    h.press(Key.down, Key.space);
    await settle();
    h.press(Key.down, Key.space);
    await settle();
    assert.equal(h.current.main.shell, true, "dependent rows cannot change while Run applications is Off");
    assert.equal(h.current.main.commandTimeoutSeconds, null);
    h.press(Key.up, Key.up, Key.space);
    await settle();
    assert.equal(h.current.main.commands, true);
    // Set a persistent non-default pair; other columns stay untouched.
    h.press(Key.down, Key.space);
    await settle();
    h.press(Key.down, Key.space);
    await settle();
    h.press(Key.space);
    await settle();
    assert.equal(h.current.main.shell, false);
    assert.equal(h.current.main.commandTimeoutSeconds, 300);
    h.press("\x13");
    await settle();
    assert.equal(h.saved.length, 1);
    assert.equal(h.saved[0]!.main.shell, false);
    assert.equal(h.saved[0]!.main.commandTimeoutSeconds, 300);
    assert.deepEqual(h.saved[0]!.subagents, h.initial.subagents);
    assert.deepEqual(h.saved[0]!.background, h.initial.background);
    const reopened = harness({ getConfig: () => h.saved[0]! });
    reopened.press(...Array(5).fill(Key.down));
    assert.match(plain(table(reopened.page, 100)[6]!), /Shell scripts\s+Off\s+-\s+-\s*$/);
    reopened.press(Key.down);
    assert.match(plain(table(reopened.page, 100)[7]!), /Command time limit\s+5 min\s+-\s+-\s*$/);
});

test("Shell scripts and Command time limit are independent in every column", async () => {
    const h = harness();
    h.press(Key.space); // Main On.
    await settle();
    h.press(Key.right, Key.space); // Subagents On.
    await settle();
    h.press(Key.right, Key.space); // Background tasks On.
    await settle();
    h.press(...Array(5).fill(Key.down)); // Background Shell scripts.
    h.press(Key.space);
    await settle();
    h.press(Key.down, Key.space); // Background no limit -> 60.
    await settle();
    h.press(Key.space); // 60 -> 300.
    await settle();
    assert.equal(h.current.background.shell, false);
    assert.equal(h.current.background.commandTimeoutSeconds, 300);
    assert.equal(h.current.main.shell, true);
    assert.equal(h.current.main.commandTimeoutSeconds, null);
    assert.equal(h.current.subagents.shell, true);
    assert.equal(h.current.subagents.commandTimeoutSeconds, null);
    h.press(Key.left, ...Array(6).fill(Key.up)); // Subagents Sandbox, then its Shell scripts.
    h.press(...Array(5).fill(Key.down));
    h.press(Key.space);
    await settle();
    h.press(Key.down, Key.space);
    await settle();
    assert.equal(h.current.subagents.shell, false);
    assert.equal(h.current.subagents.commandTimeoutSeconds, 60);
    assert.equal(h.current.background.shell, false);
    assert.equal(h.current.background.commandTimeoutSeconds, 300);
    assert.equal(h.current.main.shell, true);
    assert.equal(h.current.main.commandTimeoutSeconds, null);
    h.press("\x13");
    await settle();
    assert.equal(h.saved[0]!.subagents.commandTimeoutSeconds, 60);
    assert.equal(h.saved[0]!.background.commandTimeoutSeconds, 300);
});

test("legacy profiles render Shell scripts On and Command time limit No limit", async () => {
    const legacy = structuredClone(DEFAULT_PERMISSION_SETTINGS);
    delete legacy.main.shell;
    delete legacy.main.commandTimeoutSeconds;
    legacy.main.enabled = true;
    const h = harness({ getConfig: () => structuredClone(legacy) });
    h.press(...Array(5).fill(Key.down));
    assert.match(plain(table(h.page, 100)[6]!), /Shell scripts\s+On\s+-\s+-\s*$/);
    h.press(Key.down);
    assert.match(plain(table(h.page, 100)[7]!), /Command time limit\s+No limit\s+-\s+-\s*$/);
    h.press(Key.space);
    await settle();
    assert.equal(h.current.main.commandTimeoutSeconds, 60, "No limit cycles to 60");
});

test("Background cells navigate, retain disabled values, and save independently of Main and Subagents", async () => {
    const h = harness();
    h.press(Key.right, Key.right, Key.right, Key.space);
    await settle();
    assert.equal(h.current.background.enabled, true, "Right clamps at Background tasks");
    assert.deepEqual(h.current.main, h.initial.main);
    assert.deepEqual(h.current.subagents, h.initial.subagents);
    const selected = h.page.render(100).find((line) => line.includes("\x1b[44m"))!;
    assert.match(selected, /\x1b\[7m[\s\S]*On/);
    assert.match(plain(table(h.page, 100)[1]!), /Sandbox\s+Off\s+Off\s+On/);
    h.press(Key.down, Key.down, Key.space);
    await settle();
    assert.equal(h.current.background.outsideProject, "write");
    h.press(Key.down, Key.space);
    await settle();
    assert.equal(h.current.background.storedCredentials, "read-write");
    for (let i = 0; i < 5; i++) {
        h.press(Key.down, Key.space);
        await settle();
    }
    assert.equal(h.current.background.commands, false);
    assert.equal(h.current.background.network, false);
    assert.equal(h.current.background.processAccess, "off");
    h.press(...Array(8).fill(Key.up), Key.space);
    await settle();
    h.press(Key.down, Key.space);
    await settle();
    assert.equal(h.current.background.projectFiles, "read-write", "disabled details cannot change");
    assert.match(table(h.page, 100)[2]!, /\x1b\[2m- /);
    h.press(Key.up, Key.space);
    await settle();
    assert.equal(h.current.background.outsideProject, "write");
    h.press("\x13");
    await settle();
    assert.deepEqual(h.saved, [h.current]);
    h.press(Key.left, Key.left, Key.left, Key.space);
    await settle();
    assert.equal(h.current.main.enabled, true, "Left clamps at Main");
    assert.deepEqual(h.current.background, h.saved[0]!.background);
    assert.deepEqual(h.current.subagents, h.initial.subagents);
});

test("selected rows have a full-width background and bold text, with an inverse active cell", () => {
    const h = harness();
    const selectedLines = () => h.page.render(100).filter((line) => line.includes("\x1b[44m"));
    let selected = selectedLines();
    assert.equal(selected.length, 1);
    assert.equal(visibleWidth(selected[0]!), 100);
    assert.match(selected[0]!, /\x1b\[1m/);
    assert.match(selected[0]!, /\x1b\[7m[\s\S]*Off/);
    h.press(Key.right);
    assert.match(selectedLines()[0]!, /\x1b\[7m[\s\S]*Off/);
    h.press(...Array(10).fill(Key.down));
    selected = selectedLines();
    assert.equal(selected.length, 1);
    assert.equal(visibleWidth(selected[0]!), 100);
    assert.match(plain(selected[0]!), /Process access/);
    assert.match(selected[0]!, /\x1b\[1m/);
    h.press(...toBottom);
    assert.match(plain(selectedLines()[0]!), /Process access/);
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
    assert.match(plain(table(h.page)[2]!), /Project files\s+Write & delete\s+-\s+-/);
    h.press(Key.down, Key.space);
    await settle();
    assert.equal(h.current.main.projectFiles, "off");
    h.press(Key.up, Key.space);
    await settle();
    assert.equal(h.current.main.enabled, false);
    assert.equal(h.current.main.projectFiles, "off");
    assert.match(plain(table(h.page)[2]!), /Project files\s+-\s+-\s+-/);
    h.press(Key.space);
    await settle();
    assert.match(plain(table(h.page)[2]!), /Project files\s+Off\s+-\s+-/);
});

test("arrows select profiles, Space cycles, Enter keeps focus, Ctrl+S saves, Escape closes", async () => {
    const h = harness();
    h.press(Key.right, Key.space);
    await settle();
    h.press(Key.down, Key.space);
    await settle();
    assert.equal(h.current.subagents.projectFiles, "off");
    h.press(Key.space);
    await settle();
    assert.equal(h.current.subagents.projectFiles, "read");
    h.press(Key.space);
    await settle();
    assert.equal(h.current.subagents.projectFiles, "write");
    h.press(Key.space);
    await settle();
    assert.equal(h.current.subagents.projectFiles, "read-write");
    h.press(Key.down, Key.down, Key.down, Key.down, Key.down, Key.down, Key.space);
    await settle();
    assert.equal(h.current.subagents.network, false);
    h.press(Key.enter, ...toBottom, Key.enter);
    await settle();
    assert.equal(h.saved.length, 0);
    h.press("\x13");
    await settle();
    assert.deepEqual(h.saved, [h.current]);
    assert.match(plain(h.page.render(80).at(-1)!), /Defaults saved/);
    h.press(Key.left, Key.up, Key.escape);
    assert.equal(h.closes, 1);
    assert.ok(h.renders > 0);
});

test("file rows cycle four levels and credentials remain independent under Outside Write", async () => {
    const h = harness();
    const hint = () => h.page.render(140).map(plain).find((line) => /deletable|rename-based|Known credential/.test(line));
    h.press(Key.right, Key.space);
    await settle();
    h.press(Key.down, Key.down);
    assert.match(hint()!, /Write: git and rename-based saves fail outside the project except in worktree folders/);
    h.press(Key.down);
    assert.match(hint()!, /Known credential files follow this row independently of Outside project/);
    assert.match(plain(table(h.page, 100)[4]!), /Stored credentials\s+-\s+Write & delete\s+-\s*$/);
    h.press(Key.space);
    await settle();
    assert.equal(h.current.subagents.storedCredentials, "off", "Write & delete to Off tightens immediately");
    assert.match(plain(table(h.page, 100)[4]!), /Stored credentials\s+-\s+Off\s+-\s*$/);
    h.press(Key.space);
    await settle();
    assert.equal(h.current.subagents.storedCredentials, "read");
    assert.match(plain(table(h.page, 100)[4]!), /Stored credentials\s+-\s+Read\s+-\s*$/);
    h.press(Key.space);
    await settle();
    assert.equal(h.current.subagents.storedCredentials, "read-write", "credentials skip unsupported Write");
    assert.match(plain(table(h.page, 100)[4]!), /Stored credentials\s+-\s+Write & delete\s+-\s*$/);
    assert.equal(h.current.subagents.outsideProject, "write");
});

test("Process access cycles only Off and Read without changing other permissions", async () => {
    const h = harness();
    h.press(Key.right, Key.space);
    await settle();
    h.press(...Array(8).fill(Key.down), Key.space);
    await settle();
    assert.equal(h.current.subagents.processAccess, "off");
    assert.equal(h.current.main.processAccess, "read");
    assert.match(plain(table(h.page, 100)[9]!), /Process access\s+-\s+Off/);
    assert.deepEqual({ ...h.current.subagents, processAccess: "read" }, { ...h.initial.subagents, enabled: true });
    h.press(Key.space);
    await settle();
    assert.equal(h.current.subagents.processAccess, "read");
});

test("a single Space applies both looser and tighter permission changes", async () => {
    const h = harness();
    h.press(Key.right, Key.space);
    await settle();
    h.press(Key.down, Key.down, Key.space);
    await settle();
    assert.equal(h.changes.length, 2);
    assert.equal(h.current.subagents.outsideProject, "read-write");
    assert.ok(!h.page.render(140).map(plain).join("\n").includes("Press Space again"));
    h.press(Key.space);
    await settle();
    assert.equal(h.current.subagents.outsideProject, "off");
});

test("ctrl+s saves the current defaults from any row", async () => {
    const h = harness();
    h.press(Key.right, Key.space);
    await settle();
    h.press("\x13");
    await settle();
    assert.equal(h.saved.length, 1);
    assert.equal(h.saved[0]!.subagents.enabled, true);
    assert.match(h.page.render(100).map(plain).join("\n"), /ctrl\+s Save default/);
});

test("saving looser defaults happens on the first Ctrl+S and names what loosened", async () => {
    const h = harness({ loosening: (next) => next.subagents.network ? [] : ["Subagents: network on"] });
    h.press(Key.right, Key.space);
    await settle();
    h.press(...Array(7).fill(Key.down), Key.space);
    await settle();
    assert.equal(h.current.subagents.network, false);
    h.press("\x13");
    await settle();
    assert.equal(h.saved.length, 1);
    assert.match(plain(h.page.render(120).at(-1)!), /Defaults saved\. Looser: Subagents: network on/);
    assert.ok(!h.page.render(120).map(plain).join("\n").includes("Press Enter again"));
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
    assert.match(plain(table(h.page)[1]!), /Sandbox\s+Off\s+Off/);
    failChange = false;
    h.press(Key.space);
    await settle();
    assert.match(plain(table(h.page)[1]!), /Sandbox\s+Off\s+On/);
    h.press("\x13");
    await settle();
    assert.match(plain(h.page.render(80).at(-1)!), /save failed/);
    assert.match(plain(table(h.page)[1]!), /Sandbox\s+Off\s+On/, "failed defaults save preserves the edit");
    assert.equal(h.closes, 0);
    failSave = false;
    h.press("\x13");
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
    h.press(Key.space, ...Array(6).fill(Key.down), "\x13");
    await settle();
    assert.equal(called, 0);
});

test("render obeys cell widths including narrow terminals, Unicode and long errors", async () => {
    const h = harness({ save: () => { throw new Error("保存失敗: very long message 🧪".repeat(8)); } });
    h.press("\x13");
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
