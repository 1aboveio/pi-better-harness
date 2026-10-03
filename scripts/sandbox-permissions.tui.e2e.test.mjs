import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

test("sandbox edits restore before Ctrl+S and only Ctrl+S saves defaults in the real TUI", { skip: !hasTmux }, () => {
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
        assert.doesNotMatch(text, /Save as defaults/);
        assert.match(text, /ctrl\+s Save default/);
        assert.match(text, /Sandbox\s+Off\s+On/);
        const focused = tmux("capture-pane", "-t", "permissions", "-e", "-p").split("\n")
            .find((line) => line.replace(/\x1b\[[0-9;]*m/g, "").startsWith("> Sandbox"));
        assert.ok(focused, "selected row is visible in the real terminal");
        assert.match(focused, /\x1b\[[0-9;]*48;[0-9;]*m/, "selected row uses a colored background");
        assert.match(focused, /\x1b\[(?:\d+;)*1(?:;\d+)*m/, "selected row is bold");
        assert.match(focused, /\x1b\[(?:\d+;)*7(?:;\d+)*m/, "active cell has inverse styling");
        assert.match(text, /Project files\s+-\s+Write & delete/);
        key("Space"); wait(/Sandbox\s+On\s+On/);
        key("Down"); key("Space"); wait(/Project files\s+Off\s+Write & delete/);
        key("Up"); key("Space"); wait(/Project files\s+-\s+Write & delete/);
        key("Down"); key("Space"); // Inactive cell must not change the retained Off.
        key("Up"); key("Space"); wait(/Project files\s+Off\s+Write & delete/);
        key("Space"); wait(/Sandbox\s+Off\s+On/);
        key("Right"); key("Down"); key("Down");
        // Subagents default to Outside project = Write; its hint names the trade-off.
        wait(/Outside project\s+-\s+Write\s/);
        wait(/rename-based saves fail outside the project/);
        key("Space");
        wait(/Outside project\s+-\s+Write & delete/);
        // The guarded adapter stays a direct row; trusted tools start folded by package.
        wait(/Subagents · Tools[\s\S]*\[x\] apply_patch\s+harness adapter[\s\S]*Trusted \(runs outside the file rules\)[\s\S]*\[x\].*@juicesharp\/rpiv-web-tools\s+2\/2/);
        const defaultsPath = join(fixture, "agent/extensions/pi-better-sandbox-permissions.json");
        assert.equal(existsSync(defaultsPath), false, "editing must not write global defaults");
        key("Enter"); // Not a save command.
        key("Escape"); wait(/^(?![\s\S]*Sandbox permissions\s+Main)/);
        literal("/reload"); key("Enter"); wait(/Reloaded/);
        literal("/sandbox"); key("Enter");
        wait(/Outside project\s+-\s+Write & delete/);
        assert.equal(existsSync(defaultsPath), false, "reload restores the session without writing defaults");
        key("Space"); wait(/Project files\s+Off\s+Write & delete/);
        key("Space"); wait(/Sandbox\s+Off\s+On/);
        key("C-s"); wait(/Defaults saved\. Looser: Subagents: outsideProject write → read-write/);
        wait(/Defaults saved/);
        const saved = JSON.parse(readFileSync(defaultsPath, "utf8"));
        assert.equal(saved.permissions.main.enabled, false);
        assert.equal(saved.permissions.main.projectFiles, "off");
        assert.equal(saved.permissions.subagents.outsideProject, "read-write");
        assert.equal(saved.permissions.subagentTools.applyPatch, true);
        key("Space"); wait(/Project files\s+Off\s+Write & delete/); // Session-only Main on.
        key("Escape");
        wait(/^(?![\s\S]*Sandbox permissions\s+Main)/);
        literal("/new"); key("Enter"); wait(/New session/);
        literal("/sandbox"); key("Enter");
        wait(/Sandbox\s+Off\s+On/);
        wait(/Outside project\s+-\s+Write & delete/);
    } finally {
        spawnSync("tmux", [...args, "kill-server"], { stdio: "ignore" });
        rmSync(fixture, { recursive: true, force: true });
    }
});

test("trusted groups fold, bulk select and persist individual tools in the real TUI", { skip: !hasTmux }, () => {
    const fixture = mkdtempSync(join("/tmp", "pi-groups-"));
    const agent = join(fixture, "agent");
    const server = `pi-trusted-groups-${process.pid}`;
    const args = ["-L", server];
    const q = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
    const packageRoot = (name, tools) => {
        const dir = join(fixture, name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", pi: { extensions: ["./index.js"] } }));
        writeFileSync(join(dir, "index.js"), `export default function (pi) {
            for (const name of ${JSON.stringify(tools)}) pi.registerTool({
                name, label: name, description: name, parameters: { type: "object", properties: {} },
                async execute() { return { content: [{ type: "text", text: "fixture" }] }; },
            });
        }`);
        return dir;
    };
    const alpha = packageRoot("fixture-alpha", ["alpha_helper", "mcp__atlas__read", "mcp__atlas__write", "mcp__beacon__read"]);
    const beta = packageRoot("fixture-beta", ["beta_helper", "mcp__atlas__other"]);
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [alpha, beta] }));
    const command = `cd ${q(fixture)} && exec env PI_CODING_AGENT_DIR=${q(agent)} PI_OFFLINE=1 OPENAI_API_KEY=placeholder ${q(join(root, "node_modules/.bin/pi"))} -e ${q(join(root, "packages/pi-better-sandbox/index.ts"))} --no-skills --no-context-files --approve --model openai/gpt-4o-mini`;
    const tmux = (...more) => execFileSync("tmux", [...args, ...more], { encoding: "utf8" });
    const screen = () => tmux("capture-pane", "-t", "permissions", "-p");
    const key = (value) => tmux("send-keys", "-t", "permissions", value);
    const literal = (value) => tmux("send-keys", "-t", "permissions", "-l", value);
    const wait = (pattern) => {
        const deadline = Date.now() + 10_000;
        let text = "";
        while (Date.now() < deadline) {
            text = screen();
            if (typeof pattern === "function" ? pattern(text) : pattern.test(text)) return text;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
        }
        assert.fail(`Missing ${pattern}:\n${text}`);
    };
    const selected = () => screen().match(/^> (.*)$/m)?.[1] ?? "";
    const moveTo = (pattern, direction = "Down") => {
        for (let i = 0; i < 60; i++) {
            if (pattern.test(selected())) return;
            const before = selected();
            key(direction);
            wait((text) => (text.match(/^> (.*)$/m)?.[1] ?? "") !== before);
        }
        assert.fail(`Could not select ${pattern}:\n${screen()}`);
    };
    try {
        tmux("new-session", "-d", "-s", "permissions", "-x", "130", "-y", "50", command);
        wait(/sandbox/);
        literal("/sandbox"); key("Enter");
        wait(/Subagents · Tools/);
        assert.match(screen(), /\[ \].*fixture-alpha.*0\/1/);
        assert.match(screen(), /\[ \].*fixture-beta.*0\/1/);
        assert.match(screen(), /> \[ \] atlas \([^\n]*fixture-alpha\) 0\/2/);
        assert.match(screen(), /atlas \([^\n]*fixture-beta\).*0\/1/);
        assert.doesNotMatch(screen(), /mcp__atlas__read/, "groups start collapsed");
        moveTo(/atlas \([^\n]*fixture-alpha\).*0\/2/);
        key("Right"); wait(/v \[ \] atlas \([^\n]*fixture-alpha\) 0\/2/);
        moveTo(/mcp__atlas__read/);
        key("Space");
        wait(/v \[-\] atlas \([^\n]*fixture-alpha\) 1\/2/);
        key("Left"); wait(/^(?![\s\S]*mcp__atlas__read)/);
        assert.match(selected(), /> \[-\] atlas \([^\n]*fixture-alpha\) 1\/2/);
        key("Space"); wait(/> \[x\] atlas \([^\n]*fixture-alpha\) 2\/2/);
        assert.match(screen(), /atlas \([^\n]*fixture-beta\).*0\/1/, "same provider in another package is untouched");
        moveTo(/fixture-alpha.*0\/1/, "Up");
        key("Space"); wait(/fixture-alpha.*1\/1/);
        key("Space"); wait(/fixture-alpha.*0\/1/);
        moveTo(/atlas \([^\n]*fixture-alpha\).*2\/2/);
        key("Space"); wait(/atlas \([^\n]*fixture-alpha\).*0\/2/);
        key("Space"); wait(/atlas \([^\n]*fixture-alpha\).*2\/2/);
        key("Right"); wait(/mcp__atlas__read/);
        key("Left"); wait(/^(?![\s\S]*mcp__atlas__read)/);
        key("Enter"); wait(/mcp__atlas__read/);
        key("Enter"); wait(/^(?![\s\S]*mcp__atlas__read)/);
        assert.equal(existsSync(join(agent, "extensions/pi-better-sandbox-permissions.json")), false);
        assert.doesNotMatch(screen(), /Save as defaults/);
        key("C-s"); wait(/Defaults saved/);
        wait(/Looser:/);
        const saved = JSON.parse(readFileSync(join(agent, "extensions/pi-better-sandbox-permissions.json"), "utf8"));
        assert.equal(saved.permissions.subagentTools.applyPatch, true);
        assert.deepEqual(Object.keys(saved.permissions.subagentTools).sort(), ["applyPatch", "trusted"]);
        assert.deepEqual(saved.permissions.subagentTools.trusted.map((tool) => [tool.name, tool.package]).sort((a, b) => a[0].localeCompare(b[0])), [
            ["mcp__atlas__read", alpha], ["mcp__atlas__write", alpha],
            ["web_fetch", "npm:@juicesharp/rpiv-web-tools"], ["web_search", "npm:@juicesharp/rpiv-web-tools"],
        ]);
        key("Escape"); wait(/^(?![\s\S]*Sandbox permissions\s+Main)/);
        literal("/reload"); key("Enter"); wait(/Reloaded/);
        literal("/sandbox"); key("Enter"); wait(/Subagents · Tools/);
        assert.match(screen(), /atlas \([^\n]*fixture-alpha\).*2\/2/);
        assert.match(screen(), /atlas \([^\n]*fixture-beta\).*0\/1/);
        assert.doesNotMatch(screen(), /mcp__atlas__read/, "fold state is not persisted");
        moveTo(/atlas \([^\n]*fixture-alpha\).*2\/2/); key("Right"); wait(/\[x\] mcp__atlas__read/);
        assert.match(screen(), /\[x\] mcp__atlas__write/);
        moveTo(/beacon \([^\n]*fixture-alpha\).*0\/1/); key("Right"); wait(/\[ \] mcp__beacon__read/);
    } finally {
        spawnSync("tmux", [...args, "kill-server"], { stdio: "ignore" });
        rmSync(fixture, { recursive: true, force: true });
    }
});
