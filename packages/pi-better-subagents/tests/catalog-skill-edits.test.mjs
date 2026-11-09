import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { visibleWidth } from "@earendil-works/pi-tui";
import { executeAgentsCommand } from "../agent-commands.ts";
import { presentCatalog } from "../agent-inspection.ts";
import { inspectCatalog } from "../catalog-resolver.ts";
import { loadCatalog } from "../catalog-store.ts";
import {
    applySkillExposure,
    definitionSkillPreference,
    parseDefinition,
    serializeDefinition,
} from "../catalog-schema.ts";
import { setConfigForTests } from "../config.ts";
import { resolveSkillExposure, skillLaunchArgs } from "../skills.ts";
import { skillsOriginLabel, skillsValueLabel } from "../catalog-ui.ts";

const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text, inverse: (text) => text };
const ROLE_SKILL = "/skills/role/SKILL.md";
const AGENT_SKILL = "/skills/agent/SKILL.md";
const GLOBAL_SKILL = "/skills/global/SKILL.md";

const roleMarkdown = (skills) => `---\nschema: pi-agent/v1\nkind: role\nid: role.work\nname: Worker\ndescription: Does the work.\ndefaults:\n  model: openai/alpha\n  effort: medium\n  tier: balanced${skills === undefined ? "" : `\n  skills:${skills.length === 0 ? " []" : `\n${skills.map((path) => `    - ${path}`).join("\n")}`}`}\n---\nRole instructions.\n`;
const agentMarkdown = (skills) => `---\nschema: pi-agent/v1\nkind: agent\nid: agent.worker\nname: Named Worker\nroleId: role.work\ninstructions:\n  mode: add\n${skills === undefined ? "" : skills === null ? "overrides:\n  skills: null\n" : `overrides:\n  skills:${skills.length === 0 ? " []" : `\n${skills.map((path) => `    - ${path}`).join("\n")}`}\n`}---\nAgent instructions.\n`;

function fixture(t, options = {}) {
    const root = mkdtempSync(join(tmpdir(), "catalog-skill-edits-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const loc = {
        cwd: join(root, "project"),
        userRoot: join(root, "user"),
        bundledRoot: join(root, "bundled"),
        projectTrusted: options.projectTrusted ?? true,
    };
    mkdirSync(loc.cwd);
    mkdirSync(loc.bundledRoot);
    mkdirSync(join(loc.userRoot, "agents", "agents"), { recursive: true });
    mkdirSync(join(loc.userRoot, "agents", "roles"), { recursive: true });
    writeFileSync(join(loc.bundledRoot, "role.work.md"), roleMarkdown(options.roleSkills));
    const agentPath = join(loc.userRoot, "agents", "agents", "agent.worker.md");
    if (options.agentSkills !== "project") writeFileSync(agentPath, agentMarkdown(options.agentSkills));
    if (options.agentSkills === "project") {
        mkdirSync(join(loc.cwd, ".pi", "agents", "agents"), { recursive: true });
        writeFileSync(join(loc.cwd, ".pi", "agents", "agents", "agent.worker.md"), agentMarkdown(options.agentSkills === "project" ? options.projectAgentSkills : undefined));
    }
    setConfigForTests(options.config ?? {});
    t.after(() => setConfigForTests(undefined));
    let component;
    const ui = {
        notify() {},
        async custom(factory) { component = factory({ requestRender() {} }, theme, {}, () => {}); },
    };
    const host = { cwd: loc.cwd, hasUI: true, mode: "tui", isProjectTrusted: () => loc.projectTrusted, ui };
    const sessionSettings = { snapshot: () => ({}), change() {}, reset() {} };
    const deps = () => ({ ...loc, sessionSettings });
    const open = async (id = "agent.worker") => {
        await executeAgentsCommand(`show ${id}`, host, deps());
        assert.ok(component, "the TUI component must open");
        component.render(100);
        return component;
    };
    return { root, loc, agentPath, open, deps, get component() { return component; } };
}

/** Definition file parsed from disk, independent of the in-memory catalog. */
function skillFile(t, name) {
    const dir = mkdtempSync(join(tmpdir(), `catalog-skill-${name}-`));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "SKILL.md");
    writeFileSync(path, "---\nname: selected\n---\n");
    return path;
}

function saved(path) {
    const parsed = parseDefinition(readFileSync(path, "utf8"));
    assert.equal(parsed.ok, true, JSON.stringify(parsed.diagnostics));
    return parsed.definition;
}

function viewOf(loc, id) {
    return presentCatalog(loadCatalog(loc)).entries.find((entry) => entry.id === id);
}

