import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

function selectedRow(text) {
    const matches = [...text.matchAll(/^> (.*)$/gm)];
    const value = matches.length === 1 ? matches[0][1] : undefined;
    return value?.trim() ? value : undefined;
}

function permissionRows(text) {
    return text.split("\n").filter((line) => /^(?:> |  )(?:Sandbox\s+(?:Off|On)|Project files\s|Outside project\s|Stored credentials\s|Run commands & applications\s|Network access\s|Process access\s|  (?:[>v] )?\[[ x-]\]|      \[[ x]\])/.test(line))
        .map((line) => line.slice(2).trimEnd());
}

function selectionDriver(wait, key) {
    let text = "";
    const waitSelected = (pattern, state = () => true) => {
        text = wait((frame) => {
            const row = selectedRow(frame);
            return row !== undefined && (typeof pattern === "string" ? row.trimEnd() === pattern : pattern.test(row)) && state(frame);
        });
        return text;
    };
    return {
        waitSelected,
        press(value, pattern, state) {
            key(value);
            return waitSelected(pattern, state);
        },
        moveTo(pattern, direction = "Down") {
            if (!text) waitSelected(/\S/);
            for (let i = 0; i < 60; i++) {
                const before = selectedRow(text).trimEnd();
                if (pattern.test(before)) return text;
                const rows = permissionRows(text);
                const index = rows.indexOf(before);
                assert.ok(index >= 0, `Selected row is not navigable:\n${text}`);
                const next = rows[index + (direction === "Up" ? -1 : 1)];
                assert.notEqual(next, undefined, `Could not select ${pattern}: reached ${direction} boundary:\n${text}`);
                key(direction);
                // A count change or a partially painted row is not an arrow acknowledgement.
                waitSelected(next, (frame) => permissionRows(frame).join("\n") === rows.join("\n"));
            }
            assert.fail(`Could not select ${pattern}:\n${text}`);
        },
    };
}

test("selection synchronization rejects absent and blank redraw rows", () => {
    for (const frame of ["", "Other row\n", "> \n", ">    \n", "> \t \n"]) {
        assert.equal(selectedRow(frame), undefined, JSON.stringify(frame));
    }
    const value = "  > [ ] atlas (fixture-alpha) 0/2";
    assert.equal(selectedRow(`Other row\n> ${value}\nFooter`), value);
});

test("selection synchronization rejects duplicate selected rows during redraw", () => {
    assert.equal(selectedRow(">   > [ ] atlas (fixture-alpha) 0/2\n>   > [ ] atlas (fixture-beta) 0/1"), undefined);
});

function captureSequence(frames) {
    const remaining = [...frames];
    const keys = [];
    return {
        keys,
        driver: selectionDriver((accept) => {
            while (remaining.length) {
                const frame = remaining.shift();
                if (accept(frame)) return frame;
            }
            assert.fail("No capture acknowledged the input");
        }, (key) => keys.push(key)),
        assertConsumed() { assert.equal(remaining.length, 0, "must wait for the final coherent capture"); },
    };
}

test("selection navigation acknowledges exact adjacent rows before sending another arrow", () => {
    const alpha = "  > [ ] atlas (fixture-alpha) 0/2";
    const beta = "  > [ ] atlas (fixture-beta) 0/1";
    const beacon = "  > [ ] beacon (fixture-alpha) 0/1";
    const frame = (selected) => [alpha, beta, beacon].map((row) => `${row === selected ? "> " : "  "}${row}`).join("\n");
    const h = captureSequence([
        frame(alpha),
        frame(alpha), // Arrow has not been processed yet.
        frame(alpha).replaceAll("0/2", "2/2"), // An apply redraw is not navigation.
        frame(beacon), // A different row is still not the expected adjacent row.
        frame(beta).replace(`  ${alpha}`, `> ${alpha}`), // Two selection markers mid-redraw.
        frame(beta),
        frame(beta),
        frame(beacon).replace("beacon (fixture-alpha) 0/1", "bea"),
        frame(beacon),
        frame(beta),
        frame(alpha),
    ]);
    h.driver.waitSelected(/atlas .*fixture-alpha.*0\/2/);
    h.driver.moveTo(/beacon .*0\/1/);
    assert.deepEqual(h.keys, ["Down", "Down"]);
    h.driver.moveTo(/atlas .*fixture-alpha.*0\/2/, "Up");
    h.assertConsumed();
    assert.deepEqual(h.keys, ["Down", "Down", "Up", "Up"]);
});

