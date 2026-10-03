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
    return lines.slice(0, footer);
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

/** Down is clamped at the final tool row. */
const toBottom: string[] = Array(30).fill(Key.down);

async function settle() {
    await new Promise<void>((resolve) => setImmediate(resolve));
}

test("default table has the locked rows and independent Main/Subagents values", () => {
    const h = harness();
    const lines = table(h.page, 84).map(plain);
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
    assert.match(lines[11]!, /> \[x\] @juicesharp\/rpiv-web-tools 2\/2/);
    assert.ok(!lines.some((line) => /\[x\] web_fetch/.test(line)), "tools are initially folded");
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
    assert.match(selectedLines()[0]!, /\x1b\[7m[\s\S]*On/);
    h.press(...Array(7).fill(Key.down));
    selected = selectedLines();
    assert.equal(selected.length, 1);
    assert.equal(visibleWidth(selected[0]!), 100);
    assert.match(plain(selected[0]!), /@juicesharp\/rpiv-web-tools/);
    assert.match(selected[0]!, /\x1b\[1m/);
    h.press(...toBottom);
    assert.match(plain(selectedLines()[0]!), /@juicesharp\/rpiv-web-tools/);
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
    h.press(Key.up, Key.space);
    await settle();
    assert.equal(h.current.main.enabled, false);
    assert.equal(h.current.main.projectFiles, "off");
    assert.match(plain(table(h.page)[2]!), /Project files\s+-\s+Write & delete/);
    h.press(Key.space);
    await settle();
    assert.match(plain(table(h.page)[2]!), /Project files\s+Off\s+Write & delete/);
});

test("arrows select profiles, Space cycles, Enter folds only, Ctrl+S saves, Escape closes", async () => {
    const h = harness();
    h.press(Key.right, Key.down, Key.space);
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
    h.press(Key.down, Key.down, Key.down, Key.down, Key.space);
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
    h.press(Key.right, Key.down, Key.down);
    assert.match(hint()!, /Write: git and rename-based saves fail outside the project except in worktree folders/);
    h.press(Key.down);
    assert.match(hint()!, /Known credential files follow this row independently of Outside project/);
    assert.match(plain(table(h.page, 100)[4]!), /Stored credentials\s+-\s+Read\s*$/);
    h.press(Key.space);
    await settle();
    assert.equal(h.current.subagents.storedCredentials, "read-write", "one Space grants Read / write");
    h.press(Key.space);
    await settle();
    assert.equal(h.current.subagents.storedCredentials, "off", "Read / write → Off tightens immediately");
    assert.equal(h.current.subagents.outsideProject, "write");
});

test("a single Space applies both looser and tighter permission changes", async () => {
    const h = harness();
    h.press(Key.right, Key.down, Key.down, Key.space);
    await settle();
    assert.equal(h.changes.length, 1);
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
    assert.equal(h.saved[0]!.subagents.enabled, false);
    assert.match(h.page.render(100).map(plain).join("\n"), /ctrl\+s Save default/);
});

test("saving looser defaults happens on the first Ctrl+S and names what loosened", async () => {
    const h = harness({ loosening: (next) => next.subagents.network ? [] : ["Subagents: network on"] });
    h.press(Key.right, ...Array(5).fill(Key.down), Key.space);
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
    assert.match(plain(table(h.page)[1]!), /Sandbox\s+Off\s+On/);
    failChange = false;
    h.press(Key.space);
    await settle();
    assert.match(plain(table(h.page)[1]!), /Sandbox\s+Off\s+Off/);
    h.press("\x13");
    await settle();
    assert.match(plain(h.page.render(80).at(-1)!), /save failed/);
    assert.match(plain(table(h.page)[1]!), /Sandbox\s+Off\s+Off/, "failed defaults save preserves the edit");
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

test("Tools groups fold, bulk-select with one Space, and retain per-tool choices", async () => {
    const discovered = [
        { name: "web_fetch", package: "npm:@juicesharp/rpiv-web-tools" },
        { name: "web_search", package: "npm:@juicesharp/rpiv-web-tools" },
        { name: "ask_user_question", package: "npm:@juicesharp/rpiv-ask-user-question" },
        { name: "answer", package: "npm:@juicesharp/rpiv-ask-user-question" },
    ];
    const h = harness({ discoverTools: () => discovered });
    const rendered = () => h.page.render(160).map(plain).join("\n");
    h.press(...Array(7).fill(Key.down));
    assert.match(rendered(), />\s+> \[ \] @juicesharp\/rpiv-ask-user-question 0\/2/);
    h.press(Key.space);
    await settle();
    assert.equal(h.changes.length, 1);
    assert.deepEqual(h.current.subagentTools.trusted.slice(2), [discovered[3], discovered[2]]);
    assert.match(rendered(), /> \[x\] @juicesharp\/rpiv-ask-user-question 2\/2/);
    h.press(Key.right);
    assert.match(rendered(), /v \[x\] @juicesharp\/rpiv-ask-user-question/);
    h.press(Key.down, Key.space);
    await settle();
    assert.deepEqual(h.current.subagentTools.trusted.slice(2), [discovered[2]]);
    assert.match(rendered(), /v \[-\] @juicesharp\/rpiv-ask-user-question 1\/2/);
    h.press(Key.left);
    assert.match(rendered(), />\s+> \[-\] @juicesharp\/rpiv-ask-user-question/);
    assert.ok(!/\[ \] answer/.test(rendered()), "Left from child folds and focuses its group");
    h.press(Key.space);
    await settle();
    assert.equal(h.current.subagentTools.trusted.length, 4, "mixed group selects every tool without duplicates");
    h.press(Key.space);
    await settle();
    assert.deepEqual(h.current.subagentTools.trusted, discovered.slice(0, 2), "all-selected group clears immediately");
    h.press(Key.enter);
    assert.match(rendered(), /v \[ \] @juicesharp\/rpiv-ask-user-question/);
    h.press(Key.enter);
    assert.match(rendered(), /> \[ \] @juicesharp\/rpiv-ask-user-question/);
    h.press(Key.up, Key.space);
    await settle();
    assert.equal(h.current.subagentTools.applyPatch, false);
    h.press("\x13");
    await settle();
    assert.deepEqual(h.saved.at(-1)!.subagentTools, h.current.subagentTools);
    const reopened = harness({ getConfig: () => h.saved.at(-1)!, discoverTools: () => discovered });
    assert.match(reopened.page.render(160).map(plain).join("\n"), /> \[ \] @juicesharp\/rpiv-ask-user-question 0\/2/);
});

test("a ticked tool that is not loaded stays grouped so it can be unticked", async () => {
    const h = harness({ discoverTools: () => [] });
    h.press(...Array(7).fill(Key.down), Key.right);
    const lines = h.page.render(120).map(plain);
    assert.ok(lines.some((line) => /\[x\] web_fetch\s+needs Network On · not loaded/.test(line)));
    h.press(Key.down, Key.space);
    await settle();
    assert.deepEqual(h.current.subagentTools.trusted.map((tool) => tool.name), ["web_search"]);
    assert.ok(!h.page.render(120).map(plain).some((line) => /web_fetch/.test(line)), "an unticked, unloaded tool disappears");
    h.press(Key.left, Key.space);
    await settle();
    assert.deepEqual(h.current.subagentTools.trusted, []);
    assert.match(h.page.render(120).map(plain).join("\n"), />\s*\[x\] apply_patch/, "removing the last unloaded group clamps focus to the guarded tool");
});

test("MCP providers are separate groups and identical names in other packages stay independent", async () => {
    const discovered = [
        { name: "mcp__linear__get_issue", package: "npm:mcp" },
        { name: "mcp__linear__list_issues", package: "npm:mcp" },
        { name: "mcp__worldpay_docs__search", package: "npm:mcp" },
        { name: "mcp__linear__get_issue", package: "npm:other" },
    ];
    const h = harness({ discoverTools: () => discovered });
    const rendered = () => h.page.render(160).map(plain).join("\n");
    assert.match(rendered(), /> \[ \] linear \(mcp\) 0\/2/);
    assert.match(rendered(), /> \[ \] linear \(other\) 0\/1/);
    assert.match(rendered(), /> \[ \] worldpay_docs \(mcp\) 0\/1/);
    h.press(...Array(8).fill(Key.down), Key.space);
    await settle();
    assert.deepEqual(h.current.subagentTools.trusted.slice(2), discovered.slice(0, 2));
    assert.match(rendered(), /> \[ \] linear \(other\) 0\/1/);
    assert.match(rendered(), /> \[ \] worldpay_docs \(mcp\) 0\/1/);
});

test("folding preserves tool choices and narrow render bounds", async () => {
    const discovered = [{ name: "very_long_tool_name", package: "npm:a-very-long-package-name" }];
    const h = harness({ discoverTools: () => discovered });
    h.press(...Array(8).fill(Key.down), Key.space);
    await settle();
    assert.deepEqual(h.current.subagentTools.trusted.at(-1), discovered[0]);
    h.press(Key.right);
    assert.match(h.page.render(120).map(plain).join("\n"), /\[x\] very_long_tool_name/);
    h.press(Key.left);
    assert.equal(h.changes.length, 1, "folding never changes permission choices");
    for (const width of [0, 1, 8, 20, 40, 80]) {
        for (const line of h.page.render(width)) assert.ok(visibleWidth(line) <= width);
    }
});

test("individual children toggle with one Space and reopening does not grant new tools", async () => {
    const tool = { name: "first", package: "npm:zzz" };
    const h = harness({ discoverTools: () => [tool] });
    h.press(...Array(8).fill(Key.down), Key.right, Key.down, Key.space);
    await settle();
    assert.equal(h.current.subagentTools.trusted.length, 3);
    assert.deepEqual(h.current.subagentTools.trusted.at(-1), tool);
    h.press("\x13");
    await settle();
    const reopened = harness({ getConfig: () => h.saved.at(-1)!, discoverTools: () => [tool, { name: "new", package: "npm:zzz" }] });
    assert.match(reopened.page.render(160).map(plain).join("\n"), /> \[-\] zzz 1\/2/);
    reopened.press(...Array(8).fill(Key.down), Key.right);
    assert.match(reopened.page.render(160).map(plain).join("\n"), /\[ \] new/);
});

test("async bulk completion preserves focus after an unloaded group disappears", async () => {
    let release!: () => void;
    const initial = structuredClone(DEFAULT_PERMISSION_SETTINGS);
    initial.subagentTools.trusted = [{ name: "old", package: "npm:aaa" }];
    const h = harness({
        getConfig: () => initial,
        discoverTools: () => [{ name: "new", package: "npm:zzz" }],
        change: () => new Promise<void>((resolve) => { release = resolve; }),
    });
    h.press(...Array(7).fill(Key.down), Key.space, Key.down);
    release();
    await settle();
    const rendered = h.page.render(160).map(plain).join("\n");
    assert.ok(!rendered.includes("aaa"));
    assert.match(rendered, />\s+> \[ \] zzz 0\/1/, "focus stays on the same package, not its old row index");
});

test("removing the last unavailable child focuses the next surviving group", async () => {
    const initial = structuredClone(DEFAULT_PERMISSION_SETTINGS);
    initial.subagentTools.trusted = [{ name: "old", package: "npm:aaa" }];
    const next = { name: "next", package: "npm:bbb" };
    const h = harness({ getConfig: () => initial, discoverTools: () => [next, { name: "last", package: "npm:ccc" }] });
    h.press(...Array(7).fill(Key.down), Key.right, Key.down, Key.space);
    await settle();
    assert.match(h.page.render(160).map(plain).join("\n"), />\s+> \[ \] bbb 0\/1/);
    h.press(Key.space);
    await settle();
    assert.deepEqual(h.current.subagentTools.trusted, [next], "the next Space targets bbb, not ccc");
});

test("a looser save note remains visible within narrow bounds", async () => {
    const h = harness({
        discoverTools: () => [{ name: "one", package: "npm:zzz" }, { name: "two", package: "npm:zzz" }],
        loosening: () => ["Subagents: two additional trusted tools run outside file rules"],
    });
    h.press(...Array(8).fill(Key.down), Key.space);
    await settle();
    h.press("\x13");
    await settle();
    assert.equal(h.saved.length, 1);
    assert.match(h.page.render(40).map(plain).join("\n"), /Defaults saved/);
    for (const width of [0, 1, 8, 20, 40, 80]) {
        for (const line of h.page.render(width)) assert.ok(visibleWidth(line) <= width);
    }
});

test("deferred bulk failures retain state, suppress duplicate changes, and allow retry", async () => {
    let reject!: (error: Error) => void;
    let calls = 0;
    const h = harness({
        discoverTools: () => [{ name: "tool", package: "npm:zzz" }],
        change: () => {
            calls++;
            if (calls === 1) return new Promise<void>((_resolve, fail) => { reject = fail; });
        },
    });
    h.press(...Array(8).fill(Key.down), Key.space, Key.right, Key.space, Key.space);
    assert.equal(calls, 1, "input while busy cannot submit another change");
    reject(new Error("async bulk failed"));
    await settle();
    assert.match(h.page.render(160).map(plain).join("\n"), /v \[ \] zzz 0\/1/);
    assert.match(plain(h.page.render(160).at(-1)!), /async bulk failed/);
    h.press(Key.space);
    await settle();
    assert.equal(calls, 2);
    assert.match(h.page.render(160).map(plain).join("\n"), /v \[x\] zzz 1\/1/);
});

test("failed bulk changes do not update group checkbox state", async () => {
    const h = harness({
        discoverTools: () => [{ name: "tool", package: "npm:zzz" }],
        change: () => { throw new Error("bulk failed"); },
    });
    h.press(...Array(8).fill(Key.down), Key.space);
    await settle();
    assert.match(h.page.render(160).map(plain).join("\n"), /> \[ \] zzz 0\/1/);
    assert.match(plain(h.page.render(160).at(-1)!), /bulk failed/);
    assert.equal(h.current.subagentTools.trusted.length, 2);
});
