import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { prepareOwnedRuntime, removeOwnedFixture, stopOwnedRuntime } from "./test-support/remove-owned-fixture.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const piCli = process.env.PI_SUBAGENTS_SETTINGS_CLI ?? join(root, "node_modules/.bin/pi");

test("subagent settings edit mode, timing, and cap, validate, save, reset, survive reload, and open Agents in the real TUI", { skip: !hasTmux }, async () => {
    // The runtime socket under this root must fit Darwin's Unix socket path limit.
    const fixture = mkdtempSync(join(tmpdir(), "pi-sa-ui-"));
    const agentDir = join(fixture, "agent");
    let runtimeOwner;
    const config = join(fixture, "settings.json");
    const wrapper = join(fixture, "settings-extension.ts");
    writeFileSync(config, JSON.stringify({ piBetterHarness: { subagents: { delegationMode: "adaptive", maxConcurrent: 4, defaultTools: "read" } } }));
    writeFileSync(wrapper, `import extension from ${JSON.stringify(join(root, "packages/pi-better-subagents/index.ts"))};
import { setConfigPathForTests } from ${JSON.stringify(join(root, "packages/pi-better-subagents/config.ts"))};
export default function (pi) { setConfigPathForTests(${JSON.stringify(config)}); extension(pi); }
`);
    const args = ["-L", `pi-subagent-settings-${process.pid}`];
    const q = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
    const command = `cd ${q(fixture)} && exec env PI_CODING_AGENT_DIR=${q(join(fixture, "agent"))} PI_OFFLINE=1 OPENAI_API_KEY=placeholder ${q(piCli)} -e ${q(wrapper)} --no-skills --no-context-files --approve --model openai/gpt-4o-mini`;
    const tmux = (...more) => execFileSync("tmux", [...args, ...more], { encoding: "utf8" });
    const key = (value) => tmux("send-keys", "-t", "settings", value);
    const literal = (value) => tmux("send-keys", "-t", "settings", "-l", "--", value);
    const wait = (pattern) => {
        const deadline = Date.now() + 10_000;
        let screen = "";
        while (Date.now() < deadline) {
            screen = tmux("capture-pane", "-t", "settings", "-p");
            if (pattern.test(screen)) return screen;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
        }
        assert.fail(`Missing ${pattern}:\n${screen}`);
    };
    const select = label => {
        // Up clamps to the first setting, including when the menu has just reopened.
        tmux("send-keys", "-t", "settings", "-N", "10", "Up");
        wait(/^> Delegation mode/m);
        for (let step = 0; step < 10; step++) {
            const active = wait(/^> /m).split("\n").find(line => line.startsWith("> "));
            if (active.trimEnd() === "> " + label || active.startsWith("> " + label + " ")) return;
            key("Down");
            wait(new RegExp("^> (?!" + active.trimEnd().slice(2).split(/\s{2,}/)[0] + ")", "m"));
        }
        assert.fail(`Could not select ${label}`);
    };
    try {
        runtimeOwner = await prepareOwnedRuntime(agentDir);
        tmux("new-session", "-d", "-s", "settings", "-x", "100", "-y", "30", command);
        wait(/settings-extension\.ts/);
        literal("/subagents settings"); wait(/\/subagents settings/); key("Tab"); key("Enter");
        wait(/Subagent settings/);
        wait(/Tool-wait alert\s+5 min/);
        wait(/No-progress alert\s+10 min/);
        const selected = tmux("capture-pane", "-t", "settings", "-e", "-p").split("\n")
            .find((line) => line.replace(/\x1b\[[0-9;]*m/g, "").startsWith("> Delegation mode"));
        assert.ok(selected, "selected row is visible");
        assert.match(selected, /\x1b\[(?:\d+;)*7(?:;\d+)*m/, "session cell has inverse styling");
        key("Enter"); wait(/Delegation mode\s+coordinator/);
        key("Down"); key("Enter");
        key("C-u"); literal("0"); key("Enter");
        wait(/positive whole number/);
        key("C-u"); literal("7"); key("Enter");
        wait(/Concurrent subagents\s+7/);
        select("Tool-wait alert"); key("Enter"); key("C-u"); literal("6.5"); key("Enter");
        wait(/Tool-wait alert\s+6\.5 min/);
        wait(/No-progress alert\s+10 min/);
        select("No-progress alert"); key("Enter"); key("C-u"); literal("12.5"); key("Enter");
        wait(/No-progress alert\s+12\.5 min/);
        wait(/Tool-wait alert\s+6\.5 min/);
        select("Run timeout"); key("Space");
        wait(/Run timeout\s+24 hours/);
        key("Enter"); key("C-u"); literal("90"); key("Enter");
        wait(/Run timeout\s+90 min/);
        assert.deepEqual(JSON.parse(readFileSync(config, "utf8")).piBetterHarness.subagents, {
            delegationMode: "adaptive", maxConcurrent: 4, defaultTools: "read",
        }, "editing session mode, cap, and timing must not save defaults");
        select("Git workspace"); wait(/> Git workspace\s+Clone/); key("Space");
        wait(/Git workspace\s+Worktree/);
        key("C-s"); wait(/Subagent defaults saved/);
        const saved = JSON.parse(readFileSync(config, "utf8")).piBetterHarness.subagents;
        assert.equal(saved.delegationMode, "coordinator");
        assert.equal(saved.maxConcurrent, 7);
        assert.equal(saved.toolWaitMinutes, 6.5);
        assert.equal(saved.stuckMinutes, 12.5);
        assert.equal(saved.maxMinutes, 90);
        assert.equal(saved.defaultTools, "read");
        assert.equal(saved.gitWorkspace, "worktree");
        select("Concurrent subagents");
        key("Enter"); key("C-u"); literal("2"); key("Enter");
        wait(/Concurrent subagents\s+2/);
        select("Git workspace"); key("Space"); wait(/Git workspace\s+Clone/);
        select("Reset to defaults"); wait(/> Reset to defaults/); key("Enter");
        wait(/Git workspace\s+Worktree/);
        wait(/Concurrent subagents\s+7/);
        wait(/Tool-wait alert\s+6\.5 min/);
        wait(/No-progress alert\s+12\.5 min/);
        wait(/Run timeout\s+90 min/);
        select("Run timeout"); key("Enter"); key("C-u"); literal("no limit"); key("Enter");
        wait(/Run timeout\s+24 hours/);
        select("Concurrent subagents"); key("Enter"); key("C-u"); literal("6"); key("Enter");
        wait(/Concurrent subagents\s+6/);
        key("Escape"); wait(/^(?![\s\S]*Subagent settings)/);
        literal("/reload"); key("Enter"); wait(/Reloaded/);
        literal("/subagents"); key("Enter");
        wait(/Delegation mode\s+coordinator/);
        wait(/Concurrent subagents\s+6/);
        wait(/Tool-wait alert\s+6\.5 min/);
        wait(/No-progress alert\s+12\.5 min/);
        wait(/Run timeout\s+24 hours/);
        assert.equal(JSON.parse(readFileSync(config, "utf8")).piBetterHarness.subagents.maxConcurrent, 7, "an unsaved cap survives reload without changing defaults");
        tmux("resize-window", "-t", "settings", "-x", "40", "-y", "24");
        wait(/Concurrent subagents\s+6/);
        wait(/Tool-wait alert\s+6\.5 min/);
        wait(/No-progress alert\s+12\.5 min/);
        wait(/Run timeout\s+24 hours/);
        select("Agents"); key("Enter");
        const catalog = wait(/Agents\s+.*definitions/);
        assert.doesNotMatch(catalog, /Subagent settings/, "the settings pane closes before opening Agents");
        key("Escape");
        wait(/^(?![\s\S]*Agents\s+.*definitions)/);
    } finally {
        spawnSync("tmux", [...args, "kill-server"], { stdio: "ignore" });
        await stopOwnedRuntime(join(agentDir, "server"), runtimeOwner);
        removeOwnedFixture(fixture);
    }
});
