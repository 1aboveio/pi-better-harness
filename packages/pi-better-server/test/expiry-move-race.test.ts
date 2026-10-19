import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { MoveService } from "../src/move/service.ts";
import { SessionRegistry } from "../src/registry.ts";
import { makeEnv, waitFor } from "./helpers.ts";

test("a move fence winning during asynchronous idle observation prevents expiry and permits rollback", { timeout: 15_000 }, async t => {
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
  t.after(async () => { writeFileSync(released, "yes"); await registry.shutdown(); });
  const session = await registry.create({ type: "create_session", cwd: env.cwd });
  await registry.get(session.sessionId)!.refreshActivity();
  const moves = new MoveService(registry, env.serverDir);
  now = 100;
  writeFileSync(hold, "yes");
  const expiry = registry.expireIdle();
  await waitFor("asynchronous idle observation", () => existsSync(started));
  const fencing = moves.handle({ type: "move_fence", sessionId: session.sessionId, moveId: "expiry-race" });
  await waitFor("move ownership fence", () => registry.ownership.get(session.sessionId).state === "fenced");
  writeFileSync(released, "yes");
  const [expired] = await Promise.all([expiry, fencing]);
  assert.deepEqual(expired, []);
  assert.equal(registry.entry(session.sessionId)?.status, "running");
  await moves.handle({ type: "move_unfence", sessionId: session.sessionId, moveId: "expiry-race" });
  assert.equal(registry.ownership.get(session.sessionId).state, "owned");
  assert.equal(registry.entry(session.sessionId)?.status, "running");
  assert.equal(registry.list().find(item => item.sessionId === session.sessionId)?.live, true);
});