import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundObservation } from "../src/runtime/background.ts";
import { openStore } from "../../operation-coordinator/index.ts";

test("one Background task input changes only its projection and dependent wait query", async () => {
  const root = mkdtempSync(join(tmpdir(), "background-inputs-"));
  const directory = join(root, "supervisor");
  const store = openStore({ path: join(root, "operation-coordinator.sqlite") });
  const observation = new BackgroundObservation(root, directory);
  const owner = { kind: "parent-session" as const, workspace: root, sessionId: "parent" };
  const scope = { background: true, cwd: root, sessionId: "parent" };
  const ids = Array.from({ length: 96 }, (_, i) => `bgs_${i.toString(16).padStart(20, "0")}`);
  mkdirSync(join(directory, "observed"), { recursive: true });
  try {
    for (const taskId of ids) {
      store.registerOperation({ operationId: taskId, taskId, launchToken: taskId, owner,
        observer: { kind: "local-supervisor", version: "1" } });
      store.recordTerminalOutcome({ operationId: taskId, eventId: taskId, owner, outcome: "succeeded",
        evidence: [{ kind: "terminal-record", ref: taskId }] });
    }
    assert.equal(observation.read(scope).length, 96);
    const before = { ...observation.metrics };
    store.registerOperation({ operationId: "unrelated", taskId: "unrelated", launchToken: "unrelated", owner,
      observer: { kind: "other", version: "1" } });
    observation.refresh();
    assert.equal(observation.metrics.runnerSnapshots, before.runnerSnapshots);
    assert.equal(observation.metrics.dependencyQueries, before.dependencyQueries);
    assert.ok(observation.metrics.inputStats > before.inputStats, "bounded file repair work remains explicitly counted");

    const path = join(directory, "observed", `${ids[0]}.json`);
    writeFileSync(path + ".tmp", JSON.stringify({ name: "changed" }));
    renameSync(path + ".tmp", path);
    observation.refresh();
    assert.equal(observation.metrics.runnerSnapshots, before.runnerSnapshots + 1);
    assert.equal(observation.read(scope).find(row => row.id === ids[0]).name, "changed");
    const dependencies = observation.metrics.dependencyQueries;
    store.registerWait({ waitId: "exact-wait", owner, dependencies: [{ operationId: ids[0]! }], continuationNote: "Read result" });
    observation.refresh();
    assert.equal(observation.metrics.runnerSnapshots, before.runnerSnapshots + 2);
    assert.equal(observation.metrics.dependencyQueries, dependencies + 1);
    assert.equal(observation.read(scope).find(row => row.id === ids[0]).waits[0].waitId, "exact-wait");

    writeFileSync(path, "{");
    observation.refresh();
    assert.equal(observation.status, "degraded");
    assert.equal(observation.read(scope).find(row => row.id === ids[0]).name, "changed");
    writeFileSync(path, JSON.stringify({ name: "recovered" }));
    observation.refresh();
    assert.equal(observation.status, "ready");
    assert.equal(observation.read(scope).find(row => row.id === ids[0]).name, "recovered");
  } finally { await observation.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
