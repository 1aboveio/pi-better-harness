import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { DaemonClient } from "../src/client.ts";
import { pullAttachedSession } from "../src/remote-client/extension.ts";
import { RemoteClientSession } from "../src/remote-client/session.ts";
import { parseRemoteTransferArgs, type TransferFrontend } from "../src/remote-client/transfer-command.ts";
import { makeEnv, spawnDaemon, waitFor } from "./helpers.ts";

async function fixture(t: TestContext) {
  const previous = { ...process.env };
  const host = makeEnv();
  const { child, socketPath } = await spawnDaemon(host);
  const owner = await DaemonClient.connect(socketPath);
  const reader = await DaemonClient.connect(socketPath);
  let remote: RemoteClientSession | undefined;
  t.after(async () => {
    remote?.dispose();
    owner.close();
    reader.close();
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill("SIGTERM");
      await closed;
    }
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  const local = makeEnv();
  Object.assign(process.env, local.vars, { PI_REMOTE_STATE_DIR: join(local.root, "transfer-state") });
  const sessionId = (await owner.call({ type: "create_session", cwd: host.cwd, name: "attached source", model: { provider: "fake", modelId: "fake-1" } })).sessionId!;
  remote = await RemoteClientSession.connect(owner, sessionId);
  const events: any[] = [];
  remote.subscribe(event => { events.push(event); });
  const notices: string[] = [];
  const frontend: TransferFrontend & { connected: NonNullable<TransferFrontend["connected"]> } = {
    cwd: local.cwd,
    connected: { host: "attached-host", remoteDir: host.serverDir, sessionId },
    resolveTarget: async () => ({ socketPath, forwardSocket: async () => assert.fail("No SSH in this test"), close: async () => {} }),
    ui: {
      confirm: async () => true,
      input: async () => local.cwd,
      notify: (message: string) => { notices.push(message); },
    } as unknown as ExtensionUIContext,
  };
  let disconnects = 0;
  const pull = (args = "pull --copy") => pullAttachedSession(parseRemoteTransferArgs(args), frontend, owner, remote!, async () => { disconnects++; remote!.dispose(); });
  await remote.prompt("before copy");
  await waitFor("initial live reply", () => remote!.getLastAssistantText() === "echo:before copy");
  await remote.waitForIdle();
  events.length = 0;
  return { host, local, owner, reader, remote, sessionId, frontend, events, notices, pull, disconnects: () => disconnects };
}

async function assertLive(f: Awaited<ReturnType<typeof fixture>>, message: string) {
  await f.remote.prompt(message);
  await waitFor("daemon persisted reply", async () => JSON.stringify((await f.reader.call({ type: "get_messages", sessionId: f.sessionId })).data.messages).includes(`echo:${message}`));
  await waitFor("attached view receives reply without reconnect", () => f.remote.getLastAssistantText() === `echo:${message}`, 2_000);
  await f.remote.waitForIdle();
  assert.ok(f.events.some(event => event.type === "message_end" && event.message.role === "assistant" && event.message.content.some((block: any) => block.text === `echo:${message}`)), "the existing native subscription receives the new assistant message");
}

async function assertControllerAndReload(f: Awaited<ReturnType<typeof fixture>>) {
  await assert.rejects(f.reader.call({ type: "acquire_control", sessionId: f.sessionId }), /controller/);
  writeFileSync(join(f.host.agentDir, "extensions", "after-copy.ts"), `export default function(pi) {
    pi.registerCommand("after-copy", { description: "Fresh remote command", handler: async (_args, ctx) => ctx.ui.notify("reloaded command ran", "info") });
    pi.registerTool({ name: "after_copy", label: "after copy", description: "Fresh remote tool", parameters: { type: "object", properties: {} },
      async execute() { return { content: [{ type: "text", text: "remote tool" }], details: {} }; } });
  }`);
  await f.remote.reload();
  assert.ok(f.remote.getToolDefinition("after_copy"));
  assert.ok(f.remote.extensionRunner.getRegisteredCommands().some((command: any) => command.name === "after-copy"));
  const notifications: string[] = [];
  await f.remote.bindExtensions({ uiContext: { notify: (message: string) => { notifications.push(message); } } });
  await f.remote.prompt("/after-copy");
  await waitFor("reloaded command notification", () => notifications.includes("reloaded command ran"));
  await assertLive(f, "after reload");
}

for (const selector of ["default", "prefix", "name"] as const) {
  test(`pull-copy of attached ${selector} source keeps live events and controller across reload`, { timeout: 30_000 }, async t => {
    const f = await fixture(t);
    const generation = f.remote.generation;
    const sessionFile = f.remote.sessionFile;
    // The command parser splits words; the name case uses a single-word alias.
    if (selector === "name") await f.remote.setSessionName("named-source");
    const ref = selector === "prefix" ? ` --session ${f.sessionId.slice(0, 8)}` : selector === "name" ? " --session named-source" : "";
    const result = await f.pull(`pull --copy${ref}`);
    assert.ok(result?.sessionFile);
    assert.notEqual(result.sessionId, f.sessionId, "the returned ID belongs to the independent local copy");
    const copyBytes = readFileSync(result.sessionFile, "utf8");
    assert.equal(f.remote.sessionId, f.sessionId);
    assert.equal(f.remote.sessionFile, sessionFile);
    await assertLive(f, `after ${selector} copy`);
    assert.notEqual(f.remote.generation, generation);
    assert.ok(f.events.some(event => event.type === "remote_snapshot" && event.snapshot.sessionId === f.sessionId));
    await assertControllerAndReload(f);
    assert.equal(readFileSync(result.sessionFile, "utf8"), copyBytes, "later source turns never merge into the copy");
    assert.equal(f.disconnects(), 0);
  });
}

test("failed copy resumes a new source generation and restores the existing attachment", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const generation = f.remote.generation;
  const notify = f.frontend.ui.notify;
  f.frontend.ui.notify = (message, type) => {
    if (message.startsWith("fenced ")) throw new Error("copy fixture failed after fencing");
    notify(message, type);
  };
  await assert.rejects(f.pull(), /copy fixture failed after fencing/);
  await assertLive(f, "after failed copy");
  assert.notEqual(f.remote.generation, generation);
  await assertControllerAndReload(f);
  assert.equal(f.disconnects(), 0);
});

