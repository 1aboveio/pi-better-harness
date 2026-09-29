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
    const lines = page.render(width).filter((line) => plain(line).trim());
    const save = lines.findIndex((line) => plain(line).includes("Save as defaults"));
    assert.ok(save >= 0, "the table must have a save action");
    return lines.slice(0, save + 1);
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

/** Down is clamped at the Save row, so enough presses always land there. */
const toSave: string[] = Array(30).fill(Key.down);

async function settle() {
    await new Promise<void>((resolve) => setImmediate(resolve));
}

test("default table has the locked rows and independent Main/Subagents values", () => {
    const h = harness();
    const lines = table(h.page, 84).map(plain);
    assert.equal(lines.length, 14);
    assert.match(lines[0]!, /Sandbox permissions\s+Main\s+Subagents/);
    assert.match(lines[1]!, /Sandbox\s+Off\s+On/);
    assert.match(lines[2]!, /Project files\s+-\s+Write & delete/);
    assert.match(lines[3]!, /Outside project\s+-\s+Write\s*$/);
    assert.match(lines[4]!, /Stored credentials\s+-\s+Read\s*$/);
    assert.match(lines[5]!, /Run commands & applications\s+-\s+On/);
    assert.match(lines[6]!, /Network access\s+-\s+On/);
    assert.match(lines[7]!, /Subagents · Tools/);
    assert.match(lines[8]!, /Guarded \(follows the file rules\)/);
    assert.match(lines[9]!, /\[x\] apply_patch\s+harness adapter/);
    assert.match(lines[10]!, /Trusted \(runs outside the file rules\)/);
    assert.match(lines[11]!, /\[x\] web_fetch\s+@juicesharp\/rpiv-web-tools · needs Network On · not loaded/);
    assert.match(lines[12]!, /\[x\] web_search\s+@juicesharp\/rpiv-web-tools · needs Network On · not loaded/);
    assert.match(lines[13]!, /Save as defaults/);
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
    assert.match(plain(table(h.page)[2]!), /Project files\s+Write & delete\s+Write & delete/);
    h.press(Key.down, Key.space);
    await settle();
    assert.equal(h.current.main.projectFiles, "off");
    h.press(Key.up, Key.space, Key.space);
    await settle();
    assert.equal(h.current.main.enabled, false);
    assert.equal(h.current.main.projectFiles, "off");
    assert.match(plain(table(h.page)[2]!), /Project files\s+-\s+Write & delete/);
    h.press(Key.space);
    await settle();
    assert.match(plain(table(h.page)[2]!), /Project files\s+Off\s+Write & delete/);
});

