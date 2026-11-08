/**
 * Real Pi TUI proof for the `/agents` skill-configuration row (#664).
 *
 * Drives the actual extension in tmux: open an agent, choose No skill catalog,
 * reload, reopen, choose Selected skills, then restore inheritance, and read the
 * definition files plus the effective catalog resolution afterwards.
 *
 * Run from the repository root:
 *
 *   node --import tsx --import ./scripts/isolate-registry.mjs \
 *     --test scripts/agents-skills.tui.e2e.test.mjs
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setConfigForTests } from "../packages/pi-better-subagents/config.ts";
import { loadCatalog } from "../packages/pi-better-subagents/catalog-store.ts";
import { resolveSelection } from "../packages/pi-better-subagents/catalog-resolver.ts";
import { parseDefinition } from "../packages/pi-better-subagents/catalog-schema.ts";
import { resolveSkillExposure } from "../packages/pi-better-subagents/skills.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EVIDENCE = join(ROOT, "packages/pi-better-subagents/docs/evidence/664-skill-catalog-tui");
const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

test("the real /agents TUI configures, persists, reloads, and restores skill exposure", { skip: !hasTmux }, (t) => {
    const fixture = mkdtempSync(join(tmpdir(), "pi-agents-skills-"));
    const agentDir = join(fixture, "agent");
    const rolePath = join(agentDir, "agents", "roles", "role.fixture.md");
    const agentPath = join(agentDir, "agents", "agents", "agent.fixture.md");
    const skillPath = join(fixture, "skills", "review", "SKILL.md");
    mkdirSync(dirname(rolePath), { recursive: true });
    mkdirSync(dirname(agentPath), { recursive: true });
    mkdirSync(dirname(skillPath), { recursive: true });
    writeFileSync(skillPath, "---\nname: review\ndescription: Review a change.\n---\nReview.\n");
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ tuiMode: "fullscreen" }));
    writeFileSync(rolePath, "---\nschema: pi-agent/v1\nkind: role\nid: role.fixture\nname: Fixture\ndefaults:\n  model: openai/gpt-4o-mini\n  effort: medium\n---\nInspect the fixture.\n");
    writeFileSync(agentPath, "---\nschema: pi-agent/v1\nkind: agent\nid: agent.fixture\nname: Fixture Agent\nroleId: role.fixture\ninstructions:\n  mode: add\n---\nCheck the fixture.\n");

    const name = `pi-agents-skills-${process.pid}`;
    const args = ["-L", name];
    const q = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
    const piBin = process.env.PI_AGENTS_SETTINGS_CLI ?? join(ROOT, "node_modules/.bin/pi");
    const command = `cd ${q(fixture)} && exec env PI_CODING_AGENT_DIR=${q(agentDir)} PI_OFFLINE=1 OPENAI_API_KEY=placeholder ${q(piBin)} -e ${q(join(ROOT, "packages/pi-better-subagents/index.ts"))} --no-skills --skill ${q(skillPath)} --no-context-files --approve --model openai/gpt-4o-mini --models openai/gpt-4o`;
    const tmux = (...more) => execFileSync("tmux", [...args, ...more], { encoding: "utf8" });
    const key = (value) => tmux("send-keys", "-t", "agents", value);
    const literal = (value) => tmux("send-keys", "-t", "agents", "-l", value);
    const wait = (pattern) => {
        const deadline = Date.now() + 20_000;
        let screen = "";
        while (Date.now() < deadline) {
            screen = tmux("capture-pane", "-t", "agents", "-p");
            if (pattern.test(screen)) return screen;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
        assert.fail(`Missing ${pattern}:\n${screen}`);
    };
    const capture = (file) => {
        const screen = tmux("capture-pane", "-t", "agents", "-p");
        writeFileSync(join(EVIDENCE, file), `${screen.trimEnd()}\n`);
        return screen;
    };
    const open = () => {
        literal("/agents inspect agent.fixture"); key("Tab"); key("Enter");
        wait(/Agents \/ Fixture Agent/);
        wait(/> Model/);
    };
    const close = () => {
        key("Escape"); wait(/Search/);
        key("Escape"); wait(/^(?![\s\S]*Agents \/ Fixture Agent)(?![\s\S]*Search)/);
    };
    const openSkills = () => {
        key("Down"); key("Down"); wait(/> Skills/);
        key("Enter"); wait(/Agents \/ skills/);
    };

    try {
        mkdirSync(EVIDENCE, { recursive: true });
        tmux("new-session", "-d", "-s", "agents", "-x", "100", "-y", "40", command);
        wait(/pi-better-subagents/);
        open();
        assert.match(capture("real-pi-detail-inherit-100.txt"), /Skills\s+inherit/);

        openSkills();
        capture("real-pi-skills-picker-100.txt");
        key("Down"); // Inherit -> No skill catalog
        key("Enter");
        const none = wait(/Skills\s+no skill catalog/);
        assert.match(none, /Skills saved \(user\): agent\.fixture · none/);
        capture("real-pi-detail-none-100.txt");
        const savedNone = parseDefinition(readFileSync(agentPath, "utf8"));
        assert.equal(savedNone.ok, true, JSON.stringify(savedNone.diagnostics));
        assert.deepEqual(savedNone.definition.overrides.skills, []);

        tmux("resize-window", "-t", "agents", "-x", "42", "-y", "24");
        capture("real-pi-detail-none-42.txt");
        tmux("resize-window", "-t", "agents", "-x", "100", "-y", "40");
        wait(/Skills\s+no skill catalog/);

        close();
        literal("/reload"); key("Enter"); wait(/Reloaded/);
        open();
        wait(/Skills\s+no skill catalog/);

        openSkills();
        key("Down"); // No skill catalog -> Selected skills
        key("Enter");
        wait(/Selected skills/);
        wait(/\[ \] review/);
        capture("real-pi-skill-checkbox-100.txt");
        key("Space");
        capture("real-pi-skill-checkbox-checked-100.txt");
        key("Enter");
        const selected = wait(/Skills\s+1 selected/);
        assert.match(selected, /Skills saved \(user\): agent\.fixture · 1 selected/);
        capture("real-pi-detail-selected-100.txt");
        const savedSelected = parseDefinition(readFileSync(agentPath, "utf8"));
        assert.equal(savedSelected.ok, true, JSON.stringify(savedSelected.diagnostics));
        assert.deepEqual(savedSelected.definition.overrides.skills, [skillPath]);

        openSkills();
        key("Up"); key("Up"); // Selected -> Inherit
        key("Enter");
        wait(/Skills\s+inherit/);
        close();
    } finally {
        try { tmux("kill-session", "-t", "agents"); } catch { /* session already gone */ }
    }

    const savedInherit = parseDefinition(readFileSync(agentPath, "utf8"));
    assert.equal(savedInherit.ok, true, JSON.stringify(savedInherit.diagnostics));
    assert.equal(savedInherit.definition.overrides.skills, undefined, "inherit deletes the override");

    setConfigForTests({});
    const snapshot = loadCatalog({
        cwd: fixture,
        userRoot: agentDir,
        bundledRoot: join(ROOT, "packages/pi-better-subagents/roles"),
        projectTrusted: true,
    });
    const resolved = resolveSelection(snapshot, { agentId: "agent.fixture" });
    assert.equal(resolved.launchable, true, resolved.diagnostics.map((item) => item.message).join("\n"));
    assert.deepEqual(resolved.effective.skills, { value: null, source: "absent", explicit: false });
    assert.deepEqual(resolveSkillExposure({ catalog: resolved.effective.skills.value, configured: null, cwd: fixture }), {
        mode: "inherit",
        paths: [],
        source: "default",
    });
    assert.equal(existsSync(join(agentDir, "agents", "settings.json")), false, "the skill edit never writes catalog preferences");
    setConfigForTests(undefined);

    t.diagnostic(`Artifacts: ${EVIDENCE}`);
    rmSync(fixture, { recursive: true, force: true });
});
