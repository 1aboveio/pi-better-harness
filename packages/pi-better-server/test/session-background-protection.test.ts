import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { SessionRegistry } from "../src/registry.ts";
import { SessionActivity } from "../src/session-activity.ts";
import { HostedSession } from "../src/hosted-session.ts";
import { EventLog } from "../src/event-log.ts";
import { makeEnv } from "./helpers.ts";

const DAY = 86_400_000;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(mode: "scoped" | "legacy" | "failure" = "scoped", sessionIdleMs?: number) {
  const env = makeEnv();
  Object.assign(process.env, env.vars);
  mkdirSync(env.serverDir, { recursive: true });
  const providerUrl = new URL("../../pi-better-subagents/goal-provider.ts", import.meta.url).href;
  const registryUrl = new URL("../../pi-better-subagents/registry.ts", import.meta.url).href;
  writeFileSync(join(env.agentDir, "extensions", "subagent-activity.ts"), `
    import { registerSubagentsGoalProvider } from ${JSON.stringify(providerUrl)};
    import { writeMeta, removeMetaArtifacts } from ${JSON.stringify(registryUrl)};
    export default function(pi) {
      ${mode === "scoped" ? "registerSubagentsGoalProvider(pi);" : `
      // Adapt the real provider to the installed legacy process-wide contract.
      const bus = { emit(event, provider) {
        if (event !== "pi-better-goal:register-provider") return;
        const { scope, ...legacy } = provider;
        pi.events.emit(event, { ...legacy, getActivity: () => ${mode === "failure" ? 'Promise.reject(new Error("observer offline"))' : "provider.getActivity()"} });
      }, on: pi.events.on.bind(pi.events) };
      registerSubagentsGoalProvider({ events: bus });
      `}
      pi.registerCommand("write-run", {
        description: "Publish real run metadata",
        handler: async (args) => writeMeta(JSON.parse(args))
      });
      pi.registerCommand("remove-run", {
        description: "Remove test-owned run metadata",
        handler: async (args) => { removeMetaArtifacts(JSON.parse(args)); }
      });
      pi.registerCommand("reregister-activity", {
        description: "Repeat goal-ready registration",
        handler: async () => pi.events.emit("pi-better-goal:ready", {})
      });
    }
  `);
  let clock = 0;
  const logs: string[] = [];
  const registry = new SessionRegistry({ serverDir: env.serverDir, sessionIdleMs, now: () => clock, log: (line) => logs.push(line) });
  cleanups.push(() => registry.shutdown());
  const first = await registry.create({ type: "create_session", cwd: env.cwd });
  const host = registry.get(first.sessionId)!;
  return { env, registry, host, sessionId: first.sessionId, logs, at: (time: number) => { clock = time; } };
}

async function writeRun(f: Awaited<ReturnType<typeof setup>>, meta: object) {
  const runner = f.host.session.extensionRunner;
  await runner.getCommand("write-run")!.handler(JSON.stringify(meta), runner.createCommandContext());
}

async function seed(f: Awaited<ReturnType<typeof setup>>, id: string, status: "running" | "orphaned" = "running") {
  const meta = {
    id, status, pid: process.pid, spawnPid: process.pid, cwd: "/separate-child-worktree",
    callbackOrigin: { cwd: f.env.cwd, sessionId: f.sessionId },
    promptPreview: id, startedAt: 0, logPath: join(f.env.root, `${id}.log`), sessionId: `child-${id}`,
  };
  await writeRun(f, meta);
  cleanups.push(async () => {
    const runner = f.host.session.extensionRunner;
    await runner.getCommand("remove-run")!.handler(JSON.stringify(meta), runner.createCommandContext());
  });
  return meta;
}

for (const status of ["running", "orphaned"] as const) {
  it(`protects own ${status} subagents beyond 24h, expires an unrelated same-cwd session, then grants a full fresh window`, async () => {
    const f = await setup();
    const second = await f.registry.create({ type: "create_session", cwd: f.env.cwd });
    const meta = await seed(f, `sa_idle_${status}`, status);
    await f.host.refreshActivity();
    assert.equal(f.host.executionActive, true);
    f.at(2 * DAY);
    assert.deepEqual(await f.registry.expireIdle(), [second.sessionId]);
    assert.equal(f.registry.get(f.sessionId), f.host);
    assert.equal(f.logs.some((line) => line.includes("legacy subagents")), false);
    await writeRun(f, { ...meta, status: "completed", endedAt: 2 * DAY });
    await f.host.refreshActivity();
    assert.equal(f.host.executionActive, false);
    assert.equal(f.registry.entry(f.sessionId)?.lastActivityAt, new Date(2 * DAY).toISOString());
    f.at(3 * DAY - 1);
    assert.deepEqual(await f.registry.expireIdle(), []);
    f.at(3 * DAY);
    assert.deepEqual(await f.registry.expireIdle(), [f.sessionId]);
  });
}

