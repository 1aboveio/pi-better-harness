import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { connectHost, syncPackages } from "../src/remote-client/extension.ts";
import { DaemonClient } from "../src/client.ts";
import type { Pi12Bridge } from "../src/remote-client/pi-1.2-bridge.ts";
import { gate, makeEnv, spawnDaemon, waitFor } from "./helpers.ts";

async function fixture(t: TestContext, cancelCheck = false, attachSession = false) {
  const previous = { ...process.env };
  const remote = makeEnv();
  const daemon = await spawnDaemon(remote);
  let sessionId: string | undefined;
  if (attachSession) {
    const client = await DaemonClient.connect(daemon.socketPath);
    try { sessionId = (await client.call({ type: "create_session", cwd: remote.cwd })).sessionId; }
    finally { client.close(); }
  }
  const local = makeEnv();
  Object.assign(process.env, local.vars);
  const installed = join(local.agentDir, "npm", "node_modules", "fixture-tools");
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, "package.json"), JSON.stringify({ name: "fixture-tools", version: "1.0.0" }));
  writeFileSync(join(local.agentDir, "settings.json"), JSON.stringify({ packages: ["npm:fixture-tools"] }));
  t.after(async () => {
    daemon.child.kill("SIGTERM");
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  const events: string[] = [];
  let active: (Component & { dispose?(): void }) | undefined;
  t.after(() => active?.dispose?.());
  const custom: ExtensionUIContext["custom"] = factory => new Promise((resolve, reject) => {
    assert.equal(active, undefined, "Remote screens must not overlap");
    const created = factory({ requestRender() {}, terminal: { rows: 30 } } as unknown as TUI,
      { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme,
      {} as Parameters<typeof factory>[2], result => { active?.dispose?.(); active = undefined; resolve(result); });
    assert.ok(!("then" in created));
    active = created;
    const output = active.render(100).join("\n");
    queueMicrotask(() => {
      try {
        if (output.includes("Active")) { events.push("browser"); active?.handleInput?.("\x1b"); }
        else if (output.includes("Checking") && output.includes("extensions")) {
          events.push("extension-check");
          if (cancelCheck) active?.handleInput?.("\x1b");
        }
      } catch (error) { active?.dispose?.(); active = undefined; reject(error); }
    });
  });
  const ui = { custom, setStatus() { events.push("status-write"); }, notify() {}, confirm: async () => { events.push("extension-confirm"); return false; } } as unknown as ExtensionUIContext;
  const bridge = {
    beginBrowse: () => { events.push("clean-screen"); return () => { events.push("restore-screen"); }; },
    attach: async (session: { dispose(): void }) => {
      assert.ok(attachSession, "Cancelling the browser must not attach");
      events.push("attached");
      session.dispose();
    }, disconnect: async () => {},
  } as unknown as Pi12Bridge;
  const run = () => connectHost({ host: "fixture-host", cwd: undefined, sessionId, remoteDir: remote.serverDir }, {
    ui, cwd: local.cwd, bridge,
    dependencies: { resolveTarget: async () => {
      events.push("connected");
      return { socketPath: daemon.socketPath, serverDir: remote.serverDir,
        close: async () => { events.push("transport-closed"); }, forwardSocket: async () => assert.fail("No SSH in fixture") };
    } },
  });
  return { run, events, ui, local, remote, socketPath: daemon.socketPath };
}

test("connect cleans the screen and completes the extension decision before opening the session browser", async t => {
  const f = await fixture(t);
  await f.run();
  for (const expected of ["clean-screen", "extension-confirm", "browser", "restore-screen", "transport-closed"]) {
    assert.ok(f.events.includes(expected), `Missing ${expected}: ${f.events}`);
  }
  assert.ok(f.events.indexOf("connected") < f.events.indexOf("clean-screen"));
  assert.ok(f.events.indexOf("clean-screen") < f.events.indexOf("extension-check"));
  assert.ok(f.events.indexOf("extension-confirm") < f.events.indexOf("browser"));
  assert.ok(f.events.indexOf("browser") < f.events.indexOf("restore-screen"));
  assert.ok(!f.events.includes("status-write"));
});

test("cancelling the pre-browser extension check restores the local screen without mounting the browser", async t => {
  const f = await fixture(t, true);
  await f.run();
  assert.ok(f.events.includes("extension-check"));
  assert.ok(f.events.includes("restore-screen"));
  assert.ok(f.events.includes("transport-closed"));
  assert.ok(!f.events.includes("browser"));
  assert.ok(!f.events.includes("extension-confirm"));
  assert.ok(!f.events.includes("status-write"));
});

test("attaching a remote session does not write connection status to the footer", async t => {
  const f = await fixture(t, false, true);
  await f.run();
  assert.ok(f.events.includes("attached"));
  assert.ok(!f.events.includes("status-write"));
});

test("legacy daemons without host-level sync keep their sessions available without attempting package mutation", async t => {
  const f = await fixture(t);
  const client = await DaemonClient.connect(f.socketPath);
  t.after(() => client.close());
  const created = await client.call({ type: "create_session", cwd: f.remote.cwd });
  client.server!.capabilities = ["native-client-v1", "package-sync-v1", "session-browser-v1"];
  const notices: string[] = [];
  f.ui.notify = message => { notices.push(message); };
  assert.equal(await syncPackages(client, { ui: f.ui, cwd: f.local.cwd }, undefined, { scope: "global" }), true);
  assert.ok(!f.events.includes("extension-confirm"));
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /deferred.*continuing with installed extensions/);
  const listed = (await client.call({ type: "list_sessions" })).data.sessions;
  assert.equal(listed.find((session: any) => session.sessionId === created.sessionId)?.status, "running");
});

test("busy remote work defers approved package installation without closing a session or ending browsing", async t => {
  const f = await fixture(t);
  const client = await DaemonClient.connect(f.socketPath);
  t.after(() => client.close());
  const created = await client.call({ type: "create_session", cwd: f.remote.cwd, model: { provider: "fake", modelId: "fake-1" } });
  await client.call({ type: "prompt", sessionId: created.sessionId, message: "tool gated" });
  await waitFor("remote tool started", gate(f.remote, "gated").started);
  const notices: string[] = [];
  f.ui.notify = message => { notices.push(message); };
  f.ui.confirm = async () => true;
  assert.equal(await syncPackages(client, { ui: f.ui, cwd: f.local.cwd }, undefined, { scope: "global" }), true);
  assert.ok(notices.some(message => message.includes("No sessions were closed")));
  assert.equal(gate(f.remote, "gated").finished(), false);
  const listed = (await client.call({ type: "list_sessions" })).data.sessions;
  assert.equal(listed.find((session: any) => session.sessionId === created.sessionId)?.status, "running");
  gate(f.remote, "gated").release();
});

test("pending remote dialogs defer approved sync and remain answerable", async t => {
  const f = await fixture(t);
  const client = await DaemonClient.connect(f.socketPath);
  t.after(() => client.close());
  const created = await client.call({ type: "create_session", cwd: f.remote.cwd, model: { provider: "fake", modelId: "fake-1" } });
  await client.call({ type: "prompt", sessionId: created.sessionId, message: "ask Keep this dialog" });
  await waitFor("pending remote dialog", async () => (await client.call({ type: "list_sessions" })).data.sessions.some((session: any) => session.needsInput.length));
  const notices: string[] = [];
  f.ui.notify = message => { notices.push(message); };
  f.ui.confirm = async () => true;
  assert.equal(await syncPackages(client, { ui: f.ui, cwd: f.local.cwd }, undefined, { scope: "global" }), true);
  assert.ok(notices.some(message => message.includes("No sessions were closed")));
  const session = (await client.call({ type: "list_sessions" })).data.sessions.find((item: any) => item.sessionId === created.sessionId);
  assert.equal(session.status, "running");
  assert.equal(session.needsInput.length, 1);
  await client.call({ type: "acquire_control", sessionId: created.sessionId });
  await client.call({ type: "extension_ui_response", sessionId: created.sessionId, requestId: session.needsInput[0].id, value: "answered after sync" });
});

test("an opening remote session defers package sync without blocking its runtime construction", async t => {
  const f = await fixture(t);
  const client = await DaemonClient.connect(f.socketPath);
  t.after(() => client.close());
  const started = join(f.remote.root, "extension-loading.started");
  const release = join(f.remote.root, "extension-loading.release");
  writeFileSync(join(f.remote.agentDir, "extensions", "loading.ts"), `import {existsSync,writeFileSync} from "node:fs";
    export default async function () {
      writeFileSync(${JSON.stringify(started)}, "started");
      while (!existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 10));
    }`);
  const opening = client.call({ type: "create_session", cwd: f.remote.cwd });
  const notices: string[] = [];
  f.ui.notify = message => { notices.push(message); };
  f.ui.confirm = async () => true;
  try {
    await waitFor("remote extension initialization", () => existsSync(started));
    assert.equal(await syncPackages(client, { ui: f.ui, cwd: f.local.cwd }, undefined, { scope: "global" }), true);
    assert.ok(notices.some(message => message.includes("No sessions were closed")));
  } finally { writeFileSync(release, "continue"); }
  const created = await opening;
  assert.equal(created.success, true);
  const listed = (await client.call({ type: "list_sessions" })).data.sessions;
  assert.equal(listed.find((session: any) => session.sessionId === created.sessionId)?.status, "running");
});

