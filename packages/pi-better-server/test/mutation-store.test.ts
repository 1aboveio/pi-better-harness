import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { acquireMutationStore, mutationStoreMetrics } from "../src/runtime/mutation-store.ts";
import { makeEnv } from "./helpers.ts";

test("managed launch shares the mutation connection and releases only its lease", async () => {
  const env = makeEnv();
  const { createSubagentLaunch } = await import("../src/runtime/subagent-launch.ts");
  const first = acquireMutationStore(env.agentDir);
  let host: any;
  try {
    host = await createSubagentLaunch(env.agentDir, "shared-launch", {});
    assert.deepEqual(mutationStoreMetrics(env.agentDir), { active: 1, leases: 2 });
    await host.initialize();
    assert.equal(host.status().continuationReady, true, "managed SDK registers the fixed continuation adapter");
    assert.deepEqual(mutationStoreMetrics(env.agentDir), { active: 1, leases: 2 });
    const journal = first.store.subagentLaunchJournal();
    assert.equal(host.status().runtimeEpoch, journal.epoch("shared-launch"));
    await host.close();
    assert.deepEqual(mutationStoreMetrics(env.agentDir), { active: 1, leases: 1 });
    journal.accept("owner", "request", "digest", journal.epoch("shared-launch"));
    assert.equal(journal.read("owner", "request").state, "accepted");
    first.release();
    assert.throws(() => journal.read("owner", "request"), /closed/i);
  } finally { await host?.close(); first.release(); }
  assert.deepEqual(mutationStoreMetrics(env.agentDir), { active: 0, leases: 0 });
});

test("mutation services share a canonical root connection until its final lease closes", () => {
  const env = makeEnv();
  const alias = join(env.root, "alias");
  symlinkSync(env.agentDir, alias);
  const first = acquireMutationStore(env.agentDir), second = acquireMutationStore(alias);
  try {
    assert.equal(first.store, second.store);
    assert.deepEqual(mutationStoreMetrics(alias), { active: 1, leases: 2 });
    const epoch = first.store.cancellationRuntimeEpoch("first");
    first.release(); first.release();
    assert.deepEqual(mutationStoreMetrics(env.agentDir), { active: 1, leases: 1 });
    assert.equal(second.store.cancellationRuntimeEpoch("first"), epoch);
    const otherRoot = join(env.root, "other"); mkdirSync(otherRoot);
    const other = acquireMutationStore(otherRoot);
    try { assert.notEqual(other.store, second.store); } finally { other.release(); }
  } finally { first.release(); second.release(); }
  assert.deepEqual(mutationStoreMetrics(env.agentDir), { active: 0, leases: 0 });
  const reopened = acquireMutationStore(env.agentDir);
  try {
    assert.notEqual(reopened.store, first.store);
    assert.ok(reopened.store.cancellationRuntimeEpoch("next") > 0);
  } finally { reopened.release(); }
});

test("failed launch construction releases its mutation lease and permits a clean retry", async () => {
  const env = makeEnv();
  const { createSubagentLaunch } = await import("../src/runtime/subagent-launch.ts");
  const seed = acquireMutationStore(env.agentDir);
  seed.store.subagentLaunchJournal(); seed.release();
  const db = new DatabaseSync(join(env.agentDir, "operation-coordinator.sqlite"));
  try {
    db.exec("CREATE TRIGGER fail_launch_epoch BEFORE INSERT ON subagent_management BEGIN SELECT RAISE(ABORT, 'injected epoch failure'); END");
    await assert.rejects(createSubagentLaunch(env.agentDir, "retry-launch", {}), /injected epoch failure/);
    assert.deepEqual(mutationStoreMetrics(env.agentDir), { active: 0, leases: 0 });
    db.exec("DROP TRIGGER fail_launch_epoch");
    const host = await createSubagentLaunch(env.agentDir, "retry-launch", {});
    await host.close();
    assert.deepEqual(mutationStoreMetrics(env.agentDir), { active: 0, leases: 0 });
  } finally { db.close(); }
});

test("unavailable continuation authority backs off without retaining active work", async () => {
  const env = makeEnv();
  const { createSubagentLaunch } = await import("../src/runtime/subagent-launch.ts");
  const host = await createSubagentLaunch(env.agentDir, "retry-owner", {});
  try {
    const park = { runId: "missing-authority", waitId: "wait", generation: 1 };
    const run = async () => { throw new Error("unavailable authority must not dispatch"); };
    assert.equal(await host.dispatchContinuation(park, run), "skipped");
    const first = host.status().continuationUnavailable[0];
    assert.match(first.reason, /authority unavailable/);
    assert.equal(first.failures, 1);
    assert.equal(await host.dispatchContinuation(park, run), "skipped");
    assert.deepEqual(host.status().continuationUnavailable[0], first);
    assert.equal(host.busy, false);
    for (let i = 0; i < 130; i++) await host.dispatchContinuation({ ...park, waitId: `wait-${i}` }, run);
    assert.equal(host.status().continuationUnavailable.length, 32, "global admission budget also bounds a flood of distinct generations");
    assert.equal(host.busy, false);
  } finally { await host.close(); }
});

test("managed SDK shutdown publishes worker unavailability before disposing extension context", async () => {
  const env = makeEnv();
  const { createSubagentLaunch } = await import("../src/runtime/subagent-launch.ts");
  const host = await createSubagentLaunch(env.agentDir, "sdk-close-order", {});
  await host.initialize();
  let disposed = false;
  let unavailable = false;
  let publishedWhileLive = false;
  const session = host.session;
  const dispose = session.dispose.bind(session);
  session.dispose = () => { disposed = true; return dispose(); };
  host.api.events.on("pi-better-background-tasks:observed-waits-service", (value: any) => {
    if (value?.available !== false) return;
    unavailable = true;
    publishedWhileLive = !disposed;
    host.api.getAllTools();
  });
  try { await host.close(); }
  finally { await host.close(); }
  assert.equal(unavailable, true);
  assert.equal(publishedWhileLive, true, "service subscribers still own a live SDK context during shutdown");
  assert.equal(disposed, true);
  assert.deepEqual(mutationStoreMetrics(env.agentDir), { active: 0, leases: 0 });
});
