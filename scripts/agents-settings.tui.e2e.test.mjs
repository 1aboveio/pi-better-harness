import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

test("agents model and effort edits persist for the session and only Ctrl+S saves catalog defaults in the real TUI", { skip: !hasTmux }, () => {
    const fixture = mkdtempSync(join(tmpdir(), "pi-agents-settings-"));
    const agent = join(fixture, "agent");
    const rolePath = join(agent, "agents/roles/role.fixture.md");
    mkdirSync(dirname(rolePath), { recursive: true });
    const original = "---\nschema: pi-agent/v1\nkind: role\nid: role.fixture\nname: Fixture\ndefaults:\n  model: openai/gpt-4o-mini\n  effort: medium\n---\nInspect the fixture.\n";
    writeFileSync(rolePath, original);
    const args = ["-L", `pi-agents-settings-${process.pid}`];
    const q = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
    const command = `cd ${q(fixture)} && exec env PI_CODING_AGENT_DIR=${q(agent)} PI_OFFLINE=1 OPENAI_API_KEY=placeholder ${q(join(root, "node_modules/.bin/pi"))} -e ${q(join(root, "packages/pi-better-subagents/index.ts"))} --no-skills --no-context-files --approve --model openai/gpt-4o-mini`;
    const tmux = (...more) => execFileSync("tmux", [...args, ...more], { encoding: "utf8" });
    const key = (value) => tmux("send-keys", "-t", "agents", value);
    const literal = (value) => tmux("send-keys", "-t", "agents", "-l", value);
    const wait = (pattern) => {
        const deadline = Date.now() + 10_000;
        let screen = "";
        while (Date.now() < deadline) {
            screen = tmux("capture-pane", "-t", "agents", "-p");
            if (pattern.test(screen)) return screen;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
        }
        assert.fail(`Missing ${pattern}:\n${screen}`);
    };
    const open = () => {
        literal("/agents inspect role.fixture"); wait(/\/agents inspect role.fixture/); key("Tab"); key("Enter");
        wait(/Agents \/ inspect/); literal("e"); wait(/Agents \/ Fixture/);
    };
    const close = () => {
        key("Escape"); wait(/Agents \/ inspect/); wait(/Actual\s+openai\/gpt-4o\s/);
        key("Escape"); wait(/Search/);
        key("Escape"); wait(/^(?![\s\S]*Agents \/ inspect)(?![\s\S]*Search)/);
    };
    try {
        tmux("new-session", "-d", "-s", "agents", "-x", "100", "-y", "40", command);
        wait(/pi-better-subagents/);
        open();
        key("Enter"); wait(/Agents \/ model/);
        literal("openai/gpt-4o"); wait(/openai\/gpt-4o/); key("Enter");
        wait(/Model\s+openai\/gpt-4o\s+session/);
        key("Down"); key("Enter"); wait(/Agents \/ effort/);
        key("Up"); key("Enter"); wait(/Effort\s+low\s+session/);
        assert.equal(readFileSync(rolePath, "utf8"), original, "session editing must not write catalog defaults");
        close(); literal("/reload"); key("Enter"); wait(/Reloaded/);
        open(); wait(/Effort\s+low\s+session/); wait(/Model\s+openai\/gpt-4o\s+session/);
        assert.equal(readFileSync(rolePath, "utf8"), original);
        key("C-s"); wait(/saved/i);
        const frontmatter = readFileSync(rolePath, "utf8").split("---")[1];
        assert.equal(parse(frontmatter).defaults.effort, "low");
        assert.equal(parse(frontmatter).defaults.model, "openai/gpt-4o");
        tmux("resize-window", "-t", "agents", "-x", "40", "-y", "24");
        wait(/Agents \/ Fixture/);
    } finally {
        spawnSync("tmux", [...args, "kill-server"], { stdio: "ignore" });
        rmSync(fixture, { recursive: true, force: true });
    }
});