test("failed reconciliation preserves the original transfer error and cannot reopen a fenced source", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  // Fail transport cleanup after a successful move: the source has already retired.
  const resolveTarget = f.frontend.resolveTarget!;
  const failure = new Error("transfer cleanup fixture failure");
  f.frontend.resolveTarget = async options => ({ ...await resolveTarget(options), close: async () => { throw failure; } });
  await assert.rejects(f.pull("pull"), error => error === failure);
  await assert.rejects(f.remote.prompt("retired source must not run"), /moved|read.only|detached/i);
  const source = (await f.reader.call({ type: "list_sessions" })).data.sessions.find((session: any) => session.sessionId === f.sessionId);
  assert.equal(source.ownership, "moved");
  assert.equal(source.live, false);
  assert.equal(f.disconnects(), 1);
});

test("cancelling pull-copy does not reconcile or replace the attached source", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const generation = f.remote.generation;
  f.frontend.ui.confirm = async () => false;
  assert.equal(await f.pull(), undefined);
  assert.equal(f.remote.generation, generation);
  assert.equal(f.events.filter(event => event.type === "remote_snapshot").length, 0);
  await assertLive(f, "after cancelled copy");
});

test("copying another session leaves the current attachment and controller unchanged", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const otherId = (await f.reader.call({ type: "create_session", cwd: f.host.cwd, model: { provider: "fake", modelId: "fake-1" } })).sessionId!;
  const generation = f.remote.generation;
  await f.pull(`pull --copy --session ${otherId.slice(0, 8)}`);
  assert.equal(f.remote.sessionId, f.sessionId);
  assert.equal(f.remote.generation, generation);
  assert.equal(f.events.filter(event => event.type === "remote_snapshot").length, 0);
  await assert.rejects(f.reader.call({ type: "acquire_control", sessionId: f.sessionId }), /controller/);
  await assertLive(f, "after other session copy");
});

for (const target of ["other host", "other server directory"] as const) {
  test(`copying the same session ID from ${target} does not reconcile this attachment`, { timeout: 30_000 }, async t => {
    const f = await fixture(t);
    const other = makeEnv();
    // Seed a separate daemon with the same ID: host identity must also match.
    const sessionFile = join(other.root, "source.jsonl");
    const lines = readFileSync(f.remote.sessionFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
    lines[0].cwd = other.cwd;
    writeFileSync(sessionFile, lines.map(line => JSON.stringify(line)).join("\n") + "\n");
    mkdirSync(other.serverDir);
    writeFileSync(join(other.serverDir, "sessions.json"), JSON.stringify({ version: 1, sessions: [{
      sessionId: f.sessionId, sessionFile, cwd: other.cwd, status: "running",
      createdAt: lines[0].timestamp, updatedAt: lines[0].timestamp,
    }] }));
    const { child, socketPath } = await spawnDaemon(other);
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close");
        child.kill("SIGTERM");
        await closed;
      }
    });
    f.frontend.resolveTarget = async () => ({ socketPath, forwardSocket: async () => assert.fail("No SSH in this test"), close: async () => {} });
    const generation = f.remote.generation;
    const selector = target === "other host" ? "other-host" : `--remote-dir ${other.serverDir}`;
    const result = await f.pull(`pull ${selector} --copy --session ${f.sessionId}`);
    assert.ok(result?.sessionFile);
    assert.notEqual(result.sessionId, f.sessionId);
    assert.equal(f.remote.sessionId, f.sessionId);
    assert.equal(f.remote.generation, generation);
    assert.equal(f.events.filter(event => event.type === "remote_snapshot").length, 0);
    await assert.rejects(f.reader.call({ type: "acquire_control", sessionId: f.sessionId }), /controller/);
    await assertLive(f, `after ${target} copy`);
    assert.equal(f.disconnects(), 0);
  });
}

test("pulling the attached session as a move still disconnects its native view", { timeout: 30_000 }, async t => {
  const f = await fixture(t);
  const result = await f.pull("pull");
  assert.equal(result?.sessionId, f.sessionId);
  assert.equal(f.disconnects(), 1);
  assert.equal(f.events.filter(event => event.type === "remote_snapshot").length, 0);
  await assert.rejects(f.remote.prompt("must stay detached"), /detached/);
});
