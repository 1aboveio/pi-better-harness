import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createSubagentSettingsPage } from "../settings-page.ts";

const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text, inverse: (text) => text };

function skillFile(name) {
    const dir = mkdtempSync(join(tmpdir(), `skill-page-${name}-`));
    const path = join(dir, "SKILL.md");
    writeFileSync(path, "---\nname: test\n---\n");
    return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function harness({ openAgents = true, skills } = {}) {
    const savedSkills = { mode: "inherit", paths: [], source: "default" };
    let current = {
        mode: "adaptive", maxConcurrent: 4, modeSource: "config", capSource: "config",
        defaultMode: "adaptive", defaultCap: 4,
        skillsMode: "inherit", skillsPaths: [], skillsSource: "default",
        ...skills,
    };
    let saved = 0;
    let closed = 0;
    let agents = 0;
    let saveFailure = false;
    const handlers = {
        get: () => current,
        changeMode(mode) { current = { ...current, mode, modeSource: "session" }; },
        changeCap(maxConcurrent) { current = { ...current, maxConcurrent, capSource: "session" }; },
        changeSkills(mode, paths) {
            if (mode !== "explicit" && paths.length > 0) throw new Error("Only Selected skills carries a path list.");
            if (mode === "explicit" && paths.some((path) => !path.startsWith("/"))) {
                throw new Error("Enter absolute skill paths so every child resolves the same files.");
            }
            current = { ...current, skillsMode: mode, skillsPaths: [...paths], skillsSource: "session" };
        },
        save() {
            if (saveFailure) return { ok: false, message: "Read-only config." };
            if (current.skillsMode === "explicit" && current.skillsPaths.length === 0) {
                return { ok: false, message: "Add at least one skill path, or choose No skill catalog to load none." };
            }
            saved++;
            savedSkills.mode = current.skillsMode;
            savedSkills.paths = [...current.skillsPaths];
            savedSkills.source = "config";
            current = {
                ...current, defaultMode: current.mode, defaultCap: current.maxConcurrent,
                modeSource: "config", capSource: "config", skillsSource: "config",
            };
            return { ok: true, message: "Subagent defaults saved." };
        },
        reset() {
            current = {
                ...current, mode: current.defaultMode, maxConcurrent: current.defaultCap,
                modeSource: "config", capSource: "config",
                skillsMode: savedSkills.mode, skillsPaths: [...savedSkills.paths], skillsSource: savedSkills.source,
            };
        },
    };
    if (openAgents) handlers.openAgents = () => { agents++; };
    const page = createSubagentSettingsPage(theme, handlers, () => {}, () => { closed++; });
    page.focused = true;
    return { page, settings: () => current, saved: () => saved, closed: () => closed, agents: () => agents, failSave: () => { saveFailure = true; } };
}

const LABELS = ["Delegation mode", "Concurrent subagents", "Skill exposure", "Agents", "Reset to defaults"];

function rowLabels(page) {
    return page.render(100).flatMap((line) => {
        const text = line.trimStart().replace(/^> /, "");
        const label = LABELS.find((name) => text.startsWith(name));
        return label ? [label] : [];
    });
}

function stripAnsi(text) {
    return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b_pi:[^\x07]*\x07/g, "");
}

function selectedLine(page) {
    return page.render(300).find((line) => stripAnsi(line).trimStart().startsWith("> "));
}

function selectedText(page) {
    const line = selectedLine(page);
    return line === undefined ? undefined : stripAnsi(line).trimStart().slice(2).trim();
}

function selectLabel(page, label) {
    for (let attempt = 0; attempt < 32; attempt++) page.handleInput("\x1b[A");
    for (let attempt = 0; attempt < 32; attempt++) {
        const text = selectedText(page) ?? "";
        if (text === label || text.startsWith(label + " ")) return text;
        page.handleInput("\x1b[B");
    }
    throw new Error(`could not select ${label}; selected ${selectedText(page)}`);
}

function selectPath(page, path) {
    for (let attempt = 0; attempt < 32; attempt++) page.handleInput("\x1b[A");
    for (let attempt = 0; attempt < 32; attempt++) {
        if (selectedText(page) === path) return;
        page.handleInput("\x1b[B");
    }
    throw new Error(`could not select path ${path}; selected ${selectedText(page)}`);
}

function typeAndSubmit(page, value) {
    page.handleInput("\x15");
    page.handleInput(value);
    page.handleInput("\r");
}

function enterCap(page, value) {
    page.handleInput("\r");
    typeAndSubmit(page, value);
}

function addSkill(page, path) {
    selectLabel(page, "+ Add a skill path");
    page.handleInput("\r");
    typeAndSubmit(page, path);
}

