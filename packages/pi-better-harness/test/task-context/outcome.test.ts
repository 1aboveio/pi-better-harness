import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../../extensions/task-context/index.js";

test("default off, settings toggle, outcome, goal binding, and branch restore", async () => {
  const dir = mkdtempSync(join(tmpdir(), "task-context-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    let entries: any[] = [];
    const events = new EventEmitter();
    const tools = new Map<string, any>();
    const hooks = new Map<string, any>();
    let active = ["read"];
    let setting: any;
    events.on("harness-settings:register", value => { if (value.id === "outcome-todo") setting = value; });
    const ctx: any = { cwd: dir, mode: "print", hasUI: false, sessionManager: { getBranch: () => entries }, ui: { setWidget() {}, setStatus() {}, notify() {} } };
    const pi: any = { events, registerTool(t: any) { tools.set(t.name, t); active.push(t.name); }, registerCommand() {}, on(n: string, h: any) { hooks.set(n, h); }, appendEntry(customType: string, data: any) { entries.push({ type: "custom", customType, data }); }, getActiveTools: () => active, setActiveTools: (next: string[]) => { active = next; } };
    extension(pi);
    await hooks.get("session_start")({}, ctx);
    assert.deepEqual(active, ["read"]);
    assert.equal(existsSync(join(dir, "settings.json")), false);
    await assert.rejects(tools.get("update_todo").execute("", { outcome: { objective: "x" } }, undefined, undefined, ctx), /off/);
    await setting.change("On", ctx);
    assert.deepEqual(active, ["read", "update_todo", "get_todo"]);
    const update = (input: any) => tools.get("update_todo").execute("", input, undefined, undefined, ctx);
    const get = async () => (await tools.get("get_todo").execute("", {}, undefined, undefined, ctx)).details;
    await update({ outcome: { objective: "Ship", doneWhen: ["Tests pass"] }, todo: [{ step: "Test", status: "completed" }] });
    assert.equal((await get()).outcome.status, "active");
    const messages = [{ role: "user", content: "hello", timestamp: 1 }];
    const first = hooks.get("context")({ messages }).messages;
    assert.equal(hooks.get("context")({ messages: first }).messages.length, 2);
    await update({ todo: [] });
    assert.equal((await get()).outcome.objective, "Ship");
    const branch = entries.slice();
    events.emit("pi-better-harness:task-context", { action: "start", goalId: "g", objective: "Goal" });
    events.emit("pi-better-harness:task-context", { action: "pause", goalId: "other" });
    assert.equal((await get()).outcome.status, "active");
    events.emit("pi-better-harness:task-context", { action: "pause", goalId: "g" });
    assert.equal((await get()).outcome.status, "paused");
    entries = branch;
    await hooks.get("session_tree")({}, ctx);
    assert.equal((await get()).outcome.objective, "Ship");
    await setting.change("Off", ctx);
    assert.deepEqual(active, ["read"]);
    await setting.change("On", ctx);
    assert.equal((await get()).outcome.objective, "Ship");
    await hooks.get("session_shutdown")({}, ctx);
  } finally { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; rmSync(dir, { recursive: true, force: true }); }
});

test("malformed preference is not overwritten", async () => {
  const dir = mkdtempSync(join(tmpdir(), "task-context-invalid-"));
  const old = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const path = join(dir, "settings.json"); const input = '{"piBetterHarness":{"outcomeTodo":{"version":2}}}'; writeFileSync(path, input);
    const events = new EventEmitter(); let setting: any;
    events.on("harness-settings:register", value => { setting = value; });
    const hooks = new Map<string, any>();
    extension({ events, registerTool() {}, registerCommand() {}, on(n: string, h: any) { hooks.set(n, h); }, appendEntry() {} } as any);
    const ctx: any = { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setStatus() {} } };
    await hooks.get("session_start")({}, ctx);
    await assert.rejects(setting.change("On", ctx), /Invalid outcomeTodo/);
    assert.equal(readFileSync(path, "utf8"), input);
  } finally { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; rmSync(dir, { recursive: true, force: true }); }
});
