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
    const command = `cd ${q(fixture)} && exec env PI_CODING_AGENT_DIR=${q(join(fixture, "agent"))} PI_OFFLINE=1 OPENAI_API_KEY=placeholder ${q(join(root, "node_modules/.bin/pi"))} -e ${q(join(root, "packages/pi-better-sandbox/index.ts"))} -e ${q(join(root, "packages/pi-better-subagents/index.ts"))} --no-skills --no-context-files --approve --model openai/gpt-4o-mini`;
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
        let text = wait(/Sandbox permissions\s+Main\s+Subagents\s+Background tasks/);
        assert.match(text, /Tool loading.*Use permissions/);
        key("Tab");
        text = wait(/Active Main tools/);
        assert.match(text, /Ordinary subagent defaults/);
        assert.match(text, /apply_patch\s+·\s+Harness/);
        assert.match(text, /read\s+·\s+Pi/);
        key("Tab");
        text = wait(/Sandbox permissions\s+Main\s+Subagents\s+Background tasks/);
        assert.doesNotMatch(text, /Save as defaults/);
        assert.match(text, /ctrl\+s Save default/);
        assert.match(text, /Sandbox\s+Off\s+Off\s+Off/);
        const focused = tmux("capture-pane", "-t", "permissions", "-e", "-p").split("\n")
            .find((line) => line.replace(/\x1b\[[0-9;]*m/g, "").startsWith("> Sandbox"));
        assert.ok(focused, "selected row is visible in the real terminal");
        assert.match(focused, /\x1b\[[0-9;]*48;[0-9;]*m/, "selected row uses a colored background");
        assert.match(focused, /\x1b\[(?:\d+;)*1(?:;\d+)*m/, "selected row is bold");
        assert.match(focused, /\x1b\[(?:\d+;)*7(?:;\d+)*m/, "active cell has inverse styling");
        assert.match(text, /Project files\s+-\s+-\s+-/);
        assert.match(text, /Stored credentials\s+-\s+-\s+-/);
        assert.match(text, /Run applications\s+-\s+-\s+-/);
        assert.match(text, /Shell scripts\s+-\s+-\s+-/);
        assert.match(text, /Command time limit\s+-\s+-\s+-/);
        key("Right"); key("Space"); wait(/Sandbox\s+Off\s+On\s+Off/);
        key("Left");
        wait(/Project files\s+-\s+Write & delete/);
        wait(/Stored credentials\s+-\s+Write & delete/);
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
        for (let i = 0; i < 6; i++) key("Down");
        wait(/Process access\s+-\s+Read/);
        key("Space"); wait(/Process access\s+-\s+Off/);
        key("Space"); wait(/Process access\s+-\s+Read/);
        for (let i = 0; i < 6; i++) key("Up");
        key("Right"); key("Up"); key("Up");
        key("Space"); wait(/Sandbox\s+Off\s+On\s+On/);
        for (let i = 0; i < 7; i++) key("Down");
        key("Space"); wait(/Network access\s+-\s+On\s+Off/);
        assert.doesNotMatch(screen(), /\[[ x]\] apply_patch|Subagents · Tools/);
        const defaultsPath = join(fixture, "agent/settings.json");
        const savedDefaults = () => existsSync(defaultsPath)
            ? JSON.parse(readFileSync(defaultsPath, "utf8")).piBetterHarness?.sandboxPermissions : undefined;
        assert.equal(savedDefaults(), undefined, "editing must not write global defaults");
        key("Enter"); // Not a save command.
        key("Escape"); wait(/^(?![\s\S]*Sandbox permissions\s+Main)/);
        literal("/reload"); key("Enter"); wait(/Reloaded/);
        literal("/sandbox"); key("Enter");
        wait(/Outside project\s+-\s+Write & delete/);
        wait(/Sandbox\s+Off\s+On\s+On/);
        wait(/Network access\s+-\s+On\s+Off/);
        assert.equal(savedDefaults(), undefined, "reload restores the session without writing defaults");
        key("Space"); wait(/Project files\s+Off\s+Write & delete/);
        key("Space"); wait(/Sandbox\s+Off\s+On/);
        key("C-s"); wait(/Defaults saved\.\s+Looser: Subagents: outsideProject write → read-write/);
        wait(/Defaults saved/);
        const saved = savedDefaults();
        assert.equal(saved.permissions.main.enabled, false);
        assert.equal(saved.permissions.main.projectFiles, "off");
        assert.equal(saved.permissions.subagents.outsideProject, "read-write");
        assert.equal(saved.permissions.subagents.storedCredentials, "read-write");
        assert.equal(saved.permissions.subagents.processAccess, "read");
        assert.equal(saved.permissions.main.processAccess, "read");
        assert.equal(saved.permissions.main.shell, true);
        assert.equal(saved.permissions.main.commandTimeoutSeconds, null);
        assert.equal(saved.permissions.background.enabled, true);
        assert.equal(saved.permissions.background.network, false);
        assert.equal(saved.permissions.background.outsideProject, "read");
        assert.equal(saved.permissions.subagentTools.applyPatch, true);
        key("Space"); wait(/Project files\s+Off\s+Write & delete/); // Session-only Main on.
        key("Escape");
        wait(/^(?![\s\S]*Sandbox permissions\s+Main)/);
        literal("/new"); key("Enter"); wait(/New session/);
        literal("/sandbox"); key("Enter");
        wait(/Sandbox\s+Off\s+On\s+On/);
        wait(/Network access\s+-\s+On\s+Off/);
        wait(/Outside project\s+-\s+Write & delete/);
    } finally {
        spawnSync("tmux", [...args, "kill-server"], { stdio: "ignore" });
        rmSync(fixture, { recursive: true, force: true });
    }
});