function chooseSkills(component, choice) {
    component.handleInput("\x1b[B");
    component.handleInput("\x1b[B");
    component.handleInput("\r");
    const screen = component.render(100).join("\n");
    assert.match(screen, /Agents \/ skills/);
    if (choice === "none") component.handleInput("\x1b[B");
    if (choice === "selected") { component.handleInput("\x1b[B"); component.handleInput("\x1b[B"); }
    component.handleInput("\r");
    return screen;
}

function stripAnsi(text) {
    return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b_pi:[^\x07]*\x07/g, "");
}

function selectedPickerText(component) {
    return stripAnsi(component.render(160).join("\n")).split("\n")
        .find((line) => line.trimStart().startsWith("> "))?.trimStart().slice(2).trim();
}

function selectPickerEntry(component, text) {
    for (let attempt = 0; attempt < 48; attempt++) component.handleInput("\x1b[A");
    for (let attempt = 0; attempt < 64; attempt++) {
        if ((selectedPickerText(component) ?? "").includes(text)) return;
        component.handleInput("\x1b[B");
    }
    throw new Error(`could not select ${text}; selected ${selectedPickerText(component)}`);
}

function addPickerPath(component, path) {
    selectPickerEntry(component, "Add skill path");
    component.handleInput("\r");
    component.handleInput(path);
    component.handleInput("\r");
}

function applyPicker(component) {
    selectPickerEntry(component, "Apply selection");
    component.handleInput("\r");
}

function type(component, text) {
    for (const character of text) component.handleInput(character);
}