function selectSkillMode(page, mode) {
    selectLabel(page, "Skill exposure");
    for (let attempt = 0; attempt < 3; attempt++) {
        page.handleInput("\r");
        const text = selectedText(page) ?? "";
        if (mode === "inherit" && text.includes("Discover automatically")) return;
        if (mode === "none" && text.includes("No skill catalog")) return;
        if (mode === "explicit" && text.includes("Selected skills")) return;
    }
    throw new Error(`could not select skill mode ${mode}`);
}

test("settings page changes session mode and numeric cap, saves both, and resets", (t) => {
    const skill = skillFile("saved");
    t.after(skill.cleanup);
    const h = harness();
    h.page.handleInput("\r");
    assert.equal(h.settings().mode, "coordinator");
    assert.equal(h.saved(), 0, "editing applies only to the session");
    h.page.handleInput("\x1b[B");
    enterCap(h.page, "7");
    assert.equal(h.settings().maxConcurrent, 7);
    assert.equal(h.settings().capSource, "session");
    assert.equal(h.saved(), 0, "cap changes do not save defaults");
    selectSkillMode(h.page, "explicit");
    addSkill(h.page, skill.path);
    h.page.handleInput("\x13");
    assert.equal(h.saved(), 1);
    assert.equal(h.settings().defaultCap, 7);
    assert.equal(h.settings().defaultMode, "coordinator");
    assert.deepEqual(h.settings().skillsPaths, [skill.path]);
    selectLabel(h.page, "Concurrent subagents");
    enterCap(h.page, "2");
    selectLabel(h.page, "Skill exposure");
    h.page.handleInput("\r");
    selectLabel(h.page, "Reset to defaults");
    h.page.handleInput("\r");
    assert.equal(h.settings().maxConcurrent, 7);
    assert.equal(h.settings().skillsMode, "explicit");
    assert.deepEqual(h.settings().skillsPaths, [skill.path]);
    h.page.handleInput("\x1b");
    assert.equal(h.closed(), 1);
});

test("numeric cap validation and cancel leave the active cap unchanged", () => {
    for (const value of ["", "0", "-1", "1.5", "abc", "9007199254740992"]) {
        const h = harness();
        h.page.handleInput("\x1b[B");
        enterCap(h.page, value);
        assert.equal(h.settings().maxConcurrent, 4, value);
        assert.match(h.page.render(80).join("\n"), /positive whole number/);
        h.page.handleInput("\x1b");
        assert.equal(h.closed(), 0, "escape cancels editing before closing the page");
        enterCap(h.page, "5");
        assert.equal(h.settings().maxConcurrent, 5);
    }
});

test("single value column keeps current settings readable without showing saved values", () => {
    const h = harness();
    h.page.handleInput("\r");
    const wide = h.page.render(100).join("\n");
    assert.match(wide, /Delegation mode\s+coordinator/);
    assert.doesNotMatch(wide, /adaptive|Session\s+Default|Save as defaults/);
    const narrow = h.page.render(30).join("\n");
    assert.match(narrow, /Delegation mode\s+coordinator/);
    h.page.handleInput("\x1b[B");
    h.page.handleInput("\r");
    const editing = h.page.render(100);
    const capLine = editing.find((line) => line.includes("Concurrent subagents"));
    assert.ok(capLine.includes("4"), "the cap input stays in its table row");
});