test("arrows select rows and columns, Space cycles, Enter saves only on action, Escape closes", async () => {
    const h = harness();
    h.press(Key.right, Key.down, Key.space);
    await settle();
    assert.equal(h.current.subagents.projectFiles, "off");
    h.press(Key.space, Key.space);
    await settle();
    assert.equal(h.current.subagents.projectFiles, "read");
    h.press(Key.space, Key.space);
    await settle();
    assert.equal(h.current.subagents.projectFiles, "write");
    h.press(Key.space, Key.space);
    await settle();
    assert.equal(h.current.subagents.projectFiles, "read-write");
    h.press(Key.down, Key.down, Key.down, Key.down, Key.space);
    await settle();
    assert.equal(h.current.subagents.network, false);
    h.press(Key.enter, ...toSave, Key.space);
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

test("file rows cycle four levels and credentials remain independent under Outside Write", async () => {
    const h = harness();
    const hint = () => h.page.render(140).map(plain).find((line) => /deletable|rename-based|Known credential/.test(line));
    h.press(Key.right, Key.down, Key.down);
    assert.match(hint()!, /Write: git and rename-based saves fail outside the project except in worktree folders/);
    h.press(Key.down);
    assert.match(hint()!, /Known credential files follow this row independently of Outside project/);
    assert.match(plain(table(h.page, 100)[4]!), /Stored credentials\s+-\s+Read\s*$/);
    h.press(Key.space);
    await settle();
    assert.equal(h.current.subagents.storedCredentials, "read", "Read → Read / write waits for confirmation");
    h.press(Key.space);
    await settle();
    assert.equal(h.current.subagents.storedCredentials, "read-write");
    h.press(Key.space);
    await settle();
    assert.equal(h.current.subagents.storedCredentials, "off", "Read / write → Off tightens immediately");
    assert.equal(h.current.subagents.outsideProject, "write");
});

test("a looser value applies only on a second Space; a tighter one applies at once", async () => {
    const h = harness();
    h.press(Key.right, Key.down, Key.down, Key.space);
    await settle();
    assert.equal(h.changes.length, 0, "Write → Write & delete waits for confirmation");
    assert.equal(h.current.subagents.outsideProject, "write");
    assert.match(plain(h.page.render(140).at(-1)!), /Looser \(Subagents: outsideProject write → read-write\)\. Press Space again to apply/);
    h.press(Key.up, Key.down, Key.space);
    await settle();
    assert.equal(h.changes.length, 0, "moving away cancels the pending change");
    h.press(Key.space);
    await settle();
    assert.equal(h.current.subagents.outsideProject, "read-write");
    h.press(Key.space);
    await settle();
    assert.equal(h.current.subagents.outsideProject, "off", "tightening applies immediately");
});

test("saving looser defaults needs a second Enter; any other key cancels it", async () => {
    const h = harness({ loosening: (next) => next.subagents.network ? [] : ["Subagents: network on"] });
    h.press(Key.right, ...Array(5).fill(Key.down), Key.space);
    await settle();
    assert.equal(h.current.subagents.network, false);
    h.press(...toSave, Key.enter);
    await settle();
    assert.equal(h.saved.length, 0);
    assert.match(plain(h.page.render(120).at(-1)!), /Looser defaults \(Subagents: network on\)\. Press Enter again to save/);
    h.press(Key.up, Key.down, Key.enter);
    await settle();
    assert.equal(h.saved.length, 0, "moving away cancels the pending confirmation");
    h.press(Key.enter);
    await settle();
    assert.equal(h.saved.length, 1);
    assert.match(plain(h.page.render(120).at(-1)!), /Defaults saved/);
});

test("change and save failures stay inline without optimistic state or closing", async () => {
    let failChange = true;
    let failSave = true;
    const h = harness({
        change: () => { if (failChange) throw new Error("change failed"); },
        save: () => { if (failSave) throw new Error("save failed"); },
    });
    h.press(Key.right, Key.space, Key.space);
    await settle();
    assert.match(plain(h.page.render(80).at(-1)!), /change failed/);
    assert.match(plain(table(h.page)[1]!), /Sandbox\s+Off\s+On/);
    failChange = false;
    h.press(Key.space, Key.space);
    await settle();
    assert.match(plain(table(h.page)[1]!), /Sandbox\s+Off\s+Off/);
    h.press(...toSave);
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
    h.press(...toSave, Key.enter);
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

test("Tools section lists guarded and discovered trusted tools; ticking a trusted tool needs a second Space", async () => {
    const discovered = [
        { name: "web_fetch", package: "npm:@juicesharp/rpiv-web-tools" },
        { name: "web_search", package: "npm:@juicesharp/rpiv-web-tools" },
        { name: "ask_user_question", package: "npm:@juicesharp/rpiv-ask-user-question" },
    ];
    const h = harness({ discoverTools: () => discovered });
    const lines = h.page.render(120).map(plain);
    const at = (pattern: RegExp) => lines.findIndex((line) => pattern.test(line));
    assert.ok(at(/Subagents · Tools/) > at(/Network access/));
    assert.ok(at(/Guarded \(follows the file rules\)/) < at(/\[x\] apply_patch\s+harness adapter/));
    assert.ok(at(/Trusted \(runs outside the file rules\)/) < at(/\[ \] ask_user_question\s+@juicesharp\/rpiv-ask-user-question$/));
    assert.match(lines[at(/web_fetch/)]!, /\[x\] web_fetch\s+@juicesharp\/rpiv-web-tools · needs Network On$/);
    assert.ok(lines.some((line) => /Trusted tools run outside the file rules/.test(line)));
    // Rows after Network access: apply_patch, ask_user_question, web_fetch, web_search.
    h.press(Key.right, ...Array(7).fill(Key.down), Key.space);
    await settle();
    assert.equal(h.changes.length, 0, "ticking a trusted tool waits for confirmation");
    assert.match(plain(h.page.render(160).at(-1)!), /Looser \(Subagents: trusted tool ask_user_question \(@juicesharp\/rpiv-ask-user-question\) runs outside the file rules\)\. Press Space again/);
    assert.ok(h.page.render(160).map(plain).some((line) => /Trusted tools run in the subagent's Pi process, outside the file rules/.test(line)));
    h.press(Key.space);
    await settle();
    assert.deepEqual(h.current.subagentTools.trusted.at(-1), { name: "ask_user_question", package: "npm:@juicesharp/rpiv-ask-user-question" });
    // Unticking a trusted tool and the guarded adapter are tighter: they apply at once.
    h.press(Key.down, Key.space);
    await settle();
    assert.deepEqual(h.current.subagentTools.trusted.map((tool) => tool.name), ["web_search", "ask_user_question"]);
    h.press(Key.up, Key.up, Key.space);
    await settle();
    assert.equal(h.current.subagentTools.applyPatch, false);
    h.press(Key.space);
    await settle();
    assert.equal(h.current.subagentTools.applyPatch, true);
    h.press(...toSave, Key.enter);
    await settle();
    assert.deepEqual(h.saved.at(-1)!.subagentTools, h.current.subagentTools);
});

test("a ticked tool that is not loaded stays listed so it can be unticked", async () => {
    const h = harness({ discoverTools: () => [] });
    const lines = h.page.render(120).map(plain);
    assert.ok(lines.some((line) => /\[x\] web_fetch\s+@juicesharp\/rpiv-web-tools · needs Network On · not loaded/.test(line)));
    h.press(...Array(7).fill(Key.down), Key.space);
    await settle();
    assert.deepEqual(h.current.subagentTools.trusted.map((tool) => tool.name), ["web_search"]);
    assert.ok(!h.page.render(120).map(plain).some((line) => /web_fetch/.test(line)), "an unticked, unloaded tool disappears");
});
