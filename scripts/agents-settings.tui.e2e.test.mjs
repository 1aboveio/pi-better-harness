import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";


const root = dirname(dirname(fileURLToPath(import.meta.url)));
const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

test("agents model and effort edits persist for the session and only Ctrl+S saves catalog defaults in the real TUI", { skip: !hasTmux }, (t) => {
    const fixture = mkdtempSync(join(tmpdir(), "pi-agents-settings-"));
    const agent = join(fixture, "agent");
    const rolePath = join(agent, "agents/roles/role.fixture.md");
    mkdirSync(dirname(rolePath), { recursive: true });
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ tuiMode: "fullscreen" }));
    const original = "---\nschema: pi-agent/v1\nkind: role\nid: role.fixture\nname: Fixture\ndefaults:\n  model: openai/gpt-4o-mini\n  effort: medium\n---\nInspect the fixture.\n";
    writeFileSync(rolePath, original);
    const developerPath = join(dirname(rolePath), "role.developer.md");
    const developerOriginal = original.replaceAll("role.fixture", "role.developer").replace("name: Fixture", "name: Developer").replace("Inspect the fixture.", "Legacy developer instructions.");
    writeFileSync(developerPath, developerOriginal);
    const preferencesPath = join(agent, "agents", "settings.json");
    const scopePath = join(fixture, "scope.json");
    const probePath = join(fixture, "scope-probe.mjs");
    writeFileSync(probePath, `import { writeFileSync } from "node:fs";
export default function(pi) {
    pi.on("session_start", (_event, ctx) => writeFileSync(${JSON.stringify(scopePath)}, JSON.stringify(ctx.scopedModels ?? null)));
}`);
    const args = ["-L", `pi-agents-settings-${process.pid}`];
    const q = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
    const piBin = process.env.PI_AGENTS_SETTINGS_CLI ?? join(root, "node_modules/.bin/pi");
    const mouse = process.env.PI_AGENTS_SETTINGS_MOUSE === "1";
    const command = `cd ${q(fixture)} && exec env PI_CODING_AGENT_DIR=${q(agent)} PI_OFFLINE=1 OPENAI_API_KEY=placeholder ${q(piBin)} -e ${q(join(root, "packages/pi-better-subagents/index.ts"))} -e ${q(join(root, "packages/pi-better-harness/extensions/settings/index.ts"))} -e ${q(probePath)} --no-skills --no-context-files --approve --model openai/gpt-4o-mini --models openai/gpt-4o`;
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
        wait(/Agents \/ Fixture/);
        wait(/> Model/);
    };
    const close = () => {
        wait(/Actual\s+openai\/gpt-4o\s/);
        key("Escape"); wait(/Search/);
        key("Escape"); wait(/^(?![\s\S]*Agents \/ Fixture)(?![\s\S]*Search)/);
    };
    try {
        tmux("new-session", "-d", "-s", "agents", "-x", "100", "-y", "40", command);
        wait(/pi-better-subagents/);
        literal("/harness-settings"); key("Tab"); key("Enter");
        wait(/Agents\s+\/agents/);
        key("Down"); key("Down"); key("Enter");
        const catalogScreen = wait(/Agents.*definitions/);
        assert.match(catalogScreen.split("\n")[0], /^Agents/);
        assert.match(catalogScreen, /MODEL\s+EFFORT/);
        assert.match(catalogScreen, /Fixture\s+openai\/gpt-4o-mini\s+off/);
        assert.doesNotMatch(catalogScreen, /Harness settings/, "fullscreen catalog covers the settings hub");
        assert.equal(readFileSync(rolePath, "utf8"), original, "the settings shortcut does not write catalog defaults");
        key("Escape"); wait(/Harness settings/);
        key("Escape"); wait(/^(?![\s\S]*Harness settings)/);
        open();
        const settingsScreen = wait(/Agents \/ Fixture/);
        assert.match(settingsScreen.split("\n")[0], /^Agents \/ Fixture/);
        assert.doesNotMatch(settingsScreen, /Search/, "fullscreen detail covers the catalog list");
        assert.match(settingsScreen, /\[Settings\].*Instructions.*Files/, "detail opens the Settings tab");
        assert.doesNotMatch(settingsScreen, /Inspect the fixture\./, "instructions stay in their own tab");
        assert.doesNotMatch(settingsScreen, /> Save defaults/, "saving has no selectable row");
        key("Tab");
        const promptScreen = wait(/\[Instructions\]/);
        assert.match(promptScreen, /Inspect the fixture\./);
        key("Tab"); wait(/\[Files\]/);
        wait(/Definition/);
        key("Tab"); wait(/\[Settings\]/);
        key("Enter");
        const modelPicker = wait(/Agents \/ model/);
        assert.match(modelPicker, /openai\/gpt-4o/);
        const scope = JSON.parse(readFileSync(scopePath, "utf8"));
        if (Array.isArray(scope)) {
            assert.ok(scope.length > 0, "the host must resolve the configured model scope");
            assert.doesNotMatch(modelPicker, /openai\/gpt-4o-mini/, "a saved out-of-scope model stays in the details, not the picker");
        } else t.diagnostic("This host does not expose scopedModels; scope filtering requires PI_AGENTS_SETTINGS_CLI pointing to a newer Pi.");
        literal("openai/gpt-4o"); wait(/openai\/gpt-4o/); key("Enter");
        wait(/Model\s+openai\/gpt-4o\s+session/);
        key("Down"); key("Enter"); wait(/Agents \/ effort/);
        key("Up"); key("Enter"); wait(/Effort\s+low\s+session/);
        assert.equal(readFileSync(rolePath, "utf8"), original, "session editing must not write catalog defaults");
        close(); literal("/reload"); key("Enter"); wait(/Reloaded/);
        open(); wait(/Effort\s+low\s+session/); wait(/Model\s+openai\/gpt-4o\s+session/);
        assert.equal(readFileSync(rolePath, "utf8"), original);
        key("C-s"); wait(/saved/i);
        const saved = JSON.parse(readFileSync(preferencesPath, "utf8")).defaults["role.fixture"];
        assert.equal(saved.effort, "low");
        assert.equal(saved.model, "openai/gpt-4o");
        assert.equal(readFileSync(rolePath, "utf8"), original, "Ctrl+S writes config without copying or rewriting the Markdown prompt");
        tmux("resize-window", "-t", "agents", "-x", "40", "-y", "24");
        wait(/Agents \/ Fixture/);
        tmux("new-window", "-t", "agents", "-n", "fresh-defaults", command);
        tmux("resize-window", "-t", "agents", "-x", "100", "-y", "40");
        wait(/pi-better-subagents/);
        open();
        wait(/Model\s+openai\/gpt-4o\s+user config/);
        const freshSettings = wait(/Effort\s+low\s+user config/);
        assert.doesNotMatch(freshSettings, /(?:Model|Effort)[^\n]*session/, "fresh settings come from durable catalog defaults");
        close();
        literal("/agents inspect role.developer"); key("Tab"); key("Enter");
        wait(/Agents \/ Developer/);
        const actionable = wait(/Reset to bundled/);
        if (mouse) {
            const row = actionable.split("\n").findIndex(line => line.includes("Reset to bundled"));
            literal(`\x1b[<0;5;${row + 1}M`);
            literal(`\x1b[<0;5;${row + 1}m`);
        } else {
            key("Down"); key("Down");
            wait(/> Reset to bundled/);
            key("Enter");
            t.diagnostic("Keyboard reset verified; native one-click routing requires a fullscreen mouse-capable Pi host.");
        }
        wait(/Bundled model\/effort restored/);
        assert.equal(readFileSync(developerPath, "utf8"), developerOriginal, "runtime reset keeps the role prompt");
        assert.deepEqual(JSON.parse(readFileSync(preferencesPath, "utf8")).defaults["role.developer"], { bundled: true });
        wait(/Model\s+openai\/gpt-6.1-sol\s+bundled/);
        wait(/Effort\s+high\s+bundled/);
        key("Tab");
        const instructionTab = wait(/\[Instructions\]/);
        assert.match(instructionTab, /Legacy developer instructions/);
        if (mouse) {
            const row = instructionTab.split("\n").findIndex(line => line.includes("Reset to bundled"));
            literal(`\x1b[<0;5;${row + 1}M`);
            literal(`\x1b[<0;5;${row + 1}m`);
        } else key("Enter");
        const reset = wait(/Source:\s+bundled/);
        assert.doesNotMatch(reset, /Legacy developer instructions/);
        assert.equal(existsSync(developerPath), false);
        const backup = readdirSync(dirname(developerPath)).find(name => name.startsWith(".role.developer.md.") && name.endsWith(".backup"));
        assert.equal(readFileSync(join(dirname(developerPath), backup), "utf8"), developerOriginal);
        assert.deepEqual(JSON.parse(readFileSync(preferencesPath, "utf8")).defaults["role.developer"], { bundled: true }, "prompt reset keeps bundled runtime inheritance");
        wait(/Delivery and publishing belong to the coordinator/);
    } finally {
        spawnSync("tmux", [...args, "kill-server"], { stdio: "ignore" });
        rmSync(fixture, { recursive: true, force: true });
    }
});