test("failed save keeps session choices and narrow rendering fits the terminal", (t) => {
    const skill = skillFile("narrow");
    t.after(skill.cleanup);
    const h = harness({ skills: { skillsMode: "explicit", skillsPaths: [skill.path], skillsSource: "config" } });
    h.page.handleInput("\r");
    h.failSave();
    h.page.handleInput("\x13");
    assert.equal(h.saved(), 0);
    assert.equal(h.settings().mode, "coordinator");
    assert.equal(h.settings().modeSource, "session");
    assert.match(h.page.render(80).join("\n"), /Read-only config/);
    for (const width of [1, 10, 20, 40, 59, 60, 80, 120]) {
        for (const line of h.page.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
    }
    h.page.handleInput("\x1b[B");
    h.page.handleInput("\r");
    for (const line of h.page.render(20)) assert.ok(visibleWidth(line) <= 20);
});

test("Skill exposure cycles the three states, and Selected skills will not save empty", () => {
    const h = harness();
    selectLabel(h.page, "Skill exposure");
    assert.match(h.page.render(100).join("\n"), /Discover automatically/);
    assert.match(h.page.render(100).join("\n"), /Source: discovery default/);
    h.page.handleInput("\r");
    assert.equal(h.settings().skillsMode, "none");
    assert.match(h.page.render(100).join("\n"), /No skill catalog/);
    h.page.handleInput("\r");
    assert.equal(h.settings().skillsMode, "explicit");
    assert.match(h.page.render(100).join("\n"), /Selected skills/);
    assert.match(h.page.render(100).join("\n"), /\+ Add a skill path/);
    assert.match(h.page.render(100).join("\n"), /Source: this session/);
    h.page.handleInput("\x13");
    assert.equal(h.saved(), 0);
    assert.match(h.page.render(100).join("\n"), /Add at least one skill path/);
    assert.equal(h.settings().skillsMode, "explicit");
});

test("Add a skill path becomes an input, and Escape cancels without adding", () => {
    const h = harness();
    selectSkillMode(h.page, "explicit");
    selectLabel(h.page, "+ Add a skill path");
    h.page.handleInput("\r");
    const editing = h.page.render(100);
    assert.ok(editing.some((line) => stripAnsi(line).trim() === ">"), "the add row renders the input");
    assert.doesNotMatch(editing.join("\n"), /\+ Add a skill path/);
    h.page.handleInput("half-typed-path");
    h.page.handleInput("\x1b");
    assert.deepEqual(h.settings().skillsPaths, []);
    assert.equal(h.closed(), 0);
    assert.match(h.page.render(100).join("\n"), /Edit cancelled/);
});

test("a path is added, saved, and shown with its source", (t) => {
    const skill = skillFile("add");
    t.after(skill.cleanup);
    const h = harness();
    selectSkillMode(h.page, "explicit");
    addSkill(h.page, skill.path);
    assert.deepEqual(h.settings().skillsPaths, [skill.path]);
    assert.equal(h.settings().skillsSource, "session");
    assert.match(h.page.render(240).join("\n"), new RegExp(skill.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    h.page.handleInput("\x13");
    assert.equal(h.saved(), 1);
    assert.deepEqual(h.settings().skillsPaths, [skill.path]);
    assert.match(h.page.render(100).join("\n"), /Source: config defaultSkills/);
});

test("invalid path input is reported and kept until cancel, without discarding the list", (t) => {
    const skill = skillFile("validation");
    t.after(skill.cleanup);
    const h = harness();
    selectSkillMode(h.page, "explicit");
    addSkill(h.page, skill.path);
    const before = [...h.settings().skillsPaths];

    selectLabel(h.page, "+ Add a skill path");
    h.page.handleInput("\r");
    typeAndSubmit(h.page, "relative/SKILL.md");
    assert.match(h.page.render(100).join("\n"), /absolute path/);
    assert.deepEqual(h.settings().skillsPaths, before);
    h.page.handleInput("\x1b");
    assert.equal(h.closed(), 0, "escape cancels the unfinished path, not the page");
    assert.match(h.page.render(100).join("\n"), /Edit cancelled/);
    assert.deepEqual(h.settings().skillsPaths, before);

    selectLabel(h.page, "+ Add a skill path");
    h.page.handleInput("\r");
    typeAndSubmit(h.page, join(tmpdir(), "missing-skill-page-path", "SKILL.md"));
    assert.match(h.page.render(100).join("\n"), /No file or directory/);
    assert.deepEqual(h.settings().skillsPaths, before);
    h.page.handleInput("\x1b");

    selectLabel(h.page, "+ Add a skill path");
    h.page.handleInput("\r");
    typeAndSubmit(h.page, skill.path);
    assert.match(h.page.render(100).join("\n"), /already listed/);
    assert.deepEqual(h.settings().skillsPaths, before);
    h.page.handleInput("\x1b");

    selectLabel(h.page, "+ Add a skill path");
    h.page.handleInput("\r");
    typeAndSubmit(h.page, "");
    assert.match(h.page.render(100).join("\n"), /Enter an absolute path/);
    assert.deepEqual(h.settings().skillsPaths, before);
});

test("a path can be edited and removed without touching the saved default until save", (t) => {
    const first = skillFile("edit-a");
    const second = skillFile("edit-b");
    t.after(first.cleanup);
    t.after(second.cleanup);
    const h = harness();
    selectSkillMode(h.page, "explicit");
    addSkill(h.page, first.path);
    addSkill(h.page, second.path);
    assert.deepEqual(h.settings().skillsPaths, [first.path, second.path]);

    selectPath(h.page, second.path);
    h.page.handleInput("\r");
    typeAndSubmit(h.page, first.path);
    assert.match(h.page.render(100).join("\n"), /already listed/);
    assert.deepEqual(h.settings().skillsPaths, [first.path, second.path]);
    h.page.handleInput("\x1b");

    selectPath(h.page, second.path);
    h.page.handleInput("\r");
    typeAndSubmit(h.page, first.path.replace(/SKILL\.md$/, "OTHER.md"));
    assert.deepEqual(h.settings().skillsPaths, [first.path, second.path], "a missing replacement is not applied");
    h.page.handleInput("\x1b");

    selectPath(h.page, second.path);
    h.page.handleInput("\r");
    typeAndSubmit(h.page, second.path);
    assert.deepEqual(h.settings().skillsPaths, [first.path, second.path], "an unchanged path is still valid");

    selectPath(h.page, second.path);
    h.page.handleInput("x");
    assert.deepEqual(h.settings().skillsPaths, [first.path]);
    selectSkillMode(h.page, "none");
    selectSkillMode(h.page, "explicit");
    assert.deepEqual(h.settings().skillsPaths, [first.path], "a removed path is not resurrected by mode cycling");
    h.page.handleInput("\x13");
    assert.deepEqual(h.settings().skillsPaths, [first.path]);
});

test("switching away from Selected skills and back keeps the draft list", (t) => {
    const skill = skillFile("remember");
    t.after(skill.cleanup);
    const h = harness();
    selectSkillMode(h.page, "explicit");
    addSkill(h.page, skill.path);
    selectSkillMode(h.page, "none");
    assert.deepEqual(h.settings().skillsPaths, []);
    selectSkillMode(h.page, "explicit");
    assert.deepEqual(h.settings().skillsPaths, [skill.path]);
});

test("saving a non-explicit choice forgets an abandoned path draft", (t) => {
    const skill = skillFile("forget");
    t.after(skill.cleanup);
    const h = harness();
    selectSkillMode(h.page, "explicit");
    addSkill(h.page, skill.path);
    selectSkillMode(h.page, "none");
    h.page.handleInput("\x13");
    assert.equal(h.saved(), 1);
    selectSkillMode(h.page, "explicit");
    assert.deepEqual(h.settings().skillsPaths, [], "the saved none default does not resurrect the old draft");
});

test("reset restores the saved skill default together with mode and cap", (t) => {
    const skill = skillFile("reset");
    t.after(skill.cleanup);
    const h = harness();
    selectSkillMode(h.page, "explicit");
    addSkill(h.page, skill.path);
    h.page.handleInput("\x13");
    selectSkillMode(h.page, "none");
    assert.equal(h.settings().skillsMode, "none");
    selectLabel(h.page, "Reset to defaults");
    h.page.handleInput("\r");
    assert.equal(h.settings().skillsMode, "explicit");
    assert.deepEqual(h.settings().skillsPaths, [skill.path]);
    assert.equal(h.settings().skillsSource, "config");
});

test("Agents row opens the catalog action without touching settings", () => {
    const h = harness();
    h.page.handleInput("\r");
    h.page.handleInput("\x13");
    const before = h.settings();
    selectLabel(h.page, "Agents");
    h.page.handleInput("\r");
    assert.equal(h.agents(), 1);
    assert.deepEqual(h.settings(), before, "opening Agents changes no settings");
    assert.equal(h.saved(), 1, "opening Agents saves nothing");
    assert.equal(h.closed(), 0, "the page does not close itself; its owner decides what follows");
    h.page.handleInput("\x1b");
    assert.equal(h.closed(), 1, "Escape still closes once");
});

test("Agents sits before Reset to defaults and reset still restores saved defaults", () => {
    const h = harness();
    assert.deepEqual(rowLabels(h.page), LABELS);
    h.page.handleInput("\r");
    selectLabel(h.page, "Agents");
    h.page.handleInput("\r");
    assert.equal(h.agents(), 1);
    assert.equal(h.settings().mode, "coordinator", "Agents is not the reset action");
    selectLabel(h.page, "Reset to defaults");
    h.page.handleInput("\r");
    assert.equal(h.settings().mode, "adaptive");
    assert.equal(h.agents(), 1);
});

test("Agents row stays inert when its handler is not provided", () => {
    const h = harness({ openAgents: false });
    const before = h.settings();
    selectLabel(h.page, "Agents");
    h.page.handleInput("\r");
    assert.deepEqual(h.settings(), before);
    assert.equal(h.saved(), 0);
    assert.equal(h.closed(), 0);
});

test("selected paths render inside narrow and normal widths and name their source", (t) => {
    const skill = skillFile("widths");
    t.after(skill.cleanup);
    const longPath = join(skill.path, "..", "a-very-long-directory-name", "another-long-segment", "SKILL.md");
    const h = harness({
        skills: { skillsMode: "explicit", skillsPaths: [longPath, skill.path], skillsSource: "config" },
    });
    for (const width of [1, 10, 20, 39, 40, 60, 80, 120]) {
        const lines = h.page.render(width);
        for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${JSON.stringify(line)}`);
    }
    assert.match(h.page.render(120).join("\n"), /Skill exposure/);
    assert.match(h.page.render(120).join("\n"), /Source: config defaultSkills/);
    selectPath(h.page, skill.path);
    for (const width of [1, 20, 40, 100]) {
        for (const line of h.page.render(width)) assert.ok(visibleWidth(line) <= width);
    }
});