describe("catalog skill exposure edits", () => {
    it("saves none for a named agent, survives a fresh reload, and resolves --no-skills instead of the global default", async (t) => {
        const fx = fixture(t, { roleSkills: undefined, config: { defaultSkills: [GLOBAL_SKILL] } });
        const component = await fx.open();
        assert.match(component.render(100).join("\n"), /Skills\s+inherit\s+global/);

        chooseSkills(component, "none");
        assert.match(component.render(100).join("\n"), /Skills\s+no skill catalog\s+override/);
        assert.match(component.render(100).join("\n"), /Skills saved \(user\): agent\.worker · none/);

        const definition = saved(fx.agentPath);
        assert.equal(definition.kind, "agent");
        assert.deepEqual(definition.overrides.skills, [], "an empty array is the explicit none value");
        assert.equal(definition.overrides.model, undefined, "the edit does not backfill other overrides");

        const fresh = loadCatalog(fx.loc);
        const agent = inspectCatalog(fresh, "agent.worker");
        assert.deepEqual(agent.skills, { value: [], source: "agent-override", explicit: true });

        const exposure = resolveSkillExposure({
            catalog: agent.skills?.value,
            configured: [GLOBAL_SKILL],
            cwd: fx.loc.cwd,
        });
        assert.deepEqual(exposure, { mode: "none", paths: [], source: "catalog" }, "[] must not fall through to the global default");
        assert.deepEqual(skillLaunchArgs(exposure), ["--no-skills"]);

        const view = viewOf(fx.loc, "agent.worker");
        assert.equal(view.skills.effective.mode, "none");
        assert.equal(view.skills.effective.source, "agent-override");
        assert.equal(skillsValueLabel(view.skills), "no skill catalog");
        assert.equal(skillsOriginLabel(view.skills, "agent"), "override");

        // Inherit deletes the override again, so the global default applies.
        component.handleInput("\r");
        component.handleInput("\x1b[A");
        component.handleInput("\r");
        assert.equal(saved(fx.agentPath).overrides.skills, undefined, "inherit removes the key instead of writing null");
        const inherited = viewOf(fx.loc, "agent.worker");
        assert.equal(inherited.skills.source, "absent");
        assert.equal(inherited.skills.effective.source, "global");
        assert.deepEqual(inherited.skills.effective.paths, [GLOBAL_SKILL]);
        assert.deepEqual(resolveSkillExposure({ catalog: inherited.skills.value, configured: [GLOBAL_SKILL], cwd: fx.loc.cwd }), {
            mode: "explicit",
            paths: [GLOBAL_SKILL],
            source: "config",
        });
    });

    it("starts on the definition's own choice and restores the base role's list when an override is removed", async (t) => {
        const fx = fixture(t, { roleSkills: [ROLE_SKILL], config: {} });
        const agentSkill = skillFile(t, "agent-selected");
        const component = await fx.open();
        const inherited = viewOf(fx.loc, "agent.worker");
        assert.deepEqual(inherited.skills.effective, { mode: "explicit", paths: [ROLE_SKILL], source: "role-default" });
        assert.equal(skillsOriginLabel(inherited.skills, "agent"), "inherited");

        chooseSkills(component, "selected");
        assert.match(component.render(100).join("\n"), /Selected skills/);
        addPickerPath(component, agentSkill);
        applyPicker(component);

        assert.deepEqual(saved(fx.agentPath).overrides.skills, [agentSkill]);
        const overridden = viewOf(fx.loc, "agent.worker");
        assert.equal(overridden.skills.source, "agent-override");
        assert.deepEqual(overridden.skills.effective.paths, [agentSkill]);
        assert.match(component.render(100).join("\n"), /Skills\s+1 selected.*override/);

        // Reopen: the picker must start on "Selected skills", the definition's own choice.
        component.handleInput("\r");
        assert.match(component.render(100).join("\n"), /→ Selected skills/);
        component.handleInput("\x1b[A");
        component.handleInput("\x1b[A");
        component.handleInput("\r");

        assert.equal(saved(fx.agentPath).overrides.skills, undefined);
        const restored = viewOf(fx.loc, "agent.worker");
        assert.deepEqual(restored.skills.effective, { mode: "explicit", paths: [ROLE_SKILL], source: "role-default" });
        assert.deepEqual(resolveSkillExposure({ catalog: restored.skills.value, configured: [], cwd: fx.loc.cwd }), {
            mode: "explicit",
            paths: [ROLE_SKILL],
            source: "catalog",
        });
    });

    it("zero checked becomes none while invalid manual paths do not write", async (t) => {
        const fx = fixture(t, { roleSkills: undefined, config: {} });
        const original = readFileSync(fx.agentPath, "utf8");
        const component = await fx.open();
        chooseSkills(component, "selected");
        assert.match(component.render(140).join("\n"), /Selected skills/);

        addPickerPath(component, "skills/relative/SKILL.md");
        assert.match(component.render(140).join("\n"), /Enter an absolute path/);
        assert.equal(readFileSync(fx.agentPath, "utf8"), original);
        component.handleInput("\x1b");

        applyPicker(component);
        assert.match(component.render(140).join("\n"), /No skills checked\. Skill exposure set to No skill catalog/);
        assert.deepEqual(saved(fx.agentPath).overrides.skills, [], "zero checked saves the explicit none value");

        assert.throws(
            () => applySkillExposure(saved(fx.agentPath), { mode: "explicit", paths: [] }),
            /at least one absolute path/,
            "the save helper still refuses an ambiguous empty explicit selection",
        );
        assert.throws(
            () => applySkillExposure(saved(fx.agentPath), { mode: "explicit", paths: ["relative/SKILL.md"] }),
            /must be absolute/,
        );
        assert.deepEqual(definitionSkillPreference(applySkillExposure(saved(fx.agentPath), { mode: "none" })), []);
        assert.equal(definitionSkillPreference(applySkillExposure(saved(fx.agentPath), { mode: "inherit" })), undefined);
    });

    it("edits a bundled role through a personal definition and leaves the bundled prompt byte-identical", async (t) => {
        const fx = fixture(t, { config: { defaultSkills: [GLOBAL_SKILL] } });
        const bundledPath = join(fx.loc.bundledRoot, "role.work.md");
        const bundledBefore = readFileSync(bundledPath, "utf8");
        const component = await fx.open("role.work");
        assert.match(component.render(100).join("\n"), /Skills\s+inherit\s+global/);

        chooseSkills(component, "none");
        assert.match(component.render(100).join("\n"), /Personal definition saved \(user\): role\.work · none/);
        const userPath = join(fx.loc.userRoot, "agents", "roles", "role.work.md");
        const definition = saved(userPath);
        assert.equal(definition.kind, "role");
        assert.equal(definition.body.trim(), "Role instructions.");
        assert.deepEqual(definition.defaults, { model: "openai/alpha", effort: "medium", tier: "balanced", skills: [] });
        assert.equal(readFileSync(bundledPath, "utf8"), bundledBefore, "the bundled file is immutable");

        const fresh = loadCatalog(fx.loc);
        assert.equal(fresh.roles.get("role.work").scope, "user");
        const role = inspectCatalog(fresh, "role.work");
        assert.deepEqual(role.skills, { value: [], source: "role-default", explicit: false });
        assert.deepEqual(skillLaunchArgs(resolveSkillExposure({ catalog: role.skills?.value, configured: [GLOBAL_SKILL], cwd: fx.loc.cwd })), ["--no-skills"]);
        assert.equal(readFileSync(bundledPath, "utf8"), bundledBefore);
    });

    it("shows agent override, role, global, and discovery sources accurately", async (t) => {
        const fx = fixture(t, { roleSkills: [ROLE_SKILL], config: {} });
        let agent = viewOf(fx.loc, "agent.worker");
        assert.equal(agent.skills.source, "role-default");
        assert.equal(agent.skills.effective.source, "role-default");
        assert.equal(agent.skills.global, null);
        assert.equal(skillsOriginLabel(agent.skills, "agent"), "inherited");

        // A definition with no list of its own falls through to the global default.
        const globalFx = fixture(t, { config: { defaultSkills: [GLOBAL_SKILL] } });
        const role = viewOf(globalFx.loc, "role.work");
        assert.deepEqual(role.skills.effective, { mode: "explicit", paths: [GLOBAL_SKILL], source: "global" });
        assert.equal(skillsOriginLabel(role.skills, "role"), "global");

        setConfigForTests({ defaultSkills: [] });
        assert.equal(viewOf(globalFx.loc, "role.work").skills.effective.mode, "none");
        assert.equal(viewOf(globalFx.loc, "role.work").skills.effective.source, "global");

        setConfigForTests({});
        const discovery = viewOf(globalFx.loc, "role.work");
        assert.deepEqual(discovery.skills.effective, { mode: "discovery", paths: [], source: "discovery" });
        assert.equal(skillsOriginLabel(discovery.skills, "role"), "discovery");
    });

    it("reports an explicit null as suppression that still falls through to the global default", async (t) => {
        const fx = fixture(t, { roleSkills: [ROLE_SKILL], agentSkills: null, config: { defaultSkills: [GLOBAL_SKILL] } });
        const agent = viewOf(fx.loc, "agent.worker");
        assert.deepEqual(agent.skills, {
            value: null,
            source: "agent-override",
            explicit: true,
            inherited: false,
            global: [GLOBAL_SKILL],
            effective: { mode: "explicit", paths: [GLOBAL_SKILL], source: "global" },
        });
        assert.equal(skillsValueLabel(agent.skills), "inherit (role list suppressed)");
        assert.equal(skillsOriginLabel(agent.skills, "agent"), "override → global");
    });

    it("refuses a stale screen instead of overwriting an externally changed definition", async (t) => {
        const fx = fixture(t, { config: {} });
        const component = await fx.open();
        const external = readFileSync(fx.agentPath, "utf8").replace("Agent instructions.", "Externally edited instructions.");
        writeFileSync(fx.agentPath, external);
        chooseSkills(component, "none");
        assert.match(component.render(140).join("\n"), /changed since this screen opened/);
        assert.equal(readFileSync(fx.agentPath, "utf8"), external);
    });

    it("writes a project-owned definition back to project scope", async (t) => {
        const fx = fixture(t, { agentSkills: "project", projectAgentSkills: undefined, config: {} });
        const projectPath = join(fx.loc.cwd, ".pi", "agents", "agents", "agent.worker.md");
        const component = await fx.open();
        chooseSkills(component, "none");
        assert.deepEqual(saved(projectPath).overrides.skills, []);
        assert.match(component.render(140).join("\n"), /Skills saved \(project\): agent\.worker · none/);
        assert.equal(loadCatalog(fx.loc).agents.get("agent.worker").scope, "project");
    });

    it("keeps every skill row inside narrow terminal widths", async (t) => {
        const fx = fixture(t, { roleSkills: [ROLE_SKILL], config: { defaultSkills: [GLOBAL_SKILL] } });
        const component = await fx.open();
        for (const width of [24, 42, 60]) {
            const lines = component.render(width);
            assert.ok(lines.every((line) => visibleWidth(line) <= width), `render at ${width} columns`);
            assert.match(lines.join("\n"), /Skills/);
        }
        component.handleInput("\x1b[B");
        component.handleInput("\x1b[B");
        component.handleInput("\r");
        for (const width of [24, 42, 60]) {
            assert.ok(component.render(width).every((line) => visibleWidth(line) <= width), `picker at ${width} columns`);
        }
    });
});

describe("definition skill edits stay surgical", () => {
    it("preserves the prompt, description, restrictions, and sibling preferences", () => {
        const parsed = parseDefinition(roleMarkdown([ROLE_SKILL]));
        assert.equal(parsed.ok, true);
        const next = applySkillExposure(parsed.definition, { mode: "explicit", paths: [AGENT_SKILL] });
        assert.deepEqual(next.defaults, { ...parsed.definition.defaults, skills: [AGENT_SKILL] });
        assert.equal(next.body, parsed.definition.body);
        assert.equal(next.description, parsed.definition.description);
        assert.deepEqual(next.executionRestrictions, parsed.definition.executionRestrictions);

        const inherited = applySkillExposure(parsed.definition, { mode: "inherit" });
        assert.equal(Object.hasOwn(inherited.defaults, "skills"), false);
        assert.deepEqual(inherited.defaults, { model: "openai/alpha", effort: "medium", tier: "balanced" });

        const markdown = serializeDefinition(applySkillExposure(parsed.definition, { mode: "none" })).markdown;
        assert.match(markdown, /skills: \[\]/);
        assert.deepEqual(parseDefinition(markdown).definition.defaults.skills, [], "[] survives the save round trip");
    });
});
