/**
 * The global skill setting through the real settings page, config store, and
 * launch argv.
 *
 * The page is the only writer, the global settings file is the only persistence,
 * and `resolveSkillExposure` + `skillLaunchArgs` are the launch contract the
 * child receives. A saved choice must survive a config reload, and choosing
 * discovery again must clear a saved path list instead of being ignored.
 *
 * @covers subagent.skill-settings-tui
 * @level integration
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";

const root = mkdtempSync(join(tmpdir(), "skill-settings-tui-"));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;

const { default: extension } = await import("../index.ts");
const config = await import("../config.ts");
const registry = await import("../registry.ts");
const { resolveSkillExposure, skillLaunchArgs } = await import("../skills.ts");

const settingsPath = join(root, "settings.json");
config.setConfigPathForTests(settingsPath);
config.setConfigForTests(undefined);
process.env.PI_SUBAGENTS_TEST_REGISTRY = registry.baseDir();

const fakeBin = join(root, "fake-bin");
mkdirSync(fakeBin, { recursive: true });
const fakePi = join(fakeBin, "pi");
writeFileSync(fakePi, `#!/bin/bash
args=("$@")
id=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --session-id) id="$2"; shift 2 ;;
    *) shift ;;
  esac
done
base="$PI_SUBAGENTS_TEST_REGISTRY"
mkdir -p "$base/runs/$id"
printf '%s\\n' "\${args[@]}" > "$base/runs/$id/argv.txt"
printf '%s\\n' '{"type":"agent_settled"}' '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"done"}]}]}' > "$base/runs/$id/output.log"
`, { mode: 0o755 });
chmodSync(fakePi, 0o755);
process.env.PATH = `${fakeBin}:${process.env.PATH}`;

const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text, inverse: (text) => text };
const pages = [];
const renders = [];
const keyBatches = [];
let promptSkills = [];

function readSkills() {
    const raw = JSON.parse(readFileSync(settingsPath, "utf8"));
    return raw.piBetterHarness.subagents.defaultSkills;
}

function reloadedConfig() {
    config.setConfigForTests(undefined);
    return config.loadConfig();
}

function ctx() {
    return {
        cwd: root, mode: "tui", hasUI: true, isProjectTrusted: () => false,
        getSystemPromptOptions: () => ({ cwd: root, skills: promptSkills }),
        sessionManager: { getBranch: () => [] },
        ui: {
            notify() {},
            setWidget() {}, setStatus() {},
            custom(factory) {
                return new Promise((resolve) => {
                    let settled = false;
                    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
                    const page = factory({ requestRender() {} }, theme, {}, done);
                    pages.push(page);
                    const keys = keyBatches.length > 0 ? keyBatches.shift() : [];
                    for (const key of keys) {
                        if (settled) break;
                        page.handleInput(key);
                    }
                    renders.push(page.render(160).join("\n"));
                    for (let attempt = 0; attempt < 3 && !settled; attempt++) page.handleInput("\x1b");
                });
            },
        },
    };
}

function keysToSkillsRow() {
    return ["\x1b[B", "\x1b[B", "\x1b[B", "\x1b[B"];
}

function writeRoleDefinition() {
    const dir = join(agentDir, "agents", "roles");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "role.work.md"), `---
schema: pi-agent/v1
kind: role
id: role.work
name: Worker
description: Does the work.
defaults:
  model: openai/alpha
  effort: medium
  tier: balanced
---
Role instructions.
`);
}

async function inspectRole(runtime) {
    const result = await runtime.tools.agents_catalog.execute(
        "tc-inspect-role", { action: "inspect", id: "role.work" }, null, null, toolCtx(),
    );
    assert.equal(result.isError, undefined, result.content[0].text);
    return result.details.view;
}

async function agentsView(runtime) {
    const components = [];
    const host = {
        cwd: root, mode: "tui", hasUI: true, isProjectTrusted: () => false,
        getSystemPromptOptions: () => ({ cwd: root, skills: promptSkills }),
        sessionManager: { getBranch: () => [] },
        ui: {
            notify() {}, setWidget() {},
            custom(factory) {
                return new Promise((resolve) => {
                    let settled = false;
                    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
                    const component = factory({ requestRender() {} }, theme, {}, done);
                    components.push(component);
                    let screen = component.render(100).join("\n");
                    if (!screen.includes("Skills")) {
                        component.handleInput("\r");
                        screen = component.render(100).join("\n");
                    }
                    if (!settled) done(undefined);
                });
            },
        },
    };
    await runtime.commands.get("agents").handler("show role.work", host);
    assert.ok(components.length > 0, "the /agents view must open");
    return components.at(-1).render(100).join("\n");
}

function skill(name) {
    const dir = join(root, "skills", name);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "SKILL.md");
    writeFileSync(path, `---\nname: ${name}\n---\n`);
    return path;
}

function saveConfig(defaultSkills) {
    config.writeSubagentSettings({ delegationMode: "adaptive", maxConcurrent: 4, defaultSkills });
    config.setConfigForTests(undefined);
}

function createRuntime() {
    const events = createEventBus();
    const registrations = [];
    events.on("harness-settings:register", (item) => registrations.push(item));
    const tools = {};
    const commands = new Map();
    const entries = [];
    extension({
        events,
        registerTool(definition) { tools[definition.name] = definition; },
        registerCommand(name, command) { commands.set(name, command); },
        on() {},
        appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
        sendMessage() {},
        sendUserMessage() {},
    });
    const contribution = registrations.find((item) => item.id === "subagents");
    assert.equal(contribution.command, "/subagents settings", "the harness-settings link points at this page");
    return { events, registrations, tools, commands, entries, contribution };
}

async function openSettings(keys, runtime = createRuntime()) {
    keyBatches.push(keys);
    await runtime.contribution.open(ctx());
    return pages.at(-1);
}

function toolCtx() {
    return {
        cwd: root,
        model: { provider: "test", id: "model" },
        hasUI: false,
        isProjectTrusted: () => false,
        ui: { notify() {}, setWidget() {} },
        sessionManager: { getBranch: () => [] },
    };
}

function clearRuns() {
    rmSync(join(registry.baseDir(), "runs"), { recursive: true, force: true });
    if (process.env.PI_SUBAGENT_DURABLE_DIR) {
        rmSync(process.env.PI_SUBAGENT_DURABLE_DIR, { recursive: true, force: true });
    }
}

async function waitForFinished(id) {
    for (let attempt = 0; attempt < 200; attempt++) {
        const meta = registry.readMeta(id);
        if (meta && meta.status !== "running") return meta;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`run ${id} did not finish`);
}

async function spawn(runtime, params = {}) {
    clearRuns();
    const res = await runtime.tools.subagent_spawn.execute("tc-skill-session", {
        prompt: "probe skill exposure", tools: "read,bash", sandbox: false, ...params,
    }, null, null, toolCtx());
    const id = res.content[0].text.match(/id=(sa_[a-z0-9_]+)/)?.[1];
    assert.ok(id, `launch must return a run id, got: ${res.content[0].text}`);
    const meta = await waitForFinished(id);
    const argvPath = join(registry.baseDir(), "runs", id, "argv.txt");
    const argv = readFileSync(argvPath, "utf8").trim().split("\n");
    return { id, meta, argv, text: res.content[0].text };
}

test.after(() => {
    config.setConfigPathForTests(undefined);
    config.setConfigForTests(undefined);
    rmSync(root, { recursive: true, force: true });
});

test("the settings page saves selected skills, reloads, and reaches the child argv", async () => {
    const skillDir = join(root, "skills", "review");
    mkdirSync(skillDir, { recursive: true });
    const skill = join(skillDir, "SKILL.md");
    writeFileSync(skill, "---\nname: review\n---\n");

    const page = await openSettings([
        ...keysToSkillsRow(),
        "\x1b[B", // Selected skills row
        "\r", // open checkbox picker
        "\x1b[B", // apply -> add path
        "\r",
        skill,
        "\r",
        "\x1b[A", // add path -> apply
        "\r",
        "\x13", // save default
        "\x1b",
    ]);
    assert.match(page.render(100).join("\n"), /Selected skills/);
    assert.deepEqual(readSkills(), [skill], "the page wrote the global default, not a package fallback");
    assert.deepEqual(reloadedConfig().defaultSkills, [skill], "a later load reads the saved value");

    const exposure = resolveSkillExposure({ configured: reloadedConfig().defaultSkills, cwd: root });
    assert.equal(exposure.mode, "explicit");
    assert.equal(exposure.source, "config");
    assert.deepEqual(skillLaunchArgs(exposure), ["--no-skills", "--skill", skill],
        "a subsequent launch carries the saved skill and disables discovery");
});

test("saving discovery replaces a saved path list with an explicit null", async () => {
    const skillDir = join(root, "skills", "already-saved");
    mkdirSync(skillDir, { recursive: true });
    const skill = join(skillDir, "SKILL.md");
    writeFileSync(skill, "---\nname: already-saved\n---\n");
    config.writeSubagentSettings({ delegationMode: "adaptive", maxConcurrent: 4, defaultSkills: [skill] });
    config.setConfigForTests(undefined);
    assert.deepEqual(config.loadConfig().defaultSkills, [skill]);

    const page = await openSettings([
        ...keysToSkillsRow(),
        "\r", // selected -> discovery
        "\x13",
        "\x1b",
    ]);
    assert.match(page.render(100).join("\n"), /Discover automatically/);
    assert.equal(readSkills(), null, "discovery is stored as null rather than dropping the key");
    assert.equal(reloadedConfig().defaultSkills, null);
    const exposure = resolveSkillExposure({ configured: reloadedConfig().defaultSkills, cwd: root });
    assert.equal(exposure.mode, "inherit");
    assert.equal(exposure.source, "default");
    assert.deepEqual(skillLaunchArgs(exposure), [], "a subsequent launch advertises the user catalog again");

    const inheritedRecipe = resolveSkillExposure({
        saved: {}, configured: [skill], cwd: root,
    });
    assert.equal(inheritedRecipe.mode, "inherit", "a recipe saved before #664 still keeps discovery");
    assert.equal(inheritedRecipe.source, "recipe");
});

test("No skill catalog persists [] and launches with --no-skills", async () => {
    const page = await openSettings([
        ...keysToSkillsRow(),
        "\r", // discovery -> none
        "\x13",
        "\x1b",
    ]);
    assert.match(page.render(100).join("\n"), /No skill catalog/);
    assert.deepEqual(readSkills(), []);
    assert.deepEqual(reloadedConfig().defaultSkills, []);
    const exposure = resolveSkillExposure({ configured: reloadedConfig().defaultSkills, cwd: root });
    assert.equal(exposure.mode, "none");
    assert.equal(exposure.source, "config");
    assert.deepEqual(skillLaunchArgs(exposure), ["--no-skills"]);
});

test("save preserves unrelated Pi and harness settings", async () => {
    const existing = JSON.parse(readFileSync(settingsPath, "utf8"));
    existing.theme = "dark";
    existing.packages = ["npm:example"];
    existing.piBetterHarness.goal = { autoContinue: false };
    writeFileSync(settingsPath, JSON.stringify(existing));

    await openSettings([
        ...keysToSkillsRow(),
        "\x1b[B", // Selected skills row
        "\r", // open checkbox picker
        "\x1b[B", // apply -> add path
        "\r",
        join(root, "skills", "review", "SKILL.md"),
        "\r",
        "\x1b[A", // add path -> apply
        "\r",
        "\x13",
        "\x1b",
    ]);
    const saved = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(saved.theme, "dark");
    assert.deepEqual(saved.packages, ["npm:example"]);
    assert.deepEqual(saved.piBetterHarness.goal, { autoContinue: false });
    assert.deepEqual(saved.piBetterHarness.subagents.defaultSkills, [join(root, "skills", "review", "SKILL.md")]);
});

test("unsaved session skill choices drive the actual child argv", async () => {
    const saved = skill("saved");
    saveConfig([saved]);
    const runtime = createRuntime();

    await openSettings([...keysToSkillsRow(), "\r", "\r", "\x1b"], runtime);
    let run = await spawn(runtime);
    assert.deepEqual(readSkills(), [saved], "the unsaved choice did not rewrite the saved config");
    assert.equal(run.argv.includes("--no-skills"), true);
    assert.equal(run.argv.includes("--skill"), false);
    assert.deepEqual(run.meta.skills, []);
    assert.equal(run.meta.skillsSource, "session");
    assert.match(run.text, /source session/);

    const chosen = skill("chosen");
    await openSettings([
        ...keysToSkillsRow(),
        "\x1b[B", "\r", // Selected skills -> picker
        "\x1b[B", "\r", chosen, "\r", // add path
        "\x1b[A", "\r", // apply
        "\x1b",
    ], runtime);
    run = await spawn(runtime);
    assert.deepEqual(run.meta.skills, [chosen]);
    assert.equal(run.meta.skillsSource, "session");
    assert.deepEqual(run.argv.flatMap((arg, index) => arg === "--skill" ? [run.argv[index + 1]] : []), [chosen]);

    await openSettings([...keysToSkillsRow(), "\r", "\x1b"], runtime);
    run = await spawn(runtime);
    assert.equal(run.argv.includes("--no-skills"), false, "session discovery emits no flag");
    assert.equal(run.meta.skills, undefined);
    assert.equal(run.meta.skillsSource, "session");
    assert.match(run.text, /discovery \(user catalog\) · source session/);

    const launchChoice = skill("launch");
    run = await spawn(runtime, { skills: [launchChoice] });
    assert.deepEqual(run.meta.skills, [launchChoice]);
    assert.equal(run.meta.skillsSource, "launch", "the launch option still wins over the session default");
});

test("reset restores the saved default and a saved choice reaches later launches", async () => {
    const saved = skill("saved-reset");
    saveConfig([saved]);
    const runtime = createRuntime();

    await openSettings([...keysToSkillsRow(), "\r", "\r", "\x1b"], runtime);
    let run = await spawn(runtime);
    assert.deepEqual(run.meta.skills, []);
    assert.equal(run.meta.skillsSource, "session");

    await runtime.commands.get("subagents").handler("reset", toolCtx());
    run = await spawn(runtime);
    assert.deepEqual(run.meta.skills, [saved]);
    assert.equal(run.meta.skillsSource, "config");

    await openSettings([...keysToSkillsRow(), "\r", "\r", "\x13", "\x1b"], runtime);
    assert.deepEqual(readSkills(), []);
    run = await spawn(runtime);
    assert.deepEqual(run.meta.skills, []);
    assert.equal(run.meta.skillsSource, "config");
    assert.equal(run.argv.includes("--no-skills"), true);
});

test("zero checked in the settings picker becomes No skill catalog and launches --no-skills", async () => {
    saveConfig([]);
    const runtime = createRuntime();

    const draftPage = await openSettings([
        ...keysToSkillsRow(),
        "\x1b[B", "\r", // open picker
        "\r", // zero checked -> apply
        "\x1b",
    ], runtime);
    assert.match(draftPage.render(100).join("\n"), /No skills checked\. Skill exposure set to No skill catalog/);
    const run = await spawn(runtime);
    assert.deepEqual(run.meta.skills, []);
    assert.equal(run.meta.skillsSource, "session");
    assert.equal(run.argv.includes("--no-skills"), true);
    assert.deepEqual(readSkills(), [], "zero checked is an explicit none, not an empty explicit draft");
});

test("Ctrl+S keeps a malformed saved defaultSkills until the user deliberately replaces it", async () => {
    writeFileSync(settingsPath, JSON.stringify({
        piBetterHarness: { subagents: { delegationMode: "adaptive", maxConcurrent: 4, defaultSkills: "review" } },
    }, null, 2));
    config.setConfigForTests(undefined);
    writeRoleDefinition();

    const runtime = createRuntime();
    const catalogView = await inspectRole(runtime);
    assert.equal(catalogView.skills.effective.mode, "error");
    assert.equal(catalogView.skills.effective.source, "global");
    assert.match(catalogView.skills.effective.error, /config defaultSkills must be an array/);
    assert.match(await agentsView(runtime), /Skills\s+inherit\s+global \(invalid\)/);
    await assert.rejects(
        () => runtime.tools.subagent_spawn.execute("tc-malformed-config", {
            prompt: "probe malformed config", tools: "read,bash", sandbox: false,
        }, null, null, toolCtx()),
        /Cannot read config defaultSkills: config defaultSkills must be an array/,
        "a malformed saved value is reported, not treated as discovery",
    );

    const page = await openSettings(["\x13", "\x1b"]);
    assert.match(page.render(100).join("\n"), /Config error:.*must be an array/);
    assert.equal(readSkills(), "review", "an unchanged invalid value is not replaced by discovery");

    await openSettings([...keysToSkillsRow(), "\r", "\x13", "\x1b"]);
    assert.deepEqual(readSkills(), [], "a deliberate choice is allowed to replace the invalid value");
});

test("catalog inspection and the /agents view follow the live session skill default", async () => {
    const saved = skill("catalog-saved");
    saveConfig([saved]);
    writeRoleDefinition();
    const runtime = createRuntime();

    await openSettings([...keysToSkillsRow(), "\r", "\r", "\x1b"], runtime);
    let view = await inspectRole(runtime);
    assert.deepEqual(view.skills.effective, { mode: "none", paths: [], source: "session" });
    assert.match(await agentsView(runtime), /Skills\s+inherit\s+session/);
    let run = await spawn(runtime);
    assert.deepEqual(run.meta.skills, []);
    assert.equal(run.meta.skillsSource, "session");
    assert.equal(run.argv.includes("--no-skills"), true);

    await openSettings([...keysToSkillsRow(), "\r", "\x1b"], runtime);
    view = await inspectRole(runtime);
    assert.deepEqual(view.skills.effective, { mode: "discovery", paths: [], source: "session" });
    assert.match(await agentsView(runtime), /Skills\s+inherit\s+session/);
    run = await spawn(runtime);
    assert.equal(run.argv.includes("--no-skills"), false);
    assert.equal(run.meta.skills, undefined);
    assert.equal(run.meta.skillsSource, "session");

    await runtime.commands.get("subagents").handler("reset", toolCtx());
    view = await inspectRole(runtime);
    assert.deepEqual(view.skills.effective, { mode: "explicit", paths: [saved], source: "global" });
    assert.match(await agentsView(runtime), /Skills\s+inherit\s+global/);
    run = await spawn(runtime);
    assert.deepEqual(run.meta.skills, [saved]);
    assert.equal(run.meta.skillsSource, "config");

    await openSettings([...keysToSkillsRow(), "\r", "\x13", "\x1b"], runtime);
    view = await inspectRole(runtime);
    assert.deepEqual(view.skills.effective, { mode: "discovery", paths: [], source: "discovery" });
    assert.match(await agentsView(runtime), /Skills\s+inherit\s+discovery/);
    run = await spawn(runtime);
    assert.equal(run.argv.includes("--no-skills"), false);
    assert.equal(run.meta.skillsSource, "default");
});

test("the settings picker uses loaded Pi skill metadata from the command context", async () => {
    promptSkills = [{
        name: "alpha", description: "Reviews changes.", filePath: "/skills/alpha/SKILL.md",
        baseDir: "/skills/alpha", sourceInfo: { source: "user" },
    }];
    const runtime = createRuntime();
    await openSettings([...keysToSkillsRow(), "\x1b[B", "\r"], runtime);
    const picker = renders.at(-1);
    assert.match(picker, /\[ \] alpha\s+Reviews changes\./);
    promptSkills = [];
});
