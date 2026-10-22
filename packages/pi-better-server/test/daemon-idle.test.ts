import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { readLifecycleConfig } from "../src/lifecycle-config.ts";
import { DaemonClient } from "../src/client.ts";
import { startDaemon } from "../src/server.ts";
import { Client, makeEnv } from "./helpers.ts";

test("lifetime settings validate durations and resolve options, environment, saved settings and defaults", () => {
  const env = makeEnv();
  mkdirSync(env.serverDir);
  assert.deepEqual(readLifecycleConfig(env.serverDir, {}, {}), { sessionIdleMs: 86_400_000, daemonIdleMs: 1_800_000 });
  writeFileSync(join(env.serverDir, "lifecycle.json"), JSON.stringify({ sessionIdleMs: 24, daemonIdleMs: 30 }));
  assert.deepEqual(readLifecycleConfig(env.serverDir, { sessionIdleMs: 0 }, { PI_SERVER_DAEMON_IDLE_MS: "90" }), { sessionIdleMs: 0, daemonIdleMs: 90 });
  assert.deepEqual(readLifecycleConfig(env.serverDir, {}, {}), { sessionIdleMs: 24, daemonIdleMs: 30 });
  for (const value of ["", "-1", "NaN", "1.5", "true"]) assert.throws(() => readLifecycleConfig(env.serverDir, {}, { PI_SERVER_SESSION_IDLE_MS: value }), /non-negative integer/);
  writeFileSync(join(env.serverDir, "lifecycle.json"), JSON.stringify({ daemonIdleMs: null }));
  assert.throws(() => readLifecycleConfig(env.serverDir, {}, {}), /non-negative integer/);
});

test("empty daemon expires despite a polling client and releases ownership for restart", async t => {
  const env = makeEnv();
  Object.assign(process.env, env.vars);
  let now = 1_000;
  const daemon = await startDaemon({ serverDir: env.serverDir, sessionIdleMs: 0, daemonIdleMs: 100, startupGraceMs: 0, now: () => now });
  t.after(() => daemon.stop());
  const client = await Client.connect(daemon.socketPath);
  t.after(() => client.close());
  now += 99;
  assert.equal((await client.request({ type: "list_sessions" })).success, true);
  await daemon.sweepIdle();
  assert.equal(existsSync(daemon.socketPath), true);
  now++;
  await daemon.sweepIdle();
  await daemon.closed;
  assert.equal(existsSync(daemon.socketPath), false);
  const next = await startDaemon({ serverDir: env.serverDir, sessionIdleMs: 0, daemonIdleMs: 0 });
  await next.stop();
});

test("one open session prevents empty shutdown after disconnect; closing it starts a fresh window", async t => {
  const env = makeEnv();
  Object.assign(process.env, env.vars);
  let now = 1_000;
  const daemon = await startDaemon({ serverDir: env.serverDir, sessionIdleMs: 0, daemonIdleMs: 100, startupGraceMs: 0, now: () => now });
  t.after(() => daemon.stop());
  const client = await Client.connect(daemon.socketPath);
  t.after(() => client.close());
  const created = await client.request({ type: "create_session", cwd: env.cwd });
  assert.equal(created.success, true, JSON.stringify(created));
  client.close();
  now += 10_000;
  await daemon.sweepIdle();
  assert.equal(existsSync(daemon.socketPath), true);
  const second = await Client.connect(daemon.socketPath);
  t.after(() => second.close());
  assert.equal((await second.request({ type: "close_session", sessionId: created.sessionId })).success, true);
  now += 99;
  await daemon.sweepIdle();
  assert.equal(existsSync(daemon.socketPath), true);
  now++;
  await daemon.sweepIdle();
  assert.equal(existsSync(daemon.socketPath), false);
  assert.equal(daemon.registry.entry(created.sessionId)?.status, "closed");
});

test("exclusive ownership rejects another writer before it can resume the same session index", async t => {
  const env = makeEnv();
  Object.assign(process.env, env.vars);
  const first = await startDaemon({ serverDir: env.serverDir, sessionIdleMs: 0, daemonIdleMs: 0 });
  t.after(() => first.stop());
  await assert.rejects(startDaemon({ serverDir: env.serverDir }), /already running/);
  const client = await Client.connect(first.socketPath);
  t.after(() => client.close());
  assert.equal((await client.request({ type: "list_sessions" })).success, true);
});

