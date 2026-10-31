import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createAgentSessionSettings, saveAgentSessionDefaults } from "../agent-session-settings.ts";
import { executeAgentsCommand, executeAgentsCommandContext } from "../agent-commands.ts";
import { agentsCatalogTool } from "../agents-catalog-tool.ts";
import { createLaunchEnricher, loadLaunchSnapshot, noteCatalogHost, prepareCatalogJob } from "../catalog-runtime.ts";
import { loadCatalog, saveDefinition } from "../catalog-store.ts";
import { inspectCatalog } from "../catalog-resolver.ts";
import { parseDefinition, serializeDefinition } from "../catalog-schema.ts";
import { readCatalogPreferences, writeCatalogPreferences } from "../catalog-preferences.ts";

const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text, inverse: (text) => text };
const Type = { Object: (x) => x, String: (x) => x, Optional: (x) => x };
const role = (defaults = {}) => ({ schema: "pi-agent/v1", kind: "role", id: "role.work", name: "Worker", defaults: { model: "openai/alpha", effort: "medium", tier: "balanced", ...defaults }, executionRestrictions: [], body: "Role instructions." });
const agent = (overrides = {}) => ({ schema: "pi-agent/v1", kind: "agent", id: "agent.worker", name: "Named Worker", roleId: "role.work", instructionMode: "add", overrides, executionRestrictions: [], provenance: { origin: "imported", format: "codex-toml", sourceRef: "source.toml" }, body: "Named instructions." });