it("conservatively protects both sessions with a legacy provider and starts fresh windows on completion", async () => {
  const f = await setup("legacy");
  const second = await f.registry.create({ type: "create_session", cwd: f.env.cwd });
  const meta = await seed(f, "sa_idle_legacy");
  f.at(2 * DAY);
  assert.deepEqual(await f.registry.expireIdle(), []);
  assert.equal(f.registry.get(second.sessionId)!.executionActive, true);
  for (let i = 0; i < 3; i++) {
    const runner = f.host.session.extensionRunner;
    await runner.getCommand("reregister-activity")!.handler("", runner.createCommandContext());
    await f.host.refreshActivity();
  }
  assert.equal(f.logs.filter((line) => line.includes("without session ownership")).length, 2);
  await writeRun(f, { ...meta, status: "completed", endedAt: 2 * DAY });
  assert.deepEqual(await f.registry.expireIdle(), []);
  for (const id of [f.sessionId, second.sessionId]) {
    assert.equal(f.registry.entry(id)?.lastActivityAt, new Date(2 * DAY).toISOString());
  }
  f.at(3 * DAY - 1);
  assert.deepEqual(await f.registry.expireIdle(), []);
  f.at(3 * DAY);
  assert.deepEqual(new Set(await f.registry.expireIdle()), new Set([f.sessionId, second.sessionId]));
});

it("fails closed when a provider cannot observe activity without preventing manual close", async () => {
  const f = await setup("failure");
  f.at(2 * DAY);
  assert.deepEqual(await f.registry.expireIdle(), []);
  assert.equal(f.host.executionActive, true);
  assert.ok(f.logs.some((line) => line.includes("observer offline")));
  await f.registry.close(f.sessionId);
  assert.equal(f.registry.get(f.sessionId), undefined);
  assert.equal(f.host.isDisposed, true);
});

it("an unobservable loader stays busy across refresh and cannot signal a false idle transition; manual disposal still works", async () => {
  const f = await setup();
  const activity = new SessionActivity(() => undefined);
  activity.markUnobservable();
  const hosted = new HostedSession(f.host.session, new EventLog(join(f.env.serverDir, "unobservable.jsonl")), () => undefined, activity);
  cleanups.push(() => hosted.dispose({ abort: true }));
  let transitions = 0;
  activity.attach(f.host.session, () => { transitions++; });
  f.at(2 * DAY);
  await hosted.refreshActivity();
  assert.equal(hosted.executionActive, true);
  assert.equal(hosted.activityChecking, false);
  activity.markUnobservable();
  await hosted.refreshActivity();
  assert.equal(hosted.executionActive, true);
  assert.equal(transitions, 0);
  await hosted.dispose({ abort: true });
  assert.equal(hosted.isDisposed, true);
});

it("markUnobservable immediately notifies an attached idle observer and remains sticky", async () => {
  const f = await setup();
  const activity = new SessionActivity(() => undefined);
  cleanups.push(() => activity.dispose());
  let transitions = 0;
  activity.attach(f.host.session, () => { transitions++; });
  await activity.refresh();
  assert.equal(activity.busy, false);
  activity.markUnobservable();
  assert.equal(activity.busy, true);
  assert.equal(transitions, 1);
  await activity.refresh();
  activity.markUnobservable();
  assert.equal(activity.busy, true);
  assert.equal(transitions, 1);
});

it("zero still disables expiry with a registered provider and manual close still releases busy sessions", async () => {
  const f = await setup("legacy", 0);
  await seed(f, "sa_idle_disabled");
  await f.host.refreshActivity();
  assert.equal(f.host.executionActive, true);
  f.at(1000 * DAY);
  assert.deepEqual(await f.registry.expireIdle(), []);
  await f.registry.close(f.sessionId);
  assert.equal(f.registry.entry(f.sessionId)?.status, "closed");
  assert.equal(f.host.isDisposed, true);
});
