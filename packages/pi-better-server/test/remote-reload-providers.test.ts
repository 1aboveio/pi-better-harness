import assert from "node:assert/strict";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createEventBus, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { DaemonClient } from "../src/client.ts";
import { startDaemon, type DaemonOptions } from "../src/server.ts";
import { makeEnv } from "./helpers.ts";

type Trace = { version: string; event: string; active?: boolean };

/** Real SDK extension: deliberately leaves pi.events listeners behind on shutdown. */
function providerExtension(env: ReturnType<typeof makeEnv>, version: string, active = false, registerAtLoad = false) {
  const path = join(env.agentDir, "extensions", `${version}.ts`);
  writeFileSync(path, `import { appendFileSync } from "node:fs";
    export default function(pi) {
      const record = (event, extra = {}) => appendFileSync(${JSON.stringify(join(env.root, "providers.jsonl"))},
        JSON.stringify({ version: ${JSON.stringify(version)}, event, ...extra }) + "\\n");
      let stopped = false;
      let active = ${active};
      let ctx;
      const observers = new Set();
      const provider = {
        id: "reload-provider", scope: "session",
        getActivity(context) {
          if (stopped) { record("stopped-observation"); throw new Error("provider already stopped"); }
          if (!context.sessionManager.getSessionId()) throw new Error("missing session context");
          return { items: [{ active }] };
        },
        onActivityChanged(notify) {
          observers.add(notify);
          record("subscribe");
          return () => { if (observers.delete(notify)) record("unsubscribe"); };
        }
      };
      // Probe before this factory registers anything: old listeners must already be gone.
      pi.events.emit("reload-fixture:probe", {});
      pi.events.emit("pi-better-goal:ready", {});
      if (${registerAtLoad}) pi.events.emit("pi-better-goal:register-provider", provider);
      pi.events.on("pi-better-goal:ready", () => {
        record("ready");
        if (!${registerAtLoad}) pi.events.emit("pi-better-goal:register-provider", provider);
      });
      pi.events.on("reload-fixture:probe", () => { record("probe"); ctx?.ui.notify("provider ${version}", "info"); });
      pi.events.on("reload-fixture:active", value => {
        active = value;
        record("change", { active });
        for (const notify of observers) { record("notify"); notify(); }
      });
      pi.on("session_start", (_event, context) => { ctx = context; record("start"); });
      pi.on("session_shutdown", () => {
        stopped = true;
        record("shutdown");
        // Shutdown-time subscriptions belong to the outgoing runtime too.
        pi.events.on("reload-fixture:probe", () => record("shutdown-listener"));
      });
      pi.registerCommand("provider-probe", { handler: async () => pi.events.emit("reload-fixture:probe", {}) });
      pi.registerCommand("provider-idle", { handler: async () => pi.events.emit("reload-fixture:active", false) });
    }`);
  return path;
}

