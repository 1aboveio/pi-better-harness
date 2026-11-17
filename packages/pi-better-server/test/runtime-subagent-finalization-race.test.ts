import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const changed of ["none", "pid", "management", "evidence"] as const) {
  test(`fixed launch finalizer handles a borrowed-store race with ${changed} changed`, async t => {
    const root = mkdtempSync(join(tmpdir(), "finalization-race-"));
    const prior = { TMPDIR: process.env.TMPDIR, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
      PI_SUBAGENT_DURABLE_DIR: process.env.PI_SUBAGENT_DURABLE_DIR };
    process.env.TMPDIR = root;
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    process.env.PI_SUBAGENT_DURABLE_DIR = join(root, "durable");
    let closeStore = () => {};
    let unbind = () => {};
    t.after(() => {
      unbind();
      closeStore();
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    });
    const domain = "../src/runtime/domain/subagents/";
    const { bindRuntimeOutcomeStore, commitAssignmentTerminal } = await import(domain + "assignment-outcomes.domain.mjs");
    const { StoreError: LocalStoreError } = await import(domain + "shared-operation-coordinator/index.domain.mjs");
    const { runDir, logPathFor, writeMeta, nextRunId } = await import(domain + "registry.domain.mjs");
    const runtimeCoordinator = "../src/runtime/domain/coordinator/index.mjs";
    const { openStore, StoreError: RuntimeStoreError } = await import(runtimeCoordinator);
    assert.notEqual(LocalStoreError, RuntimeStoreError, "the runtime lends a store from a different module instance");
    const store = openStore({ path: join(process.env.PI_CODING_AGENT_DIR, "operation-coordinator.sqlite") });
    closeStore = () => store.close();
    const id = nextRunId();
    const binding = { version: 1, assignmentId: id,
      owner: { kind: "worker-conversation", sessionId: id, workspace: root, branchId: null, goalId: null },
      recipient: { kind: "parent-session", sessionId: "parent", workspace: root, branchId: null, goalId: null } };
    store.registerAssignment({ ...binding, attemptId: id });
    mkdirSync(runDir(id), { recursive: true });
    writeFileSync(logPathFor(id), "");
    const meta = { id, assignment: binding, status: "completed", exitCode: 0, pid: process.pid, spawnPid: process.pid,
      sessionId: id, cwd: root, promptPreview: "work", startedAt: 1, endedAt: 2, logPath: logPathFor(id),
      management: { root, instance: "original", epoch: 1 } };
    writeMeta(meta);
    let first = true;
    let winner: unknown;
    // Commit between the finalizer's initial read and its write, using the real
    // runtime coordinator so the refusal has its production error prototype.
    const borrowed = new Proxy(store, { get(target, key) {
      if (key !== "getAssignmentOutcome") return Reflect.get(target, key);
      return (assignmentId: string) => {
        if (!first) return target.getAssignmentOutcome(assignmentId);
        first = false;
        winner = target.recordAssignmentOutcome({ ...binding, revision: 1, outcome: "cancelled", reason: "Explicit stop won the race",
          processUncertain: false, waits: [], evidence: [{ kind: "log", ref: changed === "evidence" ? join(root, "foreign.log") : meta.logPath }] });
        if (changed === "pid") writeMeta({ ...meta, pid: meta.pid + 1 });
        if (changed === "management") writeMeta({ ...meta, management: { ...meta.management, epoch: 2 } });
        return null;
      };
    } });
    unbind = bindRuntimeOutcomeStore(process.env.PI_CODING_AGENT_DIR, borrowed);
    if (changed === "none") assert.deepEqual(commitAssignmentTerminal(meta), winner);
    else assert.throws(() => commitAssignmentTerminal(meta), /A terminal assignment cannot be rewritten or reopened/);
    assert.deepEqual(store.getAssignmentOutcome(id), winner, "the winning decision remains immutable");
    assert.equal(store.listOutbox().length, 1, "the race publishes exactly one terminal event");
  });
}
