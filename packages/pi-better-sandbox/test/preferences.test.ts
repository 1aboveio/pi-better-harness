import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const seams = { agentDir: () => root };

test("no preference file means the foreground sandbox defaults off", () => {
    assert.equal(readSandboxDefault(seams), "off");
});

test("on and off preferences round-trip through an atomic versioned file", () => {
    const path = writeSandboxDefault("on", seams);
    assert.equal(readSandboxDefault(seams), "on");
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { version: 1, default: "on" });

    writeSandboxDefault("off", seams);
    assert.equal(readSandboxDefault(seams), "off");
});

test("malformed preferences are reported instead of silently enabling confinement", () => {
    const path = sandboxPreferencesPath(seams);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"version":1,"default":"sometimes"}\n');

    assert.throws(() => readSandboxDefault(seams), SandboxPreferenceError);
});