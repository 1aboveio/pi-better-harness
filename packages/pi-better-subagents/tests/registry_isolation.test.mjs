/**
 * The test suite never reads or writes the machine's real subagent registry
 * (#324). `tests/isolate-registry.mjs` is loaded by every `node --test` script in
 * package.json; if it is dropped, these assertions fail instead of the suite
 * silently scanning the developer's live registry again.
 *
 * // @covers subagent.list
 * // @level unit
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { baseDir, writeMeta } from "../registry.ts";
import { subagentListTool } from "../tools.ts";

const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"));

test("the registry base directory is private to this test process", () => {
    const machineTmp = process.env.PI_SUBAGENTS_TEST_MACHINE_TMPDIR;
    const isolated = process.env.PI_SUBAGENTS_TEST_ISOLATED_TMPDIR;
    assert.ok(machineTmp && isolated, "tests/isolate-registry.mjs must be preloaded");
    assert.equal(realpathSync(tmpdir()), isolated);
    assert.equal(baseDir(), join(isolated, "pi-better-subagents"));
    assert.notEqual(baseDir(), join(machineTmp, "pi-better-subagents"), "must not be the machine registry");
    const rel = relative(machineTmp, isolated);
    assert.ok(rel && !rel.startsWith("..") && rel.startsWith("pi-subagents-test-"), rel);
});

test("subagent_list sees only runs this process created", async () => {
    assert.equal(existsSync(join(baseDir(), "runs")), false, "a fresh test process starts with an empty registry");
    const T = { Object: (v) => v, String: (v) => v, Number: (v) => v, Boolean: (v) => v, Array: (v) => v, Optional: (v) => v };
    const list = subagentListTool(T);
    writeMeta({
        id: "sa_isolation_probe", name: "isolation-probe", status: "done", pid: process.pid, spawnPid: process.pid,
        cwd: process.cwd(), promptPreview: "probe", startedAt: Date.now(), finishedAt: Date.now(), exitCode: 0,
        logPath: join(baseDir(), "runs", "sa_isolation_probe", "log.jsonl"),
    });
    const text = (await list.execute("tc", {})).content.map((c) => c.text ?? "").join("\n");
    const ids = [...text.matchAll(/\bsa_[A-Za-z0-9_-]+/g)].map((m) => m[0]);
    assert.deepEqual([...new Set(ids)], ["sa_isolation_probe"], text);
});

test("every node --test script in package.json preloads the registry isolation", () => {
    const scripts = Object.entries(packageJson.scripts)
        .filter(([name, cmd]) => /node\b[^&]*--test\b/.test(cmd) && !/sandbox/.test(name));
    assert.ok(scripts.length >= 2, "expected test and test:cross-session");
    for (const [name, cmd] of scripts) {
        assert.match(cmd, /--import \.\/tests\/isolate-registry\.mjs/, name);
    }
});
