import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireMutationStore, mutationStoreMetrics } from "../src/runtime/mutation-store.ts";

const domain = new URL("../src/runtime/domain/subagents/", import.meta.url);
const { finalizeRun } = await import(new URL("finalization.domain.mjs", domain).href);
const { bindRuntimeOutcomeStore } = await import(new URL("assignment-outcomes.domain.mjs", domain).href);
const { StoreError: SubagentStoreError } = await import(new URL("shared-operation-coordinator/index.domain.mjs", domain).href);
const { writeMeta, readMeta, runDir, logPathFor } = await import(new URL("registry.domain.mjs", domain).href);

// Ported from 802/4ec3a5ee: real borrowed transactions with an interleaved winner.
const conflicts = ["same-attempt", "writer", "token", "recipient", "evidence", "revision", "other-validation"];
for (const [index, conflict] of conflicts.entries()) {
  test(`borrowed canonical finalizer preserves terminal winner and fences ${conflict}`, () => {
    const root = mkdtempSync(join(tmpdir(), "terminal-finalizer-"));
    const saved = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    const { store, release } = acquireMutationStore(root);
    const unbind = bindRuntimeOutcomeStore(root, store);
    const id = `sa_exit_${index}`;
    const owner = { kind: "worker-conversation", sessionId: id, workspace: root };
    const recipient = { kind: "parent-session", sessionId: "parent", workspace: root };
    const assignment = { version: 1, assignmentId: id, owner, recipient };
    const record = store.recordAssignmentOutcome.bind(store);
    let winner: any;
    let rejected: unknown;
    try {
      store.registerAssignment({ ...assignment, attemptId: id });
      mkdirSync(runDir(id), { recursive: true });
      writeFileSync(logPathFor(id), JSON.stringify({ type: "agent_end", messages: [] }) + "\n");
      writeMeta({ id, assignment, sessionId: id, cwd: root, status: "running", startedAt: 1,
        pid: 4194304, pidStartTime: "captured-child", spawnPid: 4194304,
        logPath: logPathFor(id), callback: false,
        management: { root, instanceId: "captured-manager" }, operations: { resumeLaunchToken: "captured-token" } });
      store.recordAssignmentOutcome = (input: any) => {
        if (conflict === "other-validation") return record({ ...input, reason: "" });
        winner = record({ ...input, outcome: "cancelled", reason: "Parent stopped the attempt",
          revision: conflict === "revision" ? 2 : input.revision,
          evidence: conflict === "evidence" ? [{ kind: "log", ref: "another-attempt.log" }] : input.evidence });
        const current = readMeta(id);
        if (conflict === "writer") writeMeta({ ...current, management: { ...current.management, instanceId: "replacement-manager" } });
        if (conflict === "token") writeMeta({ ...current, operations: { ...current.operations, resumeLaunchToken: "replacement-token" } });
        if (conflict === "recipient") writeMeta({ ...current, assignment: { ...assignment, recipient: { ...recipient, sessionId: "foreign" } } });
        try { return record(input); } catch (error) { rejected = error; throw error; }
      };
      if (conflict === "same-attempt") {
        const result = finalizeRun(id, 1);
        assert.equal(result.applied, true);
        assert.equal(result.meta.status, "failed", "the child exit is not invented assignment success");
        assert.equal((rejected as Error).name, "StoreError");
        assert.equal(rejected instanceof SubagentStoreError, false, "the borrowed store has a distinct error constructor");
        assert.deepEqual(store.getAssignmentOutcome(id), winner);
        assert.equal(finalizeRun(id, 1).applied, false);
        store.receiptAssignmentOutcome({ assignmentId: id, recipient, revision: 1, entryId: "durable-entry" });
        store.receiptAssignmentOutcome({ assignmentId: id, recipient, revision: 1, entryId: "duplicate-entry" });
        store.inspectAssignmentOutcome({ assignmentId: id, recipient, revision: 1 });
        const request = { assignmentId: id, recipient, revision: 1, disposition: "consumed", note: "Inspected winner" };
        const consumed = store.consumeAssignmentOutcome(request);
        assert.deepEqual(store.consumeAssignmentOutcome(request), consumed);
        assert.equal(consumed.deliveryReceipt.entryId, "durable-entry");
        assert.equal(store.listOutbox().filter((event: any) => event.eventId === winner.eventId).length, 1);
        assert.equal(store.listOutbox().find((event: any) => event.eventId === winner.eventId).state, "acknowledged");
        assert.throws(() => record({ ...winner, outcome: "succeeded" }), /cannot be rewritten or reopened/);
      } else {
        assert.throws(() => finalizeRun(id, 1), conflict === "other-validation" ? /reason/ : /cannot be rewritten or reopened/);
        assert.deepEqual(store.getAssignmentOutcome(id), winner ?? null);
      }
      assert.deepEqual(mutationStoreMetrics(root), { active: 1, leases: 1 }, "finalization borrows the existing mutation handle");
    } finally {
      store.recordAssignmentOutcome = record;
      unbind(); release(); rmSync(runDir(id), { recursive: true, force: true });
      if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved;
      rmSync(root, { recursive: true, force: true });
    }
  });
}
