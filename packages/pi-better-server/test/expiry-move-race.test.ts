import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { MoveService } from "../src/move/service.ts";
import { SessionRegistry } from "../src/registry.ts";
import { llmCalls, makeEnv, waitFor } from "./helpers.ts";

async function setup(t: TestContext) {
  const env = makeEnv();
  Object.assign(process.env, env.vars);
  mkdirSync(env.serverDir);
  const hold = join(env.gateDir, "observe.hold");
  const started = join(env.gateDir, "observe.started");
  const released = join(env.gateDir, "observe.release");
  writeFileSync(join(env.agentDir, "extensions", "observe.ts"), `
    import { existsSync, writeFileSync } from "node:fs";
    export default function (pi) {
      pi.events.emit("pi-better-goal:register-provider", { id: "external-job", async getActivity() {
        if (existsSync(${JSON.stringify(hold)})) {
          writeFileSync(${JSON.stringify(started)}, "yes");
          while (!existsSync(${JSON.stringify(released)})) await new Promise(resolve => setTimeout(resolve, 10));
        }
        return { items: [] };
      } });
    }
  `);
  let now = 0;
  const registry = new SessionRegistry({ serverDir: env.serverDir, sessionIdleMs: 100, now: () => now });
  const release = () => writeFileSync(released, "yes");
  t.after(async () => { release(); await registry.shutdown(); });
  const { sessionId } = await registry.create({ type: "create_session", cwd: env.cwd, model: { provider: "fake", modelId: "fake-1" } });
  const host = registry.get(sessionId)!;
  await host.refreshActivity();
  const moves = new MoveService(registry, env.serverDir);
  return {
    env, registry, sessionId, host, moves, release,
    startExpiry: () => {
      now = 100;
      writeFileSync(hold, "yes");
      return registry.expireIdle();
    },
    observing: () => waitFor("asynchronous idle observation", () => existsSync(started), 3_000),
  };
}

test("an ownership fence winning during asynchronous idle observation prevents expiry and permits move rollback", { timeout: 15_000 }, async t => {
  const f = await setup(t);
  const expiry = f.startExpiry();
  try {
    await f.observing();
    // Exercise the ownership recheck after refreshActivity's await directly:
    // MoveService correctly refuses admission while activity is still unknown.
    f.registry.ownership.fence(f.sessionId, "expiry-race");
  } finally {
    f.release();
    await expiry;
  }
  assert.deepEqual(await expiry, []);
  assert.equal(f.registry.ownership.get(f.sessionId).state, "fenced");
  assert.equal(f.registry.entry(f.sessionId)?.status, "running");
  assert.equal(f.registry.get(f.sessionId), f.host);
  assert.equal(f.host.isDisposed, false);
  await f.moves.handle({ type: "move_unfence", sessionId: f.sessionId, moveId: "expiry-race" });
  assert.equal(f.registry.ownership.get(f.sessionId).state, "owned");
  assert.equal(f.registry.entry(f.sessionId)?.status, "running");
  assert.equal(f.registry.list().find(item => item.sessionId === f.sessionId)?.live, true);
  assert.equal(f.registry.get(f.sessionId), f.host);
  assert.equal(f.host.isDisposed, false);
});

test("move admission rejects unknown activity without changing ownership, then expiry and fencing preserve history", { timeout: 15_000 }, async t => {
  const f = await setup(t);
  assert.equal((await f.host.handle({ type: "prompt", message: "retained history" })).success, true);
  await f.host.session.waitForIdle();
  await waitFor("hosted work to settle", () => !f.host.executionActive, 3_000);
  await f.host.refreshActivity();
  const history = structuredClone(f.host.session.messages);
  assert.deepEqual(history.filter(message => message.role === "user" || message.role === "assistant").map(message => message.role), ["user", "assistant"]);
  const sessionFile = f.registry.entry(f.sessionId)!.sessionFile;
  const transcript = readFileSync(sessionFile, "utf8");
  const ownership = { ...f.registry.ownership.get(f.sessionId) };
  const expiry = f.startExpiry();
  let fencing: Promise<void> | undefined;
  try {
    await f.observing();
    assert.equal(f.host.activityChecking, true);
    assert.equal(f.host.executionActive, false);
    let outcome: PromiseSettledResult<Record<string, unknown>> | undefined;
    fencing = f.moves.handle({ type: "move_fence", sessionId: f.sessionId, moveId: "pending-observation", waitMs: 0 }).then(
      value => { outcome = { status: "fulfilled", value }; },
      reason => { outcome = { status: "rejected", reason }; },
    );
    // Bound this wait so a regressed admission guard cannot deadlock cleanup:
    // stop() would otherwise wait behind the still-held expiry operation.
    const result = await waitFor("move admission decision", () => outcome, 3_000);
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") assert.match(String(result.reason), /mid-turn; wait for it to finish/);
    assert.deepEqual(f.registry.ownership.get(f.sessionId), ownership);
    assert.equal(f.registry.get(f.sessionId), f.host);
    assert.equal(f.host.isDisposed, false);
    assert.equal(f.registry.entry(f.sessionId)?.status, "running");
  } finally {
    f.release();
    await Promise.all([expiry, fencing]);
  }
  assert.deepEqual(await expiry, [f.sessionId]);
  assert.equal(f.registry.entry(f.sessionId)?.status, "closed");
  assert.equal(f.registry.get(f.sessionId), undefined);
  assert.equal(f.host.isDisposed, true);
  assert.deepEqual(f.registry.ownership.get(f.sessionId), ownership);
  assert.equal(readFileSync(sessionFile, "utf8"), transcript);

  // Once observation and expiry have settled, fencing the saved session is legal.
  await f.moves.handle({ type: "move_fence", sessionId: f.sessionId, moveId: "after-expiry", waitMs: 0 });
  assert.equal(f.registry.ownership.get(f.sessionId).state, "fenced");
  await assert.rejects(f.registry.open(f.sessionId), /fenced for a move/);
  await f.moves.handle({ type: "move_unfence", sessionId: f.sessionId, moveId: "after-expiry" });
  assert.equal(f.registry.ownership.get(f.sessionId).state, "owned");
  assert.equal(f.registry.entry(f.sessionId)?.status, "closed");
  assert.equal(f.registry.get(f.sessionId), undefined);
  assert.equal(readFileSync(sessionFile, "utf8"), transcript);
  await f.registry.open(f.sessionId);
  assert.equal(f.registry.entry(f.sessionId)?.status, "running");
  assert.deepEqual(f.registry.get(f.sessionId)!.session.messages, history);
  assert.equal(readFileSync(sessionFile, "utf8"), transcript);
  assert.equal(llmCalls(f.env).length, 1);
});
