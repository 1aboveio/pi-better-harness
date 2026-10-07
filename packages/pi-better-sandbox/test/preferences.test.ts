import assert from "node:assert/strict";
import { closeSync, openSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";

import {
    readSandboxDefault,
    SandboxPreferenceError,
    sandboxPreferencesPath,
    writeSandboxDefault,
} from "../preferences.ts";

const root = mkdtempSync(join(tmpdir(), "pi-better-sandbox-preferences-"));
after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
function fixture() {
    const agentDir = join(root, `agent-${++counter}`);
    return { agentDir: () => agentDir };
}

test("no preference file means the foreground sandbox defaults off", () => {
    const seams = fixture();
    assert.equal(readSandboxDefault(seams), "off");
});

test("on and off preferences round-trip through an atomic versioned file", () => {
    const seams = fixture();
    const path = writeSandboxDefault("on", seams);
    assert.equal(path, join(seams.agentDir(), "settings.json"));
    assert.equal(readSandboxDefault(seams), "on");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { piBetterHarness: { sandbox: { version: 1, default: "on" } } });

    const previous = openSync(path, "r");
    try {
        writeSandboxDefault("off", seams);
        assert.equal(readSandboxDefault(seams), "off");
        assert.deepEqual(JSON.parse(readFileSync(previous, "utf8")), { piBetterHarness: { sandbox: { version: 1, default: "on" } } },
            "an existing reader keeps the old complete file after atomic replacement");
    } finally { closeSync(previous); }
});

test("malformed preferences are reported instead of silently enabling confinement", () => {
    const seams = fixture();
    const path = sandboxPreferencesPath(seams);
    mkdirSync(dirname(path), { recursive: true });
    for (const value of [null, { version: 2, default: "on" }, { version: 1, default: "sometimes" }]) {
        writeFileSync(path, JSON.stringify({ piBetterHarness: { sandbox: value } }));
        assert.throws(() => readSandboxDefault(seams), SandboxPreferenceError);
    }
    writeFileSync(path, "{ not json");
    assert.throws(() => readSandboxDefault(seams), SandboxPreferenceError);
});

test("activation migrates validated legacy data once and preserves unrelated settings", () => {
    const seams = fixture();
    const legacyPath = join(seams.agentDir(), "extensions", "pi-better-sandbox-preferences.json");
    mkdirSync(dirname(legacyPath), { recursive: true });
    const legacy = JSON.stringify({ version: 1, default: "on" });
    writeFileSync(legacyPath, legacy);
    const path = sandboxPreferencesPath(seams);
    const other = { model: "test-model", piBetterHarness: { goal: { enabled: true } } };
    writeFileSync(path, JSON.stringify(other));
    assert.equal(readSandboxDefault(seams), "on");
    assert.equal(readFileSync(legacyPath, "utf8"), legacy);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
        ...other, piBetterHarness: { ...other.piBetterHarness, sandbox: { version: 1, default: "on" } },
    });
    writeSandboxDefault("off", seams);
    writeFileSync(legacyPath, "{ broken legacy");
    assert.equal(readSandboxDefault(seams), "off", "the global value wins even over malformed legacy data");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
        ...other, piBetterHarness: { ...other.piBetterHarness, sandbox: { version: 1, default: "off" } },
    });
});

test("invalid legacy activation is not migrated and a failed write preserves global settings", () => {
    const seams = fixture();
    const legacyPath = join(seams.agentDir(), "extensions", "pi-better-sandbox-preferences.json");
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, '{"version":1,"default":"invalid"}');
    const path = sandboxPreferencesPath(seams);
    const original = '{"model":"keep-me"}';
    writeFileSync(path, original);
    assert.throws(() => readSandboxDefault(seams), SandboxPreferenceError);
    assert.equal(readFileSync(path, "utf8"), original);
    writeFileSync(path, "{ broken global");
    assert.throws(() => writeSandboxDefault("on", seams), SandboxPreferenceError);
    assert.equal(readFileSync(path, "utf8"), "{ broken global");
});