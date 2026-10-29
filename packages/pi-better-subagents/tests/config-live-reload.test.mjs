import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, setConfigForTests, setConfigPathForTests, writeDelegationMode } from "../config.ts";

function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), "saved-config-live-"));
    const path = join(root, "settings.json");
    const bundled = join(root, "bundled.json");
    writeFileSync(bundled, JSON.stringify({ delegationMode: "adaptive", maxConcurrent: 4, defaultTools: "read" }));
    setConfigPathForTests(path, bundled);
    t.after(() => {
        setConfigPathForTests(undefined);
        rmSync(root, { recursive: true, force: true });
    });
    const save = (subagents) => writeFileSync(path, JSON.stringify({ theme: "light", piBetterHarness: { subagents, goal: { enabled: true } } }));
    return { root, path, bundled, save };
}

test("saved config reloads same-size edits and atomic replacements with preserved mtime", (t) => {
    const { path, save } = fixture(t);
    save({ maxConcurrent: 6, defaultModel: "local/first" });
    assert.equal(loadConfig().maxConcurrent, 6);
    const original = statSync(path);
    save({ maxConcurrent: 1, defaultModel: "local/other" });
    utimesSync(path, original.atime, original.mtime);
    assert.equal(statSync(path).size, original.size);
    assert.deepEqual(loadConfig(), { delegationMode: "adaptive", maxConcurrent: 1, defaultTools: "read", defaultModel: "local/other" });
    const replacement = path + ".next";
    writeFileSync(replacement, JSON.stringify({ piBetterHarness: { subagents: { maxConcurrent: 3 } } }));
    utimesSync(replacement, original.atime, original.mtime);
    renameSync(replacement, path);
    assert.equal(loadConfig().maxConcurrent, 3);
    assert.equal(loadConfig().defaultModel, undefined);
});

test("missing and invalid saved config keep fallback semantics and recover after external repair", (t) => {
    const { path, save } = fixture(t);
    const fallback = { delegationMode: "adaptive", maxConcurrent: 4, defaultTools: "read" };
    assert.deepEqual(loadConfig(), fallback);
    save({ maxConcurrent: 6 });
    assert.equal(loadConfig().maxConcurrent, 6);
    for (const invalid of ["{broken", "[]", '{"piBetterHarness":[]}', '{"piBetterHarness":{"subagents":null}}']) {
        writeFileSync(path, invalid);
        assert.deepEqual(loadConfig(), fallback);
        save({ maxConcurrent: 1 });
        assert.equal(loadConfig().maxConcurrent, 1);
    }
    rmSync(path);
    assert.deepEqual(loadConfig(), fallback);
});

test("explicit test overrides remain pinned until cleared and saves preserve sibling settings", (t) => {
    const { path, save } = fixture(t);
    save({ maxConcurrent: 6, defaultModel: "local/test", healthQuietMs: 123 });
    setConfigForTests({ maxConcurrent: 9 });
    save({ maxConcurrent: 1, defaultModel: "local/test", healthQuietMs: 123 });
    assert.deepEqual(loadConfig(), { maxConcurrent: 9 });
    setConfigForTests(undefined);
    assert.equal(loadConfig().maxConcurrent, 1);
    writeDelegationMode("manual");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
        theme: "light", piBetterHarness: { subagents: { maxConcurrent: 1, defaultModel: "local/test", healthQuietMs: 123, delegationMode: "manual" }, goal: { enabled: true } },
    });
    save({ maxConcurrent: 2 });
    assert.equal(loadConfig().maxConcurrent, 2);
});

test("migration and later global edits are visible without manually clearing the cache", (t) => {
    const root = mkdtempSync(join(tmpdir(), "saved-config-migration-live-"));
    const original = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    setConfigPathForTests(undefined);
    t.after(() => {
        setConfigPathForTests(undefined);
        if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = original;
        rmSync(root, { recursive: true, force: true });
    });
    mkdirSync(join(root, "extensions"));
    const baseline = loadConfig().maxConcurrent;
    assert.equal(baseline, 6);
    writeFileSync(join(root, "extensions/pi-better-subagents-config.json"), '{"maxConcurrent":6,"defaultTools":"read"}');
    assert.equal(loadConfig().maxConcurrent, 6);
    const path = join(root, "settings.json");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).piBetterHarness.subagents.maxConcurrent, 6);
    writeFileSync(path, '{"piBetterHarness":{"subagents":{"maxConcurrent":1}}}');
    assert.equal(loadConfig().maxConcurrent, 1);
});
