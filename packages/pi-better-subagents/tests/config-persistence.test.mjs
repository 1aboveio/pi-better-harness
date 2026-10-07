import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, loadConfig, setConfigForTests, setConfigPathForTests, writeDelegationMode, writeSubagentSettings } from "../config.ts";

test("the default config location honors the agent directory outside installed packages", () => {
    const original = process.env.PI_CODING_AGENT_DIR;
    try {
        process.env.PI_CODING_AGENT_DIR = join(tmpdir(), "custom-pi-agent");
        assert.equal(configPath(), join(process.env.PI_CODING_AGENT_DIR, "extensions", "pi-better-subagents-config.json"));
    } finally {
        if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = original;
    }
});

test("saved defaults survive package replacement while unsaved shipped defaults can update", () => {
    const root = mkdtempSync(join(tmpdir(), "subagents-upgrade-"));
    const legacy = join(root, "package-config.json");
    const user = join(root, "agent", "extensions", "pi-better-subagents-config.json");
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
        writeFileSync(user, JSON.stringify({ delegationMode: "manual", maxConcurrent: 9, defaultModel: "provider/model" }));
        writeDelegationMode("adaptive");
        setConfigForTests(undefined);
        assert.deepEqual(loadConfig(), { delegationMode: "adaptive", maxConcurrent: 9, defaultTools: "read,bash", defaultModel: "provider/model" });
        assert.deepEqual(JSON.parse(readFileSync(user, "utf8")), { delegationMode: "adaptive", maxConcurrent: 9, defaultModel: "provider/model" });
        writeFileSync(user, "{broken");
        assert.throws(() => writeDelegationMode("manual"), SyntaxError);
        assert.throws(() => writeSubagentSettings({ delegationMode: "manual", maxConcurrent: 3 }), SyntaxError);
        assert.equal(readFileSync(user, "utf8"), "{broken", "failed saves preserve existing user data");
    } finally {
        setConfigPathForTests(undefined);
        rmSync(root, { recursive: true, force: true });
    }
});