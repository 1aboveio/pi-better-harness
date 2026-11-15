import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { acquireMutationStore } from "../src/runtime/mutation-store.ts";
import { makeEnv } from "./helpers.ts";

test("mutation services share a canonical root connection until its final lease closes", () => {
  const env = makeEnv();
  const alias = join(env.root, "alias");
  symlinkSync(env.agentDir, alias);
  const first = acquireMutationStore(env.agentDir), second = acquireMutationStore(alias);
  try {
    assert.equal(first.store, second.store);
    const epoch = first.store.cancellationRuntimeEpoch("first");
    first.release(); first.release();
    assert.equal(second.store.cancellationRuntimeEpoch("first"), epoch);
    const otherRoot = join(env.root, "other"); mkdirSync(otherRoot);
    const other = acquireMutationStore(otherRoot);
    try { assert.notEqual(other.store, second.store); } finally { other.release(); }
  } finally { first.release(); second.release(); }
  const reopened = acquireMutationStore(env.agentDir);
  try {
    assert.notEqual(reopened.store, first.store);
    assert.ok(reopened.store.cancellationRuntimeEpoch("next") > 0);
  } finally { reopened.release(); }
});
