import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { startDaemon } from "../src/server.ts";
import { inspectDaemonOwner } from "../src/daemon-owner.ts";
import { acquireMutationStore, mutationStoreMetrics } from "../src/runtime/mutation-store.ts";
import { indexPathFor } from "../src/paths.ts";
import { makeEnv } from "./helpers.ts";

test("failed registry construction releases recovered mutation services and their owner", async () => {
  const env = makeEnv();
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = env.agentDir;
  try {
    mkdirSync(env.serverDir);
    const lease = acquireMutationStore(env.agentDir); lease.release();
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    const db = new DatabaseSync(join(env.agentDir, "operation-coordinator.sqlite"));
    db.prepare("INSERT INTO coordinator_state (key, value) VALUES (?, ?)").run("result-supervision-v1:completed-history", "{}");
    db.close();
    writeFileSync(indexPathFor(env.serverDir), "{broken");
    await assert.rejects(startDaemon({ serverDir: env.serverDir }), SyntaxError);
    assert.deepEqual(mutationStoreMetrics(env.agentDir), { active: 0, leases: 0 });
    assert.equal((globalThis as any)[Symbol.for("pi-better-server:result-supervision-ports-v1")]?.has(env.agentDir), false);
    assert.equal(inspectDaemonOwner(env.serverDir).status, "missing");
    unlinkSync(indexPathFor(env.serverDir));
    const daemon = await startDaemon({ serverDir: env.serverDir });
    await daemon.stop();
    assert.deepEqual(mutationStoreMetrics(env.agentDir), { active: 0, leases: 0 });
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});
