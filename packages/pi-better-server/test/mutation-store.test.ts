import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { acquireMutationStore, mutationStoreMetrics } from "../src/runtime/mutation-store.ts";
import { makeEnv } from "./helpers.ts";

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
