// Execute package lane commands at the external process boundary. Confinement
// itself is proven by sandbox_profile and the platform kernel suites.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
for (const [lane, required] of [
    ["test:macos-sandbox", ["tests/test_sandbox_applied.sh", "tests/test_sandbox_deny_outside.sh", "tests/test_sandbox_wrapper_argv.sh", "tests/sandbox_profile.test.mjs"]],
    ["test:linux-sandbox", ["tests/linux_bubblewrap.integration.mjs"]],
]) {
    it(`${lane} executes its kernel checks and propagates their failures`, () => {
        const root = mkdtempSync(join(tmpdir(), "subagents-lane-"));
        const bin = join(root, "bin"), log = join(root, "calls");
        mkdirSync(bin);
        try {
            for (const executable of ["node", "bash"]) {
                const path = join(bin, executable);
                writeFileSync(path, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$LANE_LOG"\ncase "$*" in *"$LANE_FAIL"*) exit 17;; esac\n');
                chmodSync(path, 0o755);
            }
            for (const failure of ["no-check-fails", ...required]) {
                writeFileSync(log, "");
                const result = spawnSync("/bin/sh", ["-c", scripts[lane]], {
                    encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LANE_LOG: log, LANE_FAIL: failure },
                });
                assert.equal(result.status, failure === "no-check-fails" ? 0 : 17, result.stderr);
                const calls = readFileSync(log, "utf8").trim().split("\n");
                if (failure === "no-check-fails") {
                    for (const file of required) assert.ok(calls.some((call) => call.split(" ").includes(file)), `missing execution of ${file}`);
                } else {
                    assert.ok(calls.at(-1).split(" ").includes(failure), "lane must stop at the failing check");
                }
            }
        } finally { rmSync(root, { recursive: true, force: true }); }
    });
}
