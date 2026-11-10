import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, loadConfig, setConfigForTests, setConfigPathForTests, writeDelegationMode, writeSubagentSettings } from "../config.ts";
import { resolveRunTiming } from "../timing.ts";

test("the default config location honors the agent directory outside installed packages", () => {
    const original = process.env.PI_CODING_AGENT_DIR;
    try {
        process.env.PI_CODING_AGENT_DIR = join(tmpdir(), "custom-pi-agent");
        assert.equal(configPath(), join(process.env.PI_CODING_AGENT_DIR, "settings.json"));
    } finally {
        if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = original;
    }
});

test("saved defaults survive package replacement while unsaved shipped defaults can update", () => {
    const root = mkdtempSync(join(tmpdir(), "subagents-upgrade-"));
    const legacy = join(root, "package-config.json");
    const user = join(root, "agent", "settings.json");
    const oldPackage = JSON.stringify({ delegationMode: "manual", maxConcurrent: 2, defaultTools: "read" });
    writeFileSync(legacy, oldPackage);
    setConfigPathForTests(user, legacy);
    try {
        assert.equal(loadConfig().delegationMode, "manual", "legacy package config remains readable");
        writeSubagentSettings({ delegationMode: "coordinator", maxConcurrent: 7 });
        assert.equal(readFileSync(legacy, "utf8"), oldPackage, "saving must not edit installed package files");
        writeFileSync(legacy, JSON.stringify({ delegationMode: "adaptive", maxConcurrent: 4, defaultTools: "read,bash" }));
        setConfigForTests(undefined);
        assert.deepEqual(loadConfig(), { delegationMode: "coordinator", maxConcurrent: 7, defaultTools: "read,bash" });
        writeFileSync(user, JSON.stringify({ theme: "dark", piBetterHarness: { subagents: { delegationMode: "manual", maxConcurrent: 9, defaultModel: "provider/model" } } }));
        writeDelegationMode("adaptive");
        setConfigForTests(undefined);
        assert.deepEqual(loadConfig(), { delegationMode: "adaptive", maxConcurrent: 9, defaultTools: "read,bash", defaultModel: "provider/model" });
        assert.deepEqual(JSON.parse(readFileSync(user, "utf8")), { theme: "dark", piBetterHarness: { subagents: { delegationMode: "adaptive", maxConcurrent: 9, defaultModel: "provider/model" } } });
        writeFileSync(user, "{broken");
        assert.throws(() => writeDelegationMode("manual"), SyntaxError);
        assert.throws(() => writeSubagentSettings({ delegationMode: "manual", maxConcurrent: 3 }), SyntaxError);
        assert.equal(readFileSync(user, "utf8"), "{broken", "failed saves preserve existing user data");
    } finally {
        setConfigPathForTests(undefined);
        rmSync(root, { recursive: true, force: true });
    }
});

test("legacy user config migrates without replacing Pi settings and stays subordinate to global choices", () => {
    const root = mkdtempSync(join(tmpdir(), "subagents-config-migration-"));
    const original = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    setConfigPathForTests(undefined);
    const legacy = join(root, "extensions", "pi-better-subagents-config.json");
    mkdirSync(join(root, "extensions"));
    writeFileSync(join(root, "settings.json"), '{"theme":"light"}');
    writeFileSync(legacy, '{"delegationMode":"manual","maxConcurrent":8}');
    try {
        assert.equal(loadConfig().maxConcurrent, 8);
        assert.deepEqual(JSON.parse(readFileSync(configPath(), "utf8")), {
            theme: "light", piBetterHarness: { subagents: { delegationMode: "manual", maxConcurrent: 8 } },
        });
        writeSubagentSettings({ delegationMode: "coordinator", maxConcurrent: 6 });
        writeFileSync(legacy, "{broken");
        setConfigForTests(undefined);
        assert.equal(loadConfig().maxConcurrent, 6);
        assert.equal(loadConfig().delegationMode, "coordinator");
    } finally {
        setConfigForTests(undefined);
        if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = original;
        rmSync(root, { recursive: true, force: true });
    }
});

test("tool-wait and no-progress times save, reload, validate, and leave unrelated keys intact", () => {
    const root = mkdtempSync(join(tmpdir(), "subagents-timing-config-"));
    const user = join(root, "settings.json");
    setConfigPathForTests(user);
    try {
        writeSubagentSettings({ delegationMode: "adaptive", maxConcurrent: 4, toolWaitMinutes: 7.5, stuckMinutes: 12 });
        setConfigForTests(undefined);
        const saved = loadConfig();
        assert.equal(saved.toolWaitMinutes, 7.5);
        assert.equal(saved.stuckMinutes, 12);
        const timing = resolveRunTiming({ settings: saved, startedAt: 1_000 });
        assert.equal(timing.toolWaitMs, 7.5 * 60_000, "the tool-wait value is independent");
        assert.equal(timing.stuckMs, 12 * 60_000, "the no-progress value is independent");

        writeSubagentSettings({ delegationMode: "adaptive", maxConcurrent: 4, toolWaitMinutes: 0, stuckMinutes: 0 });
        setConfigForTests(undefined);
        const off = resolveRunTiming({ settings: loadConfig(), startedAt: 0 });
        assert.equal(off.toolWaitMs, undefined, "0 turns tool-wait alerts off");
        assert.equal(off.stuckMs, undefined, "0 turns no-progress alerts off");

        writeDelegationMode("manual");
        setConfigForTests(undefined);
        assert.equal(loadConfig().toolWaitMinutes, 0, "a mode-only save preserves timing values");
        assert.equal(loadConfig().stuckMinutes, 0);

        assert.throws(() => writeSubagentSettings({ delegationMode: "adaptive", maxConcurrent: 4, toolWaitMinutes: -1 }),
            /toolWaitMinutes must be/);
        assert.throws(() => writeSubagentSettings({ delegationMode: "adaptive", maxConcurrent: 4, stuckMinutes: Number.NaN }),
            /stuckMinutes must be/);
        setConfigForTests(undefined);
        assert.equal(loadConfig().toolWaitMinutes, 0, "a rejected save leaves the prior value intact");
        assert.equal(loadConfig().stuckMinutes, 0);
    } finally {
        setConfigPathForTests(undefined);
        rmSync(root, { recursive: true, force: true });
    }
});