function fixture(t, scope = "user", definition = agent(), options = {}) {
    const root = mkdtempSync(join(tmpdir(), "agent-session-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const loc = { cwd: join(root, "project"), userRoot: join(root, "user"), bundledRoot: join(root, "bundled"), projectTrusted: true };
    mkdirSync(loc.cwd);
    mkdirSync(loc.bundledRoot);
    const bundledPath = join(loc.bundledRoot, "worker.md");
    writeFileSync(bundledPath, serializeDefinition(role()).markdown);
    let saved;
    if (scope !== "bundled") {
        saved = saveDefinition({ ...loc, definition, scope });
        assert.equal(saved.ok, true, JSON.stringify(saved.diagnostics));
    }
    let sessionManager = SessionManager.create(loc.cwd, join(root, "sessions"));
    const base = sessionManager.appendMessage({ role: "user", content: "Test catalog settings.", timestamp: 1 });
    sessionManager.appendMessage({ role: "assistant", content: [], provider: "openai", model: "alpha", api: "openai-responses", stopReason: "stop", timestamp: 2 });
    const pi = { appendEntry: (type, data) => sessionManager.appendCustomEntry(type, data) };
    let settings = createAgentSessionSettings(pi);
    const restore = () => settings.restore({ sessionManager });
    restore();
    const registry = { getAvailable: () => ["alpha", "beta", "gamma"].map((id) => ({ provider: "openai", id, reasoning: true })) };
    const host = () => ({ ...loc, registry, configuredDefaultModel: null, sessionSettings: settings.snapshot(), getSessionSettings: () => settings.snapshot() });
    let component;
    const ui = {
        select: async () => undefined, confirm: async () => false, input: async () => undefined, editor: async () => undefined, notify() {},
        custom: async (factory) => { component = factory({ requestRender() {} }, theme, {}, () => {}); },
    };
    const commandHost = { cwd: loc.cwd, hasUI: true, mode: "tui", isProjectTrusted: () => loc.projectTrusted, scopedModels: options.scopedModels, ui };
    const deps = () => ({ ...loc, sessionSettings: settings, editableModels: () => registry.getAvailable().map((m) => `${m.provider}/${m.id}`), enrich: createLaunchEnricher() });
    return {
        loc, bundledPath, saved, base, pi, restore, host, registry,
        get settings() { return settings; },
        get session() { return sessionManager; },
        set session(value) { sessionManager = value; restore(); },
        reload() { sessionManager = SessionManager.open(sessionManager.getSessionFile()); settings = createAgentSessionSettings(pi); restore(); },
        async open(id = definition.id) {
            noteCatalogHost(host());
            const result = await executeAgentsCommand(`show ${id}`, commandHost, deps());
            return { result, component };
        },
        /** Open through the slash-command entry point so `ctx.scopedModels` is read. */
        async openFromContext(id = definition.id, context = {}) {
            noteCatalogHost(host());
            const result = await executeAgentsCommandContext(`show ${id}`, {
                cwd: loc.cwd, hasUI: true, mode: "tui", isProjectTrusted: () => loc.projectTrusted, ui,
                ...context,
            }, deps());
            return { result, component };
        },
        async command(args, headless = false) {
            noteCatalogHost(host());
            return executeAgentsCommand(args, { ...commandHost, ...(headless ? { hasUI: false, mode: "json" } : {}) }, deps());
        },
        discovery() {
            noteCatalogHost(host());
            return agentsCatalogTool(Type, { ...deps(), resolveHost: () => host() });
        },
    };
}

function editModel(component, label) {
    component.handleInput("\r");
    component.handleInput(label);
    component.handleInput("\r");
}

describe("branch-local agent model and effort", () => {
    it("a model-only save preserves an effort update that arrives while acquiring the lock", async t => {
        const fx = fixture(t, "bundled", role());
        mkdirSync(fx.loc.userRoot, { recursive: true });
        const root = join(fx.loc.userRoot, "agents");
        writeCatalogPreferences(root, "role.work", { effort: "low" });
        fx.settings.change("role.work", "model", "openai/beta");
        const { component } = await fx.open("role.work");
        const lockfile = createRequire(import.meta.url)("proper-lockfile");
        const original = lockfile.lockSync;
        let intercepted = false;
        lockfile.lockSync = (...args) => {
            if (!intercepted) {
                intercepted = true;
                writeCatalogPreferences(root, "role.work", current => ({ ...current, effort: "max" }));
            }
            return original(...args);
        };
        try {
            component.handleInput("\x13");
            assert.deepEqual(readCatalogPreferences(root).settings["role.work"], { model: "openai/beta", effort: "max" });
        } finally { lockfile.lockSync = original; }
    });

    it("Settings reset restores bundled model/effort without changing the role prompt", async t => {
        const fx = fixture(t, "user", { ...role({ model: "openai/gamma", effort: "high" }), body: "My custom role prompt." });
        const original = readFileSync(fx.saved.path, "utf8");
        fx.settings.change("role.work", "model", "openai/beta");
        fx.settings.change("role.work", "effort", "max");
        const { component } = await fx.open("role.work");
        component.render(80);
        component.handleInput("\x1b[B"); component.render(80);
        component.handleInput("\x1b[B"); component.render(80);
        component.handleInput("\r");
        assert.equal(readFileSync(fx.saved.path, "utf8"), original);
        assert.equal(fx.settings.snapshot()["role.work"], undefined);
        const inspected = inspectCatalog(loadCatalog(fx.loc), "role.work");
        assert.equal(inspected.fields.model.value, "openai/alpha");
        assert.equal(inspected.fields.effort.value, "medium");
        assert.equal(inspected.instructions.trim(), "My custom role prompt.");
        const settings = component.render(100).join("\n");
        assert.match(settings, /Model\s+openai\/alpha\s+bundled/);
        assert.match(settings, /Effort\s+medium\s+bundled/);
        assert.doesNotMatch(settings, /user config/);
        writeFileSync(fx.bundledPath, serializeDefinition(role({ model: "openai/beta", effort: "low" })).markdown);
        const next = inspectCatalog(loadCatalog(fx.loc), "role.work");
        assert.equal(next.fields.model.value, "openai/beta", "reset follows a later bundled model update");
        assert.equal(next.fields.effort.value, "low");
        assert.equal(next.instructions.trim(), "My custom role prompt.");
        component.handleInput("\t");
        const instructions = component.render(80).join("\n");
        assert.match(instructions, /\[Instructions\]/);
        assert.match(instructions, /Reset to bundled/);
        assert.match(instructions, /My custom role prompt/);
    });

    it("an explicit model choice after reset stays user config while effort follows bundled updates", async t => {
        const fx = fixture(t, "user", { ...role({ model: "openai/gamma" }), body: "Custom prompt." });
        const root = join(fx.loc.userRoot, "agents");
        writeCatalogPreferences(root, "role.work", { bundled: true });
        fx.settings.change("role.work", "model", "openai/alpha");
        const { component } = await fx.open("role.work");
        component.handleInput("\x13");
        assert.deepEqual(readCatalogPreferences(root).settings["role.work"], { bundled: true, model: "openai/alpha" });
        fx.settings.clear();
        writeFileSync(fx.bundledPath, serializeDefinition(role({ model: "openai/beta", effort: "low" })).markdown);
        const fresh = await fx.open("role.work");
        const screen = fresh.component.render(100).join("\n");
        assert.match(screen, /Model\s+openai\/alpha\s+user config/);
        assert.match(screen, /Effort\s+low\s+bundled/);
        assert.equal(inspectCatalog(loadCatalog(fx.loc), "role.work").instructions.trim(), "Custom prompt.");
    });

    it("a failed session reset reports the saved write and refreshes the still-active session choice", async t => {
        const fx = fixture(t, "user", role());
        const root = join(fx.loc.userRoot, "agents");
        writeCatalogPreferences(root, "role.work", { model: "openai/gamma", effort: "high" });
        fx.settings.change("role.work", "model", "openai/beta");
        const { component, result } = await fx.open("role.work");
        const append = fx.pi.appendEntry;
        fx.pi.appendEntry = () => { throw new Error("session append denied"); };
        try {
            component.render(100);
            component.handleInput("\x1b[B"); component.render(100);
            component.handleInput("\x1b[B"); component.render(100);
            component.handleInput("\r");
            assert.equal(result.wrote, true, "the saved config did change even though session reset failed");
            assert.deepEqual(readCatalogPreferences(root).settings["role.work"], { bundled: true });
            assert.equal(fx.settings.snapshot()["role.work"].model, "openai/beta");
            const screen = component.render(180).join("\n");
            assert.match(screen, /Saved defaults reset.*current-session overrides remain active/);
            assert.match(screen, /Model\s+openai\/beta\s+session/);
            assert.match(screen, /session append denied/);
        } finally { fx.pi.appendEntry = append; }
    });

    it("Instructions reset preserves absent runtime choices instead of exposing bundled defaults", async t => {
        const fx = fixture(t, "user", { ...role(), defaults: {}, body: "Custom instructions." });
        const before = inspectCatalog(loadCatalog(fx.loc), "role.work");
        assert.equal(before.fields.model.value, null);
        assert.equal(before.fields.effort.value, null);
        const { component } = await fx.open("role.work");
        component.handleInput("\t"); component.render(100);
        component.handleInput("\r");
        const after = inspectCatalog(loadCatalog(fx.loc), "role.work");
        assert.equal(after.instructions.trim(), "Role instructions.");
        assert.equal(after.fields.model.value, null);
        assert.equal(after.fields.effort.value, null);
    });

    it("Instructions reset restores the bundled prompt while preserving model and effort choices", async t => {
        const custom = { ...role({ model: "openai/gamma", effort: "high" }), body: "Old user instructions." };
        const fx = fixture(t, "user", custom);
        const original = readFileSync(fx.saved.path, "utf8");
        fx.settings.change("role.work", "effort", "low");
        const { component, result } = await fx.open("role.work");
        component.handleInput("\t");
        const lines = component.render(100);
        const y = lines.findIndex(line => line.includes("Reset to bundled"));
        assert.ok(y >= 0, lines.join("\n"));
        const pointer = { button: "left", type: "press", x: 4, y, width: 100 };
        assert.equal(component.handleMouse(pointer)?.handled, true);
        assert.equal(existsSync(fx.saved.path), true, "press alone cannot reset a definition");
        assert.equal(component.handleMouse({ ...pointer, type: "click" })?.handled, true);
        assert.equal(result.wrote, true);
        assert.equal(existsSync(fx.saved.path), false);
        const backup = readdirSync(join(fx.loc.userRoot, "agents", "roles")).find(name => name.endsWith(".backup"));
        assert.ok(backup);
        assert.equal(readFileSync(join(fx.loc.userRoot, "agents", "roles", backup), "utf8"), original);
        const catalog = loadCatalog(fx.loc);
        assert.equal(catalog.roles.get("role.work").scope, "bundled");
        assert.deepEqual(catalog.savedSettings["role.work"], { model: "openai/gamma", effort: "high" });
        assert.equal(inspectCatalog(catalog, "role.work").instructions.trim(), "Role instructions.");
        assert.deepEqual(fx.settings.snapshot()["role.work"], { effort: "low" });
        const instructions = component.render(100).join("\n");
        assert.match(instructions, /\[Instructions\]/);
        assert.doesNotMatch(instructions, /Old user instructions/);
        component.handleInput("\x1b");
        const refreshed = component.render(100).join("\n");
        assert.match(refreshed, /Model\s+openai\/gamma\s+user config/);
        assert.match(refreshed, /Effort\s+low\s+session/);
        const launch = await prepareCatalogJob(loadLaunchSnapshot(fx.host()), { role: "work", prompt: "Implement." }, fx.host());
        assert.equal(launch.status, "ready", launch.message);
        assert.equal(launch.assign.model, "openai/gamma");
        assert.equal(launch.assign.thinking, "low");
        assert.equal(launch.assign.prompt, "Role instructions.\n\n---\n\nImplement.");
    });

    it("reset is keyboard accessible and refuses a stale displayed definition", async t => {
        const fx = fixture(t, "user", { ...role(), body: "Custom prompt." });
        const { component } = await fx.open("role.work");
        component.handleInput("\t");
        assert.match(component.render(42).join("\n"), /> Reset to bundled/);
        const changed = readFileSync(fx.saved.path, "utf8").replace("Custom prompt.", "Externally changed prompt.");
        writeFileSync(fx.saved.path, changed);
        component.handleInput("\r");
        assert.equal(readFileSync(fx.saved.path, "utf8"), changed);
        assert.equal(existsSync(join(fx.loc.userRoot, "agents", "settings.json")), false);
        assert.match(component.render(140).join("\n"), /changed since this screen/);
        // A fresh screen may reset the same definition without a confirmation step.
        const fresh = (await fx.open("role.work")).component;
        fresh.handleInput("\t"); fresh.render(80);
        fresh.handleInput("\r");
        assert.equal(loadCatalog(fx.loc).roles.get("role.work").scope, "bundled");
    });

    it("does not offer cleanup for project definitions or user definitions without a bundled fallback", async t => {
        for (const [scope, definition] of [["project", role()], ["user", agent()]]) {
            const fx = fixture(t, scope, definition);
            const original = readFileSync(fx.saved.path, "utf8");
            const { component } = await fx.open(definition.id);
            assert.doesNotMatch(component.render(100).join("\n"), /Reset to bundled/);
            assert.equal(readFileSync(fx.saved.path, "utf8"), original);
        }
    });

    it("UI edits persist to the session, not catalog files; discovery and launches use effective settings", async (t) => {
        const fx = fixture(t);
        const original = readFileSync(fx.saved.path, "utf8");
        const { component, result } = await fx.open();
        const initial = component.render(100).join("\n");
        assert.match(initial, /> Model\s+openai\/alpha/);
        assert.match(initial, /Effort\s+medium/);
        assert.doesNotMatch(initial, /e settings/);
        editModel(component, "beta");
        component.handleInput("\x1b[B");
        component.handleInput("\r");
        component.handleInput("\x1b[B"); // medium -> high
        component.handleInput("\r");
        component.handleInput("\x1b[B"); // Remains on Effort: there is no selectable save row.
        component.handleInput("\r");
        component.handleInput("\r");
        assert.deepEqual(fx.settings.snapshot()["agent.worker"], { model: "openai/beta", effort: "high" });
        assert.equal(readFileSync(fx.saved.path, "utf8"), original);
        assert.equal(result.wrote, false);
        for (const width of [24, 42, 90]) assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
        const discovery = await fx.discovery().execute("list", { action: "list" }, undefined, undefined, { cwd: fx.loc.cwd, isProjectTrusted: () => true });
        const row = discovery.details.entries.find((entry) => entry.id === "agent.worker");
        assert.equal(row.fields.model.value, "openai/beta");
        assert.equal(row.actualModel, "openai/beta");
        assert.equal(row.actualEffort, "high");
        assert.match(component.render(100).join("\n"), /Actual\s+openai\/beta\s+·\s+high/);
        component.handleInput("p");
        assert.match(component.render(100).join("\n"), /Role instructions/);
        component.handleInput("\x1b");
        assert.match(component.render(100).join("\n"), /> Effort\s+high\s+session/);
        component.handleInput("\x1b");
        assert.match(component.render(100).join("\n"), /Search/);
        const prepared = await prepareCatalogJob(loadLaunchSnapshot(fx.host()), { agent: "agent.worker", prompt: "Do work." }, fx.host());
        assert.equal(prepared.status, "ready", prepared.message);
        assert.equal(prepared.assign.model, "openai/beta");
        assert.equal(prepared.assign.thinking, "high");
        assert.equal(prepared.assign.prompt, "Role instructions.\n\nNamed instructions.\n\n---\n\nDo work.");
        assert.equal(prepared.assign.catalog.capabilities.grantedByCatalog, false);
        fx.reload();
        const reloaded = await fx.command("reload", true);
        assert.equal(reloaded.data.entries.find((entry) => entry.id === "agent.worker").fields.effort.value, "high");
    });

    it("restores only the active branch after reload, fork, tree navigation, and session switch", (t) => {
        const fx = fixture(t);
        fx.settings.change("role.work", "model", "openai/beta");
        const branchPoint = fx.session.getLeafId();
        fx.settings.change("agent.worker", "effort", "high");
        const firstLeaf = fx.session.getLeafId();
        fx.reload();
        assert.equal(fx.settings.snapshot()["agent.worker"].effort, "high");
        fx.session.branch(branchPoint);
        fx.restore();
        assert.equal(fx.settings.snapshot()["agent.worker"], undefined);
        fx.settings.change("agent.worker", "effort", "low");
        const secondLeaf = fx.session.getLeafId();
        const originalPath = fx.session.getSessionFile();
        const fork = fx.session.createBranchedSession(secondLeaf);
        fx.session = SessionManager.open(fork);
        fx.settings.change("role.work", "model", "openai/gamma");
        assert.equal(fx.settings.snapshot()["role.work"].model, "openai/gamma");
        fx.session = SessionManager.inMemory(fx.loc.cwd);
        assert.deepEqual(fx.settings.snapshot(), {});
        // A different session cannot leak settings even when no branch API is present.
        fx.settings.restore({});
        assert.deepEqual(fx.settings.snapshot(), {});
        // The original session's abandoned sibling remains independent.
        const source = SessionManager.open(originalPath);
        source.branch(firstLeaf);
        fx.session = source;
        assert.deepEqual(fx.settings.snapshot(), { "role.work": { model: "openai/beta" }, "agent.worker": { effort: "high" } });
        source.branch(secondLeaf);
        fx.restore();
        assert.deepEqual(fx.settings.snapshot(), { "role.work": { model: "openai/beta" }, "agent.worker": { effort: "low" } });
        source.branch(branchPoint);
        fx.restore();
        assert.deepEqual(fx.settings.snapshot(), { "role.work": { model: "openai/beta" } });
    });

    it("role changes flow into named agents; clearing own overrides inherits without flattening, and a held launch snapshot is stable", async (t) => {
        const fx = fixture(t, "user", agent({ model: "openai/alpha", effort: "high" }));
        fx.settings.change("role.work", "model", "openai/beta");
        fx.settings.change("role.work", "effort", "low");
        let view = inspectCatalog(loadLaunchSnapshot(fx.host()), "agent.worker");
        assert.equal(view.fields.model.value, "openai/alpha");
        fx.settings.change("agent.worker", "model", null);
        fx.settings.change("agent.worker", "effort", null);
        const held = loadLaunchSnapshot(fx.host());
        view = inspectCatalog(held, "agent.worker");
        assert.equal(view.fields.model.value, "openai/beta");
        assert.equal(view.fields.effort.value, "low");
        assert.equal(view.fields.model.source, "role-default");
        assert.equal(view.fields.effort.explicit, false);
        fx.settings.change("role.work", "model", "openai/gamma");
        const before = await prepareCatalogJob(held, { agent: "agent.worker", prompt: "Work" }, fx.host());
        const after = await prepareCatalogJob(loadLaunchSnapshot(fx.host()), { agent: "agent.worker", prompt: "Work" }, fx.host());
        assert.equal(before.assign.model, "openai/beta");
        assert.equal(after.assign.model, "openai/gamma");
        const explicit = await prepareCatalogJob(held, { agent: "agent.worker", model: "openai/alpha", thinking: "medium", prompt: "Work" }, fx.host());
        assert.equal(explicit.assign.model, "openai/alpha");
        assert.equal(explicit.assign.thinking, "medium");
        const saved = saveAgentSessionDefaults(loadCatalog(fx.loc), "agent.worker", fx.settings.snapshot(), fx.loc);
        assert.equal(saved.ok, true);
        const definition = parseDefinition(readFileSync(fx.saved.path, "utf8")).definition;
        assert.deepEqual(definition.overrides, { model: "openai/alpha", effort: "high" }, "saving preferences never rewrites the definition");
        assert.deepEqual(JSON.parse(readFileSync(saved.path, "utf8")).defaults["agent.worker"], { model: null, effort: null });
        assert.equal(definition.roleId, "role.work");
        assert.equal(definition.body.trim(), "Named instructions.");
        assert.deepEqual(definition.provenance, agent().provenance);
        writeFileSync(fx.bundledPath, serializeDefinition(role({ effort: "medium" })).markdown);
        fx.settings.change("role.work", "effort", null);
        fx.reload();
        // Clearing a role default removes it, not the role's other defaults.
        view = inspectCatalog(loadLaunchSnapshot(fx.host()), "agent.worker");
        assert.equal(view.fields.effort.value, null);
        assert.equal(view.fields.tier.value, "balanced");
    });

    it("cancel discards unselected input, Inherit removes a saved agent override, and live role file changes still apply", async (t) => {
        const fx = fixture(t, "user", { ...agent({ model: "openai/beta" }), instructionMode: "replace" });
        const { component } = await fx.open();
        component.handleInput("\r");
        component.handleInput("gamma");
        component.handleInput("\x1b");
        assert.deepEqual(fx.settings.snapshot(), {});
        component.handleInput("\r");
        component.handleInput("Inherit");
        component.handleInput("\r");
        assert.equal(fx.settings.snapshot()["agent.worker"].model, null);
        assert.match(component.render(90).join("\n"), /openai\/alpha/);
        writeFileSync(fx.bundledPath, serializeDefinition(role({ model: "openai/gamma", effort: "low" })).markdown);
        const launch = await prepareCatalogJob(loadLaunchSnapshot(fx.host()), { agent: "agent.worker", prompt: "Work" }, fx.host());
        assert.equal(launch.assign.model, "openai/gamma");
        assert.equal(launch.assign.thinking, "low");
        assert.equal(launch.assign.prompt, "Named instructions.\n\n---\n\nWork");
        const listed = await fx.command("list", true);
        assert.equal(listed.data.entries.find((entry) => entry.id === "agent.worker").actualModel, "openai/gamma");
        const help = await fx.command("", true);
        assert.equal(help.command, "help");
    });

    it("session efforts keep role adjustment versus explicit named-agent failure and cannot bypass restrictions", async (t) => {
        const fx = fixture(t);
        const constrained = { ...fx.host(), registry: { getAvailable: () => [{ provider: "openai", id: "alpha", reasoning: false }] } };
        fx.settings.change("role.work", "effort", "high");
        let launch = await prepareCatalogJob(loadLaunchSnapshot({ ...constrained, sessionSettings: fx.settings.snapshot() }), { agent: "agent.worker", prompt: "Work" }, constrained);
        assert.equal(launch.status, "ready", launch.message);
        assert.equal(launch.assign.thinking, "off");
        fx.settings.change("agent.worker", "effort", "high");
        launch = await prepareCatalogJob(loadLaunchSnapshot(constrained), { agent: "agent.worker", prompt: "Work" }, constrained);
        assert.equal(launch.status, "blocked");
        assert.equal(launch.diagnostics.some((item) => item.code === "unsupported-explicit-effort"), true);
        const restricted = agent();
        restricted.executionRestrictions = [{ name: "sandbox_mode", value: "read-only", required: true, honored: false }];
        const saved = saveDefinition({ ...fx.loc, definition: restricted, replace: true });
        assert.equal(saved.ok, true);
        fx.settings.change("agent.worker", "model", "openai/beta");
        launch = await prepareCatalogJob(loadLaunchSnapshot(fx.host()), { agent: "agent.worker", prompt: "Work" }, fx.host());
        assert.equal(launch.status, "blocked");
        assert.equal(launch.diagnostics.some((item) => item.code === "unsupported-execution-restriction"), true);
        const updated = saveAgentSessionDefaults(loadCatalog(fx.loc), "agent.worker", fx.settings.snapshot(), fx.loc);
        assert.equal(updated.ok, true);
        const loaded = loadCatalog(fx.loc);
        assert.equal(inspectCatalog(loaded, "agent.worker").launchable, false);
        assert.equal(loaded.agents.get("agent.worker").definition.executionRestrictions[0].value, "read-only");
    });

    for (const scope of ["user", "project", "bundled"]) it(`Ctrl+S saves selected ${scope} preferences without copying definition files`, async (t) => {
        const definition = scope === "bundled" ? role() : agent();
        const fx = fixture(t, scope, definition);
        const bundled = readFileSync(fx.bundledPath, "utf8");
        const original = fx.saved ? readFileSync(fx.saved.path, "utf8") : undefined;
        fx.settings.change("role.work", "effort", "low");
        const { component, result } = await fx.open(definition.id);
        editModel(component, "beta");
        component.handleInput("\x13");
        assert.match(component.render(80).join("\n"), /Defaults saved/);
        assert.equal(result.wrote, true);
        assert.equal(result.scope, scope === "project" ? "project" : "user");
        const fresh = loadCatalog(fx.loc);
        const entry = definition.kind === "role" ? fresh.roles.get(definition.id) : fresh.agents.get(definition.id);
        const preferences = fresh.savedSettings[definition.id];
        assert.equal(preferences.model, "openai/beta");
        assert.equal(preferences.effort, definition.kind === "role" ? "low" : undefined);
        assert.equal(readFileSync(fx.bundledPath, "utf8"), bundled);
        if (fx.saved) assert.equal(readFileSync(fx.saved.path, "utf8"), original);
        assert.equal(inspectCatalog(fresh, definition.id).fields.model.value, "openai/beta");
        if (scope !== "bundled") assert.equal(inspectCatalog(fresh, "agent.worker").fields.effort.value, "medium");
        if (scope === "bundled") {
            assert.equal(entry.scope, "bundled");
            assert.equal(existsSync(join(fx.loc.userRoot, "agents", "roles", "role.work.md")), false);
            writeFileSync(fx.bundledPath, bundled.replace("Role instructions.", "Updated bundled instructions."));
            const updated = inspectCatalog(loadCatalog(fx.loc), definition.id);
            assert.equal(updated.instructions.trim(), "Updated bundled instructions.");
            assert.equal(updated.fields.model.value, "openai/beta");
        }
    });

    it("save failures leave branch edits intact and trust and validation still block launches", async (t) => {
        const fx = fixture(t, "project");
        const original = readFileSync(fx.saved.path, "utf8");
        const { component, result } = await fx.open();
        editModel(component, "beta");
        // Trust can change while the overlay is open.
        fx.loc.projectTrusted = false;
        component.handleInput("\x13");
        assert.match(component.render(100).join("\n"), /repair the catalog definition|Refusing to write/);
        assert.equal(result.wrote, false);
        assert.equal(readFileSync(fx.saved.path, "utf8"), original);
        assert.equal(fx.settings.snapshot()["agent.worker"].model, "openai/beta");
        fx.loc.projectTrusted = true;
        // Atomic writer failure (target directory is a file).
        rmSync(join(fx.loc.userRoot, "agents"), { recursive: true, force: true });
        mkdirSync(fx.loc.userRoot, { recursive: true });
        writeFileSync(join(fx.loc.userRoot, "agents"), "not a directory");
        const failed = saveAgentSessionDefaults(loadCatalog(fx.loc), "role.work", fx.settings.snapshot(), fx.loc);
        assert.equal(failed.ok, false);
        assert.equal(failed.diagnostics.some((item) => item.code === "agents-save"), true);
        fx.reload();
        assert.equal(fx.settings.snapshot()["agent.worker"].model, "openai/beta");
        writeFileSync(fx.saved.path, original.replace("kind: agent", "kind: wrong"));
        const blocked = await prepareCatalogJob(loadLaunchSnapshot(fx.host()), { agent: "agent.worker", prompt: "Work" }, fx.host());
        assert.equal(blocked.status, "blocked");
        assert.equal(blocked.diagnostics.some((item) => item.code === "invalid-shadow"), true);
    });

    it("invalid session entries and failed appends do not change settings", (t) => {
        const fx = fixture(t);
        fx.settings.change("agent.worker", "effort", "low");
        fx.pi.appendEntry("pi-better-subagents-agent-settings", { version: 1, id: "agent.worker", key: "effort", value: "extreme" });
        fx.pi.appendEntry("pi-better-subagents-agent-settings", { version: 2, id: "agent.worker", key: "effort", value: "high" });
        fx.restore();
        assert.equal(fx.settings.snapshot()["agent.worker"].effort, "low");
        assert.throws(() => fx.settings.change("agent.worker", "model", "missing-provider"), /valid model or effort/);
        const settings = createAgentSessionSettings({ appendEntry() { throw new Error("session write failed"); } });
        settings.restore({ sessionManager: fx.session });
        assert.throws(() => settings.change("agent.worker", "effort", "high"), /session write failed/);
        assert.equal(settings.snapshot()["agent.worker"].effort, "low");
    });

    it("offers only session-scoped models in the picker, preserving saved values and empty-scope fallback", async (t) => {
        const scoped = [{ model: { provider: "openai", id: "beta" } }];
        const fx = fixture(t, "user", agent(), { scopedModels: scoped });
        const original = readFileSync(fx.saved.path, "utf8");
        // Scope affects the picker only: the saved out-of-scope default still launches.
        const beforeEdit = await prepareCatalogJob(loadLaunchSnapshot(fx.host()), { agent: "agent.worker", prompt: "Work" }, fx.host());
        assert.equal(beforeEdit.status, "ready", beforeEdit.message);
        assert.equal(beforeEdit.assign.model, "openai/alpha");
        const { component, result } = await fx.open();
        component.handleInput("\r");
        const picker = component.render(100).join("\n");
        assert.match(picker, /Agents \/ model/);
        assert.match(picker, /Session model scope · 1 model · saved value is outside this scope/);
        assert.match(picker, /openai\/beta/);
        assert.doesNotMatch(picker, /openai\/gamma/);
        assert.doesNotMatch(picker, /openai\/alpha/, "the out-of-scope saved value is not offered");
        component.handleInput("gamma");
        assert.match(component.render(100).join("\n"), /No matching commands/);
        component.handleInput("\x1b");
        assert.match(component.render(100).join("\n"), /Model\s+openai\/alpha\s+inherited/);
        // A scoped choice is a normal session preference: resolution is unchanged.
        editModel(component, "beta");
        assert.deepEqual(fx.settings.snapshot()["agent.worker"], { model: "openai/beta" });
        assert.equal(readFileSync(fx.saved.path, "utf8"), original);
        assert.equal(result.wrote, false);
        const prepared = await prepareCatalogJob(loadLaunchSnapshot(fx.host()), { agent: "agent.worker", prompt: "Work" }, fx.host());
        assert.equal(prepared.status, "ready", prepared.message);
        assert.equal(prepared.assign.model, "openai/beta");

        const unscoped = fixture(t, "user", agent());
        const fallback = await unscoped.open();
        fallback.component.handleInput("\r");
        const fallbackPicker = fallback.component.render(100).join("\n");
        assert.match(fallbackPicker, /All available models · no session scope/);
        assert.match(fallbackPicker, /openai\/gamma/);
    });

    it("reads the session scope from the command context and tolerates hosts without it", async (t) => {
        const fx = fixture(t);
        const scoped = await fx.openFromContext("agent.worker", { scopedModels: [{ model: { provider: "openai", id: "gamma" } }] });
        scoped.component.handleInput("\r");
        const picker = scoped.component.render(100).join("\n");
        assert.match(picker, /Session model scope · 1 model/);
        assert.match(picker, /openai\/gamma/);
        assert.doesNotMatch(picker, /openai\/beta/);
        const unscoped = await fx.openFromContext("agent.worker");
        unscoped.component.handleInput("\r");
        const fallbackPicker = unscoped.component.render(100).join("\n");
        assert.match(fallbackPicker, /All available models · no session scope/);
        assert.match(fallbackPicker, /openai\/beta/);
    });
});
