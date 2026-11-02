/**
 * Extension-level proof for launch debris (#623).
 *
 * The unit suite (launch_debris.test.mjs) covers the classification, the sweep,
 * and the operator purge against a seeded registry. This file drives the REAL
 * extension and the real launch path: a launch that fails while preparing the
 * child — after the run directory and `prompt.md` exist — must leave nothing
 * behind. Before this fix that window left a directory with only `prompt.md`
 * (or `prompt.md` plus the sandbox `control/` dir), which every `subagent_list`
 * reported as "missing or unreadable metadata (ownership unknown)" until the
 * seven-day age sweep.
 *
 * The failure is deterministic and first-party: the configured
 * `web_search` -> `npm:@juicesharp/rpiv-web-tools` mapping cannot resolve in
 * this workspace, so the launch throws "Subagent needs extension(s) that are
 * not installed". Only the host packages are stubbed (external boundary); the
 * extension, registry, launch preparation, and cleanup are real.
 *
 * // @covers subagent.launch-debris
 * // @level integration
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

register(new URL("./pi_host_stub_hooks.mjs", import.meta.url));

const RUNTIME = mkdtempSync(join(tmpdir(), "subagent-launch-debris-ext-"));
process.env.TMPDIR = RUNTIME;
process.env.PI_CODING_AGENT_DIR = join(RUNTIME, "agent");
process.env.PI_SUBAGENT_DURABLE_DIR = join(RUNTIME, "durable-subagents");

const { default: betterSubagents } = await import("../index.ts");
const { baseDir, listRunRecords } = await import("../registry.ts");

function makeHarness() {
    const tools = new Map();
    const pi = { registerTool: (def) => tools.set(def.name, def), on: () => {} };
    const ctx = {
        cwd: RUNTIME,
        isIdle: () => true,
        hasUI: false,
        ui: { notify: () => {}, setWidget: () => {} },
        model: undefined,
        sessionManager: { getSessionId: () => "debris-session" },
    };
    betterSubagents(pi);
    return { tools, ctx };
}

/** Run directories present after `fn`, or [] when the runs root does not exist. */
function runDirs() {
    try {
        return readdirSync(join(baseDir(), "runs"));
    } catch {
        return [];
    }
}

describe("launch debris end to end (#623)", () => {
    it("a launch that fails after the prompt was written leaves no unreadable record", async () => {
        const { tools, ctx } = makeHarness();
        await assert.rejects(
            () => tools.get("subagent_spawn").execute(
                "debris-probe",
                { prompt: "review the diff", tools: "web_search", sandbox: false, cwd: RUNTIME },
                undefined, undefined, ctx,
            ),
            /Subagent needs extension\(s\) that are not installed/,
        );
        assert.deepEqual(runDirs(), [], "the failed attempt's run directory is gone");
        const records = listRunRecords();
        assert.deepEqual(records.metas, []);
        assert.deepEqual(records.unreadable, [], "no unreadable record is left for subagent_list to report");
        assert.deepEqual(records.abandoned, [], "and nothing is left for the debris sweep either");
    });
});

after(() => {
    rmSync(RUNTIME, { recursive: true, force: true });
});
