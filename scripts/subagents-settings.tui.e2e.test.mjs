import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

test("subagent settings edit mode and cap, validate, save, reset, and survive reload in the real TUI", { skip: !hasTmux }, () => {
    const fixture = mkdtempSync(join(tmpdir(), "pi-subagent-settings-"));
    const config = join(fixture, "config.json");
    const wrapper = join(fixture, "settings-extension.ts");
    writeFileSync(config, JSON.stringify({ delegationMode: "adaptive", maxConcurrent: 4, defaultTools: "read" }));
    writeFileSync(wrapper, `import extension from ${JSON.stringify(join(root, "packages/pi-better-subagents/index.ts"))};
import { setConfigPathForTests } from ${JSON.stringify(join(root, "packages/pi-better-subagents/config.ts"))};
export default function (pi) { setConfigPathForTests(${JSON.stringify(config)}); extension(pi); }
`);
    const args = ["-L", `pi-subagent-settings-${process.pid}`];
    const q = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
    const command = `cd ${q(fixture)} && exec env PI_CODING_AGENT_DIR=${q(join(fixture, "agent"))} PI_OFFLINE=1 OPENAI_API_KEY=placeholder ${q(join(root, "node_modules/.bin/pi"))} -e ${q(wrapper)} --no-skills --no-context-files --approve --model openai/gpt-4o-mini`;
    const tmux = (...more) => execFileSync("tmux", [...args, ...more], { encoding: "utf8" });
    const key = (value) => tmux("send-keys", "-t", "settings", value);
    const literal = (value) => tmux("send-keys", "-t", "settings", "-l", value);
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
    try {
        tmux("new-session", "-d", "-s", "settings", "-x", "100", "-y", "30", command);
        wait(/settings-extension\.ts/);
        literal("/subagents settings"); wait(/\/subagents settings/); key("Tab"); key("Enter");
        wait(/Subagent settings/);
        key("Enter"); wait(/Delegation mode: coordinator/);
        key("Down"); key("Enter");
        key("C-u"); literal("0"); key("Enter");
        wait(/positive whole number/);
        key("C-u"); literal("7"); key("Enter");
        wait(/Concurrent subagents: 7 \(session\)/);
        key("C-s"); wait(/Subagent defaults saved/);
        const saved = JSON.parse(readFileSync(config, "utf8"));
        assert.equal(saved.delegationMode, "coordinator");
        assert.equal(saved.maxConcurrent, 7);
        assert.equal(saved.defaultTools, "read");
        key("Enter"); key("C-u"); literal("2"); key("Enter");
        wait(/Concurrent subagents: 2 \(session\)/);
        key("Down"); key("Down"); key("Enter");
        wait(/Concurrent subagents: 7 \(config\)/);
        key("Up"); key("Up"); key("Enter"); key("C-u"); literal("6"); key("Enter");
        wait(/Concurrent subagents: 6 \(session\)/);
        key("Escape"); wait(/^(?![\s\S]*Subagent settings)/);
        literal("/reload"); key("Enter"); wait(/Reloaded/);
        literal("/subagents"); key("Enter");
        wait(/Delegation mode: coordinator \(config\)/);
        wait(/Concurrent subagents: 6 \(session\)/);
        assert.equal(JSON.parse(readFileSync(config, "utf8")).maxConcurrent, 7, "an unsaved cap survives reload without changing defaults");
        tmux("resize-window", "-t", "settings", "-x", "40", "-y", "24");
        wait(/Subagent settings/);
        key("Escape");
    } finally {
        spawnSync("tmux", [...args, "kill-server"], { stdio: "ignore" });
        rmSync(fixture, { recursive: true, force: true });
    }
});
