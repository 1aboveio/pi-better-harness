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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";

const root = mkdtempSync(join(tmpdir(), "skill-settings-tui-"));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;

const { default: extension } = await import("../index.ts");
const config = await import("../config.ts");
const { resolveSkillExposure, skillLaunchArgs } = await import("../skills.ts");

const settingsPath = join(root, "settings.json");
config.setConfigPathForTests(settingsPath);
config.setConfigForTests(undefined);

const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text, inverse: (text) => text };
const pages = [];
const keyBatches = [];

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
                    if (!settled) page.handleInput("\x1b");
                });
            },
        },
    };
}

function keysToSkillsRow() {
    return ["\x1b[B", "\x1b[B"];
}

async function openSettings(keys) {
    keyBatches.push(keys);
    const events = createEventBus();
    const registrations = [];
    events.on("harness-settings:register", (item) => registrations.push(item));
    const commands = new Map();
    extension({
        events,
        registerTool() {},
        registerCommand(name, command) { commands.set(name, command); },
        on() {},
        appendEntry() {},
        sendMessage() { assert.fail("settings must not send messages"); },
        sendUserMessage() { assert.fail("settings must not send user messages"); },
    });
    const contribution = registrations.find((item) => item.id === "subagents");
    assert.equal(contribution.command, "/subagents settings", "the harness-settings link points at this page");
    await contribution.open(ctx());
    return pages.at(-1);
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
        "\r", // discovery -> none
        "\r", // none -> selected
        "\x1b[B", // selected skills -> add path
        "\r",
        skill,
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
        "\r", // none -> selected
        "\x1b[B",
        "\r",
        join(root, "skills", "review", "SKILL.md"),
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