test("selection toggles wait for focus and applied state in the same capture", () => {
    const frame = (count, tick, selected = true) => `    v [-] atlas (fixture-alpha) ${count}/2\n${selected ? "> " : "  "}      [${tick}] mcp__atlas__read\n${selected ? "  " : "> "}  > [ ] atlas (fixture-beta) 0/1`;
    const h = captureSequence([frame(0, " "), frame(1, " "), frame(0, "x"), frame(1, "x", false), frame(1, "x")]);
    h.driver.waitSelected(/\[ \] mcp__atlas__read$/);
    h.driver.press("Space", /\[x\] mcp__atlas__read$/, (text) => /atlas \(fixture-alpha\) 1\/2/.test(text));
    h.assertConsumed();
    assert.deepEqual(h.keys, ["Space"]);
});

test("selection navigation fails at a boundary without sending an unacknowledgeable arrow", () => {
    const h = captureSequence([">   > [ ] beacon (fixture-alpha) 0/1"]);
    h.driver.waitSelected(/beacon/);
    assert.throws(() => h.driver.moveTo(/atlas/), /reached Down boundary/);
    assert.deepEqual(h.keys, []);
});

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
        assert.match(text, /Stored credentials\s+-\s+Write & delete/);
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
        for (let i = 0; i < 4; i++) key("Down");
        wait(/Process access\s+-\s+Read/);
        key("Space"); wait(/Process access\s+-\s+Off/);
        key("Space"); wait(/Process access\s+-\s+Read/);
        for (let i = 0; i < 4; i++) key("Up");
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
        key("C-s"); wait(/Defaults saved\.\s+Looser: Subagents: outsideProject write → read-write/);
        wait(/Defaults saved/);
        const saved = JSON.parse(readFileSync(defaultsPath, "utf8"));
        assert.equal(saved.permissions.main.enabled, false);
        assert.equal(saved.permissions.main.projectFiles, "off");
        assert.equal(saved.permissions.subagents.outsideProject, "read-write");
        assert.equal(saved.permissions.subagents.storedCredentials, "read-write");
        assert.equal(saved.permissions.subagents.processAccess, "read");
        assert.equal(saved.permissions.main.processAccess, "read");
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
    const { waitSelected, press, moveTo } = selectionDriver(wait, key);
    const alphaAtlas = (fold, tick, count) => new RegExp(`^  ${fold} \\[${tick}\\] atlas \\([^\\n]*fixture-alpha\\) ${count}/2\\s*$`);
    const alphaPackage = (tick, count) => new RegExp(`^  > \\[${tick}\\] [^\\n]*fixture-alpha ${count}/1\\s*$`);
    try {
        tmux("new-session", "-d", "-s", "permissions", "-x", "130", "-y", "50", command);
        wait(/sandbox/);
        literal("/sandbox"); key("Enter");
        let text = waitSelected(/^Sandbox\s+Off\s+On\s*$/, (frame) => /Subagents · Tools[\s\S]*ctrl\+s Save default/.test(frame));
        assert.match(text, /\[ \].*fixture-alpha.*0\/1/);
        assert.match(text, /\[ \].*fixture-beta.*0\/1/);
        assert.match(text, /> \[ \] atlas \([^\n]*fixture-alpha\) 0\/2/);
        assert.match(text, /atlas \([^\n]*fixture-beta\).*0\/1/);
        assert.doesNotMatch(text, /mcp__atlas__read/, "groups start collapsed");
        moveTo(/atlas \([^\n]*fixture-alpha\).*0\/2/);
        press("Right", alphaAtlas("v", " ", 0), (frame) => /\[ \] mcp__atlas__read/.test(frame));
        moveTo(/mcp__atlas__read/);
        press("Space", /^      \[x\] mcp__atlas__read\s+needs Network On\s*$/, (frame) => /v \[-\] atlas \([^\n]*fixture-alpha\) 1\/2/.test(frame));
        text = press("Left", alphaAtlas(">", "-", 1), (frame) => !/mcp__atlas__read/.test(frame));
        assert.match(selectedRow(text), /> \[-\] atlas \([^\n]*fixture-alpha\) 1\/2/);
        text = press("Space", alphaAtlas(">", "x", 2));
        assert.match(text, /atlas \([^\n]*fixture-beta\).*0\/1/, "same provider in another package is untouched");
        moveTo(alphaPackage(" ", 0), "Up");
        press("Space", alphaPackage("x", 1));
        press("Space", alphaPackage(" ", 0));
        moveTo(/atlas \([^\n]*fixture-alpha\).*2\/2/);
        press("Space", alphaAtlas(">", " ", 0));
        press("Space", alphaAtlas(">", "x", 2));
        press("Right", alphaAtlas("v", "x", 2), (frame) => /\[x\] mcp__atlas__read/.test(frame));
        press("Left", alphaAtlas(">", "x", 2), (frame) => !/mcp__atlas__read/.test(frame));
        press("Enter", alphaAtlas("v", "x", 2), (frame) => /\[x\] mcp__atlas__read/.test(frame));
        text = press("Enter", alphaAtlas(">", "x", 2), (frame) => !/mcp__atlas__read/.test(frame));
        assert.equal(existsSync(join(agent, "extensions/pi-better-sandbox-permissions.json")), false);
        assert.doesNotMatch(text, /Save as defaults/);
        press("C-s", alphaAtlas(">", "x", 2), (frame) => /Defaults saved[\s\S]*Looser:/.test(frame));
        const saved = JSON.parse(readFileSync(join(agent, "extensions/pi-better-sandbox-permissions.json"), "utf8"));
        assert.equal(saved.permissions.subagentTools.applyPatch, true);
        assert.deepEqual(Object.keys(saved.permissions.subagentTools).sort(), ["applyPatch", "trusted"]);
        assert.deepEqual(saved.permissions.subagentTools.trusted.map((tool) => [tool.name, tool.package]).sort((a, b) => a[0].localeCompare(b[0])), [
            ["mcp__atlas__read", alpha], ["mcp__atlas__write", alpha],
            ["web_fetch", "npm:@juicesharp/rpiv-web-tools"], ["web_search", "npm:@juicesharp/rpiv-web-tools"],
        ]);
        key("Escape"); wait(/^(?![\s\S]*Sandbox permissions\s+Main)/);
        literal("/reload"); key("Enter"); wait(/Reloaded/);
        literal("/sandbox"); key("Enter");
        text = waitSelected(/^Sandbox\s+Off\s+On\s*$/, (frame) => /Subagents · Tools[\s\S]*ctrl\+s Save default/.test(frame));
        assert.match(text, /atlas \([^\n]*fixture-alpha\).*2\/2/);
        assert.match(text, /atlas \([^\n]*fixture-beta\).*0\/1/);
        assert.doesNotMatch(text, /mcp__atlas__read/, "fold state is not persisted");
        moveTo(/atlas \([^\n]*fixture-alpha\).*2\/2/);
        text = press("Right", alphaAtlas("v", "x", 2), (frame) => /\[x\] mcp__atlas__read/.test(frame));
        assert.match(text, /\[x\] mcp__atlas__write/);
        moveTo(/beacon \([^\n]*fixture-alpha\).*0\/1/);
        press("Right", /^  v \[ \] beacon \([^\n]*fixture-alpha\) 0\/1\s*$/, (frame) => /\[ \] mcp__beacon__read/.test(frame));
    } finally {
        spawnSync("tmux", [...args, "kill-server"], { stdio: "ignore" });
        rmSync(fixture, { recursive: true, force: true });
    }
});
