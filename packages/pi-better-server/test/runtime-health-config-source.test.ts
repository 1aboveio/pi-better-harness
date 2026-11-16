import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHealthConfig } from "../src/runtime/health-config.ts";

test("absent config sources do not wait on the cold namespaced reader", { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "health-source-"));
  let release!: (value: unknown) => void;
  const held = new Promise<unknown>(resolve => { release = resolve; });
  let reads = 0;
  let observation: ReturnType<typeof readHealthConfig> | undefined;
  try {
    observation = readHealthConfig(root, true, () => { reads++; return held; });
    assert.equal(reads, 0, "verified absent sources require no external reader or SDK initialization");
    const value = await observation;
    assert.deepEqual(value.config, {});
    assert.equal(value.reason, undefined);
  } finally {
    release(undefined); await observation;
    rmSync(root, { recursive: true, force: true });
  }
});

test("config creation, namespace precedence, malformed input and removal retain effective revisions", { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "health-source-changes-"));
  const settings = join(root, "settings.json"), legacy = join(root, "extensions", "pi-better-subagents-config.json");
  try {
    const absent = await readHealthConfig(root);
    writeFileSync(settings, JSON.stringify({ piBetterHarness: { subagents: { healthQuietMs: 1000 } } }));
    const namespaced = await readHealthConfig(root);
    assert.equal(namespaced.config.healthQuietMs, 1000);
    assert.notEqual(namespaced.revision, absent.revision);
    writeFileSync(settings, "broken");
    assert.match((await readHealthConfig(root)).reason!, /Health configuration unavailable/);
    rmSync(settings); mkdirSync(settings);
    assert.match((await readHealthConfig(root)).reason!, /Health configuration unavailable/);
    rmSync(settings, { recursive: true }); mkdirSync(join(root, "extensions"));
    writeFileSync(legacy, JSON.stringify({ healthQuietMs: 2000 }));
    assert.equal((await readHealthConfig(root)).config.healthQuietMs, 2000);
    writeFileSync(settings, JSON.stringify({ piBetterHarness: { subagents: { healthQuietMs: 3000 } } }));
    assert.equal((await readHealthConfig(root)).config.healthQuietMs, 3000);
    rmSync(settings); rmSync(legacy);
    const removed = await readHealthConfig(root);
    assert.deepEqual(removed.config, {});
    assert.equal(removed.reason, undefined);
    assert.equal(removed.revision, absent.revision);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
