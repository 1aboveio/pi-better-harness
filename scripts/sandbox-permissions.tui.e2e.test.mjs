import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

test("sandbox permission table edits both profiles and saves inactive values in the real TUI", { skip: !hasTmux }, () => {
    const fixture = mkdtempSync(join(tmpdir(), "pi-permission-tui-"));
    const server = `pi-permission-${process.pid}`;
    const args = ["-L", server];
    const q = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
    const command = `cd ${q(fixture)} && exec env PI_CODING_AGENT_DIR=${q(join(fixture, "agent"))} PI_OFFLINE=1 OPENAI_API_KEY=placeholder ${q(join(root, "node_modules/.bin/pi"))} -e ${q(join(root, "packages/pi-better-sandbox/index.ts"))} --no-skills --no-context-files --approve --model openai/gpt-4o-mini`;
    const tmux = (...more) => execFileSync("tmux", [...args, ...more], { encoding: "utf8" });
    const screen = () => tmux("capture-pane", "-t", "permissions", "-p");
    const key = (value) => tmux("send-keys", "-t", "permissions", value);
    const literal = (value) => tmux("send-keys", "-t", "permissions", "-l", value);
    const wait = (pattern) => {
        const deadline = Date.now() + 10_000;
        let text = "";
        while (Date.now() < deadline) {
            text = screen();
            if (pattern.test(text)) return text;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
        }
        assert.fail(`Missing ${pattern}:\n${text}`);
    };
    try {
        tmux("new-session", "-d", "-s", "permissions", "-x", "100", "-y", "36", command);
        wait(/sandbox/);
        literal("/sandbox"); key("Enter");
        let text = wait(/Sandbox permissions\s+Main\s+Subagents/);
        assert.match(text, /Sandbox\s+Off\s+On/);
        assert.match(text, /Project files\s+-\s+Read \/ write/);
        key("Space"); wait(/Sandbox\s+On\s+On/);
        key("Down"); key("Space"); wait(/Project files\s+Off\s+Read \/ write/);
        key("Up"); key("Space"); wait(/Project files\s+-\s+Read \/ write/);
        key("Down"); key("Space"); // Inactive cell must not change the retained Off.
        key("Up"); key("Space"); wait(/Project files\s+Off\s+Read \/ write/);
        key("Space"); wait(/Sandbox\s+Off\s+On/);
        key("Right"); key("Down"); key("Down"); key("Space");
        wait(/Outside project\s+-\s+Read \/ write/);
        for (let i = 0; i < 4; i++) key("Down");
        key("Enter"); wait(/Defaults saved/);
        const saved = JSON.parse(readFileSync(join(fixture, "agent/extensions/pi-better-sandbox-permissions.json"), "utf8"));
        assert.equal(saved.permissions.main.enabled, false);
        assert.equal(saved.permissions.main.projectFiles, "off");
        assert.equal(saved.permissions.subagents.outsideProject, "read-write");
        key("Escape");
        wait(/^(?![\s\S]*Save as defaults)/);
        literal("/reload"); key("Enter"); wait(/Reloaded/);
        literal("/sandbox"); key("Enter");
        wait(/Outside project\s+-\s+Read \/ write/);
        key("Space"); wait(/Project files\s+Off\s+Read \/ write/);
    } finally {
        spawnSync("tmux", [...args, "kill-server"], { stdio: "ignore" });
        rmSync(fixture, { recursive: true, force: true });
    }
});
