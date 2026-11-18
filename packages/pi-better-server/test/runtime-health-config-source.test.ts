import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHealthConfig } from "../src/runtime/health-config.ts";
import { healthThresholdsForConfig } from "../src/runtime/domain/health-observation.mjs";

test("absent sources retain environment defaults while explicit config takes precedence", async () => {
  const root = mkdtempSync(join(tmpdir(), "health-source-env-"));
  const quiet = process.env.PI_BETTER_STALL_QUIET_MS, stale = process.env.PI_BETTER_STALL_MS;
  try {
    process.env.PI_BETTER_STALL_QUIET_MS = "1234";
    process.env.PI_BETTER_STALL_MS = "5678";
    const absent = await readHealthConfig(root);
    assert.equal(healthThresholdsForConfig(absent.config).quietMs, 1234);
    assert.equal(healthThresholdsForConfig(absent.config).staleMs, 5678);
    const settings = join(root, "settings.json");
    writeFileSync(settings, JSON.stringify({ piBetterHarness: { subagents: { healthQuietMs: 2222, healthStaleMs: 7777 } } }));
    const explicit = await readHealthConfig(root);
    assert.equal(healthThresholdsForConfig(explicit.config).quietMs, 2222);
    assert.equal(healthThresholdsForConfig(explicit.config).staleMs, 7777);
    assert.notEqual(explicit.revision, absent.revision);
    writeFileSync(settings, "malformed");
    const malformed = await readHealthConfig(root);
    assert.match(malformed.reason!, /Health configuration unavailable/);
    assert.equal(malformed.revision, absent.revision);
    assert.equal(healthThresholdsForConfig(malformed.config).quietMs, 1234);
    rmSync(settings);
    const removed = await readHealthConfig(root);
    assert.equal(removed.reason, undefined);
    assert.equal(removed.revision, absent.revision);
  } finally {
    if (quiet === undefined) delete process.env.PI_BETTER_STALL_QUIET_MS; else process.env.PI_BETTER_STALL_QUIET_MS = quiet;
    if (stale === undefined) delete process.env.PI_BETTER_STALL_MS; else process.env.PI_BETTER_STALL_MS = stale;
    rmSync(root, { recursive: true, force: true });
  }
});

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

test("absent, legacy and namespaced sources preserve environment fallback and explicit threshold precedence", async () => {
  const root = mkdtempSync(join(tmpdir(), "health-source-env-"));
  const keys = ["PI_BETTER_STALL_QUIET_MS", "PI_BETTER_STALL_MS"] as const;
  const saved = keys.map(key => process.env[key]);
  try {
    process.env.PI_BETTER_STALL_QUIET_MS = "1234";
    process.env.PI_BETTER_STALL_MS = "5678";
    const absent = await readHealthConfig(root);
    assert.deepEqual(healthThresholdsForConfig(absent.config), {
      quietMs: 1234, staleMs: 5678, longToolMs: 120000, longCompactionMs: 120000,
    });
    mkdirSync(join(root, "extensions"));
    writeFileSync(join(root, "extensions/pi-better-subagents-config.json"), JSON.stringify({ healthQuietMs: 2000 }));
    const legacy = await readHealthConfig(root);
    assert.equal(healthThresholdsForConfig(legacy.config).quietMs, 2000);
    assert.equal(healthThresholdsForConfig(legacy.config).staleMs, 5678);
    assert.notEqual(legacy.revision, absent.revision);
    writeFileSync(join(root, "settings.json"), JSON.stringify({ piBetterHarness: { subagents: { healthQuietMs: 3000, healthStaleMs: 7000 } } }));
    const explicit = await readHealthConfig(root);
    assert.equal(healthThresholdsForConfig(explicit.config).quietMs, 3000);
    assert.equal(healthThresholdsForConfig(explicit.config).staleMs, 7000);
    assert.notEqual(explicit.revision, legacy.revision);
  } finally {
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
    rmSync(root, { recursive: true, force: true });
  }
});
