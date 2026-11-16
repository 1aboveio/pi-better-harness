import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { WorkReadModel } from "../src/runtime/read-model.ts";
const { openStore } = await import(new URL("../../operation-coordinator/index.ts", import.meta.url).href);

test("status publication tolerates a coordinator whose schema is still initializing", async () => {
  const root = mkdtempSync("/tmp/coordinator-startup-");
  const path = join(root, "operation-coordinator.sqlite");
  mkdirSync(join(root, "runs"));
  new DatabaseSync(path).close();
  const model = new WorkReadModel(root, "startup", { baseDir: root, durableDir: join(root, "durable"), intervalMs: 60000 });
  const observations: unknown[] = [];
  // Match the real worker's revision publication callback.
  model.onChange(() => observations.push(model.observation()));
  try {
    await model.reconcile();
    assert.ok(observations.length > 0);
    assert.doesNotThrow(() => model.observation());
    assert.equal(model.snapshot({ background: true, cwd: root, sessionId: "startup" }).status, "degraded", "unfinished schema must not claim verified background state");
    const store = openStore({ path }); store.close();
    await model.reconcile();
    assert.equal(model.snapshot({ background: true, cwd: root, sessionId: "startup" }).status, "ready");
    assert.deepEqual(model.livenessReasons(), []);
  } finally { await model.close(); rmSync(root, { recursive: true, force: true }); }
});