test("expiry of the last session starts the empty-daemon window rather than stopping immediately", async t => {
  const env = makeEnv();
  Object.assign(process.env, env.vars);
  let now = 1_000;
  const daemon = await startDaemon({ serverDir: env.serverDir, sessionIdleMs: 100, daemonIdleMs: 50, startupGraceMs: 0, now: () => now });
  t.after(() => daemon.stop());
  const client = await Client.connect(daemon.socketPath);
  t.after(() => client.close());
  const created = await client.request({ type: "create_session", cwd: env.cwd });
  assert.equal(created.success, true, JSON.stringify(created));
  now += 100;
  await daemon.sweepIdle();
  assert.equal(daemon.registry.entry(created.sessionId)?.status, "closed");
  assert.equal(existsSync(daemon.socketPath), true);
  now += 49;
  assert.equal((await client.request({ type: "list_sessions" })).data.sessions[0].status, "closed");
  await daemon.sweepIdle();
  assert.equal(existsSync(daemon.socketPath), true);
  now++;
  await daemon.sweepIdle();
  assert.equal(existsSync(daemon.socketPath), false);
});

test("hello provides a bounded connection-start lease without polling renewing it", async t => {
  const env = makeEnv();
  Object.assign(process.env, env.vars);
  let now = 1_000;
  const daemon = await startDaemon({ serverDir: env.serverDir, sessionIdleMs: 0, daemonIdleMs: 100, startupGraceMs: 50, now: () => now });
  t.after(() => daemon.stop());
  now += 99;
  const client = await DaemonClient.connect(daemon.socketPath);
  t.after(() => client.close());
  now++;
  await daemon.sweepIdle();
  assert.equal(existsSync(daemon.socketPath), true);
  now += 48;
  await client.call({ type: "list_sessions" });
  await daemon.sweepIdle();
  assert.equal(existsSync(daemon.socketPath), true);
  now++;
  await daemon.sweepIdle();
  assert.equal(existsSync(daemon.socketPath), false);
});

test("manual shutdown waits for an ongoing maintenance pass before releasing ownership", async t => {
  const env = makeEnv();
  Object.assign(process.env, env.vars);
  const daemon = await startDaemon({ serverDir: env.serverDir, sessionIdleMs: 100, daemonIdleMs: 100 });
  t.after(() => daemon.stop());
  await Promise.all([daemon.sweepIdle(), daemon.stop()]);
  await daemon.closed;
  assert.equal(existsSync(daemon.socketPath), false);
  const next = await startDaemon({ serverDir: env.serverDir, sessionIdleMs: 0, daemonIdleMs: 0 });
  await next.stop();
});

test("shutdown retains writer ownership until an accepted session startup settles", { timeout: 15_000 }, async t => {
  const env = makeEnv();
  Object.assign(process.env, env.vars);
  let started!: () => void;
  let release!: () => void;
  const starting = new Promise<void>(resolve => { started = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const loader = new DefaultResourceLoader({ cwd: env.cwd, agentDir: env.agentDir, extensionFactories: [pi => {
    pi.on("session_start", async () => { started(); await released; });
  }] });
  await loader.reload();
  const daemon = await startDaemon({ serverDir: env.serverDir, sessionOptions: { resourceLoader: loader }, sessionIdleMs: 0, daemonIdleMs: 0 });
  t.after(async () => { release(); await daemon.stop(); });
  const creating = daemon.registry.create({ type: "create_session", cwd: env.cwd });
  void creating.catch(() => undefined);
  await starting;
  const stopping = daemon.stop();
  let raced: Awaited<ReturnType<typeof startDaemon>> | undefined;
  t.after(() => raced?.stop());
  await new Promise<void>(resolve => setImmediate(resolve));
  await assert.rejects(startDaemon({ serverDir: env.serverDir }).then(value => { raced = value; return value; }), /already running/);
  release();
  await Promise.allSettled([creating, stopping]);
  assert.equal(daemon.registry.list().some(session => session.live), false);
  const next = await startDaemon({ serverDir: env.serverDir, sessionIdleMs: 0, daemonIdleMs: 0 });
  await next.stop();
});