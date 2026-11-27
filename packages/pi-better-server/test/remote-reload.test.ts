import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { DaemonClient } from "../src/client.ts";
import { startDaemon } from "../src/server.ts";
import { RemoteClientSession } from "../src/remote-client/session.ts";
import { gate, makeEnv, waitFor } from "./helpers.ts";

async function setup(t: TestContext, configure?: (env: ReturnType<typeof makeEnv>) => void) {
  const previous = { ...process.env };
  const env = makeEnv();
  configure?.(env);
  Object.assign(process.env, env.vars);
  const daemon = await startDaemon({ serverDir: env.serverDir });
  const owner = await DaemonClient.connect(daemon.socketPath);
  const reader = await DaemonClient.connect(daemon.socketPath);
  const sessionId = (await owner.call({ type: "create_session", cwd: env.cwd, model: { provider: "fake", modelId: "fake-1" } })).sessionId!;
  const session = await RemoteClientSession.connect(owner, sessionId);
  t.after(async () => {
    session.dispose(); owner.close(); reader.close();
    await daemon.stop();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  return { env, daemon, owner, reader, sessionId, session };
}

function addExtension(env: ReturnType<typeof makeEnv>, name = "reloaded") {
  writeFileSync(join(env.agentDir, "extensions", `${name}.ts`), `export default function(pi) {
    pi.registerTool({ name: "${name}", label: "${name}", description: "Reload fixture", parameters: { type: "object", properties: {} },
      async execute() { return { content: [{ type: "text", text: "loaded remotely" }], details: {} }; } });
    pi.registerCommand("${name}", { description: "Reload fixture", handler: async (_args, ctx) => ctx.ui.notify("command executed remotely", "info") });
  }`);
}

test("remote reload refreshes tools and commands, preserves history, subscriptions and the controller", { timeout: 30_000 }, async t => {
  const f = await setup(t);
  await f.session.prompt("before reload");
  await f.session.waitForIdle();
  const hosted = f.daemon.registry.get(f.sessionId)!;
  const file = hosted.session.sessionFile!;
  const before = readFileSync(file, "utf8");
  const generation = f.session.generation;
  const events: any[] = [];
  f.reader.onEvent(event => events.push(event));
  await f.reader.call({ type: "subscribe", sessionId: f.sessionId });
  await assert.rejects(f.reader.call({ type: "client_reload", sessionId: f.sessionId }), /controller lease/);
  addExtension(f.env);
  await f.session.reload();
  await waitFor("reader reload event", () => events.some(event => event.event.type === "remote_resources_reloaded"));
  assert.equal(f.daemon.registry.get(f.sessionId), hosted);
  assert.equal(f.session.generation, generation);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.ok(f.session.getToolDefinition("reloaded"));
  assert.ok(f.session.extensionRunner.getRegisteredCommands().some((command: any) => command.name === "reloaded"));
  const readerSnapshot = (await f.reader.call({ type: "client_snapshot", sessionId: f.sessionId })).data;
  assert.ok(readerSnapshot.tools.some((tool: any) => tool.name === "reloaded"));
  assert.equal((await f.owner.call({ type: "acquire_control", sessionId: f.sessionId })).success, true);
  await assert.rejects(f.reader.call({ type: "acquire_control", sessionId: f.sessionId }), /controller/);
  await f.session.prompt("after reload");
  await f.session.waitForIdle();
  assert.equal(f.session.getLastAssistantText(), "echo:after reload");
  assert.match(readFileSync(file, "utf8"), /before reload/);
});

test("remote reload refuses active tools without reloading the extension runtime", { timeout: 30_000 }, async t => {
  const f = await setup(t);
  await f.session.prompt("tool reload-busy");
  await waitFor("reload tool", gate(f.env, "reload-busy").started);
  addExtension(f.env);
  await assert.rejects(f.session.reload(), /Wait for remote/);
  assert.equal(f.daemon.registry.get(f.sessionId)!.session.getToolDefinition("reloaded"), undefined);
  gate(f.env, "reload-busy").release();
  await f.session.waitForIdle();
  await f.session.reload();
  assert.ok(f.session.getToolDefinition("reloaded"));
});

test("reload fences competing session creation, moves and prompts while keeping reads available", { timeout: 30_000 }, async t => {
  const f = await setup(t);
  const started = join(f.env.root, "reload-started");
  const released = join(f.env.root, "reload-release");
  writeFileSync(join(f.env.agentDir, "extensions", "slow-reload.ts"), `import { existsSync, writeFileSync } from "node:fs";
    export default async function() {
      writeFileSync(${JSON.stringify(started)}, "started");
      while (!existsSync(${JSON.stringify(released)})) await new Promise(resolve => setTimeout(resolve, 10));
    }`);
  const reload = f.session.reload();
  try {
    await waitFor("reload began", () => existsSync(started));
    for (const command of [
      { type: "create_session", cwd: f.env.cwd },
      { type: "prompt", sessionId: f.sessionId, message: "must not execute" },
      { type: "move_fence", sessionId: f.sessionId, moveId: "during-reload" },
      { type: "client_packages_install", cwd: f.env.cwd, packages: [] },
    ]) await assert.rejects(f.reader.call(command), /updated|maintenance/);
    assert.equal((await f.reader.call({ type: "client_snapshot", sessionId: f.sessionId })).data.sessionId, f.sessionId);
    await f.daemon.sweepIdle();
    assert.equal(f.daemon.registry.list().length, 1);
  } finally { writeFileSync(released, "release"); await reload; }
  await f.session.prompt("after fenced reload");
  await f.session.waitForIdle();
  assert.equal(f.session.getLastAssistantText(), "echo:after fenced reload");
});

test("approved package sync refreshes idle sessions, including after an install failure", { timeout: 30_000 }, async t => {
  const f = await setup(t);
  addExtension(f.env, "first_sync");
  await f.owner.call({ type: "client_packages_install", cwd: f.env.cwd, packages: [] });
  await waitFor("automatic extension refresh", () => Boolean(f.session.getToolDefinition("first_sync")));
  addExtension(f.env, "failed_sync");
  await assert.rejects(f.owner.call({ type: "client_packages_install", cwd: f.env.cwd, packages: [{ source: "./not-a-pinned-package" }] }), /Invalid|Unsupported/);
  await waitFor("failed sync runtime refresh", () => Boolean(f.session.getToolDefinition("failed_sync")));
  await f.session.prompt("after failed install");
  await f.session.waitForIdle();
  assert.equal(f.session.getLastAssistantText(), "echo:after failed install");
});

test("remote reload refuses background work and pending dialogs", { timeout: 30_000 }, async t => {
  await t.test("owned background work", async t => {
    const f = await setup(t, env => writeFileSync(join(env.agentDir, "extensions", "background.ts"), `export default function(pi) {
      pi.on("session_start", () => pi.events.emit("pi-better-goal:register-provider", {
        id: "reload-background", scope: "session", getActivity: () => ({ items: [{ active: true }] })
      }));
    }`));
    await assert.rejects(f.session.reload(), /Wait for remote/);
  });
  await t.test("pending dialog", async t => {
    const f = await setup(t);
    const hosted = f.daemon.registry.get(f.sessionId)!;
    const answer = hosted.session.extensionRunner.getUIContext().confirm("Reload safety", "Wait for the answer");
    await waitFor("pending reload dialog", () => hosted.needsInput.length > 0);
    await assert.rejects(f.session.reload(), /Wait for remote/);
    await f.owner.call({ type: "extension_ui_response", sessionId: f.sessionId, requestId: hosted.needsInput[0]!.id, confirmed: false });
    assert.equal(await answer, false);
  });
});

test("new extension dialogs can be answered while reload admission remains fenced", { timeout: 30_000 }, async t => {
  const f = await setup(t);
  const hosted = f.daemon.registry.get(f.sessionId)!;
  writeFileSync(join(f.env.agentDir, "extensions", "reload-confirm.ts"), `export default function(pi) {
    pi.on("session_start", async (_event, ctx) => { await ctx.ui.confirm("Reload fixture", "Approve initialization?"); });
  }`);
  const reload = f.session.reload();
  await waitFor("new extension initialization dialog", () => hosted.needsInput.length > 0);
  await f.owner.call({ type: "extension_ui_response", sessionId: f.sessionId, requestId: hosted.needsInput[0]!.id, confirmed: true });
  await reload;
  assert.equal(hosted.needsInput.length, 0);
});

test("a failed SDK reload fences execution until explicit close and reopen without losing history", { timeout: 30_000 }, async t => {
  const f = await setup(t);
  await f.session.prompt("retained before failed reload");
  await f.session.waitForIdle();
  const hosted = f.daemon.registry.get(f.sessionId)!;
  const before = readFileSync(hosted.session.sessionFile!, "utf8");
  hosted.session.reload = async () => { throw new Error("SDK reload fixture failure"); };
  await assert.rejects(f.session.reload(), /close and reopen.*History is preserved/);
  await assert.rejects(f.session.prompt("must not execute after failed reload"), /runtime is closed/);
  assert.equal(readFileSync(hosted.session.sessionFile!, "utf8"), before);
  await f.owner.call({ type: "close_session", sessionId: f.sessionId });
  await f.owner.call({ type: "open_session", sessionId: f.sessionId });
  assert.notEqual(f.daemon.registry.get(f.sessionId), hosted);
  assert.equal(f.daemon.registry.get(f.sessionId)!.session.getLastAssistantText(), "echo:retained before failed reload");
});