async function setup(t: TestContext, options?: (env: ReturnType<typeof makeEnv>) => Promise<DaemonOptions["sessionOptions"]>) {
  const previous = { ...process.env };
  const env = makeEnv();
  Object.assign(process.env, env.vars);
  writeFileSync(join(env.root, "providers.jsonl"), "");
  const oldPath = providerExtension(env, "old");
  const daemon = await startDaemon({ serverDir: env.serverDir, sessionOptions: await options?.(env) });
  const client = await DaemonClient.connect(daemon.socketPath);
  t.after(async () => {
    client.close();
    await daemon.stop();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  const sessionId = (await client.call({ type: "create_session", cwd: env.cwd, model: { provider: "fake", modelId: "fake-1" } })).sessionId!;
  await client.call({ type: "acquire_control", sessionId });
  const hosted = daemon.registry.get(sessionId)!;
  const trace = (): Trace[] => readFileSync(join(env.root, "providers.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const reload = () => client.call({ type: "client_reload", sessionId });
  const command = async (message: string) => {
    await client.call({ type: "prompt", sessionId, message });
    await hosted.refreshActivity();
  };
  return { env, oldPath, daemon, client, sessionId, hosted, trace, reload, command };
}

test("removing a ready-registered provider leaves the real SDK session idle and reloadable", { timeout: 30_000 }, async t => {
  const f = await setup(t);
  assert.equal(f.hosted.executionActive, false);
  assert.equal(f.trace().filter(row => row.event === "ready").length, 1);
  unlinkSync(f.oldPath);
  await f.reload();
  assert.equal(f.hosted.executionActive, false, "stopped provider must not register again on ready");
  await f.reload();
  await f.client.call({ type: "client_packages_install", cwd: f.env.cwd, packages: [] });
  assert.equal(f.hosted.executionActive, false);
  assert.equal(f.daemon.registry.get(f.sessionId), f.hosted);
  assert.deepEqual(f.trace().filter(row => row.event !== "start").map(row => row.event), ["ready", "subscribe", "shutdown", "unsubscribe"]);
});

test("same-id replacement providers stay observable across repeated reloads without orphan listeners", { timeout: 30_000 }, async t => {
  const f = await setup(t);
  unlinkSync(f.oldPath);
  providerExtension(f.env, "replacement", true);
  const events: Array<{ type?: string; message?: string }> = [];
  const unsubscribe = f.hosted.addListener(logged => events.push(logged.event as typeof events[number]));
  t.after(unsubscribe);

  for (let generation = 1; generation <= 3; generation++) {
    // Exercise the hosted runtime directly: the replacement deliberately starts active,
    // so host maintenance reports partial completion after its final idle check.
    await f.hosted.reload();
    assert.equal(f.hosted.executionActive, true, "fresh replacement activity must protect owned work");
    await assert.rejects(f.reload(), /Wait for remote/);
    await assert.rejects(f.client.call({ type: "client_packages_install", cwd: f.env.cwd, packages: [] }), /Wait for remote/);
    await f.command("/provider-probe");
    await f.command("/provider-idle");
    assert.equal(f.hosted.executionActive, false);
    const rows = f.trace();
    assert.equal(rows.filter(row => row.version === "old" && row.event === "ready").length, 1);
    assert.equal(rows.filter(row => row.version === "replacement" && row.event === "ready").length, generation);
    assert.equal(rows.filter(row => row.event === "probe").length, generation, "only the current runtime receives each probe");
    assert.equal(rows.filter(row => row.event === "notify").length, generation, "one activity observer per runtime");
    assert.equal(rows.filter(row => row.event === "shutdown-listener" || row.event === "stopped-observation").length, 0);
    assert.equal(rows.filter(row => row.event === "subscribe").length - rows.filter(row => row.event === "unsubscribe").length, 1);
    assert.equal(events.filter(event => event.type === "extension_ui_request" && event.message === "provider replacement").length, generation);
    assert.equal(events.filter(event => event.type === "remote_resources_reloaded").length, generation);
  }
});

test("providers registered during replacement factory construction survive reload cleanup", { timeout: 30_000 }, async t => {
  const f = await setup(t);
  unlinkSync(f.oldPath);
  providerExtension(f.env, "factory", true, true);
  await f.hosted.reload();
  assert.equal(f.hosted.executionActive, true);
  assert.equal(f.trace().filter(row => row.version === "factory" && row.event === "subscribe").length, 1);
  await f.command("/provider-idle");
  assert.equal(f.hosted.executionActive, false);
  assert.equal(f.trace().filter(row => row.version === "factory" && row.event === "notify").length, 1);
});

test("caller-owned resource loaders remain unobservable and retain their own event subscriptions", { timeout: 30_000 }, async t => {
  const events = createEventBus();
  let probes = 0;
  const unsubscribe = events.on("caller:probe", () => { probes++; });
  t.after(unsubscribe);
  let loader: DefaultResourceLoader;
  let reload: DefaultResourceLoader["reload"];
  const f = await setup(t, async env => {
    loader = new DefaultResourceLoader({ cwd: env.cwd, agentDir: env.agentDir, eventBus: events });
    await loader.reload();
    reload = loader.reload;
    return { resourceLoader: loader };
  });
  assert.equal(f.hosted.executionActive, true, "unknown background ownership must remain conservative");
  await assert.rejects(f.reload(), /Wait for remote/);
  assert.equal(f.hosted.session.resourceLoader, loader!);
  assert.equal(loader!.reload, reload!);
  events.emit("caller:probe", {});
  assert.equal(probes, 1);
  assert.equal(f.trace().filter(row => row.event === "shutdown").length, 0);
});
