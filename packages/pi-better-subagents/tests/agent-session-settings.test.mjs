import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createAgentSessionSettings, saveAgentSessionDefaults } from "../agent-session-settings.ts";
import { executeAgentsCommand } from "../agent-commands.ts";
import { agentsCatalogTool } from "../agents-catalog-tool.ts";
import { createLaunchEnricher, loadLaunchSnapshot, noteCatalogHost, prepareCatalogJob } from "../catalog-runtime.ts";
import { loadCatalog, saveDefinition } from "../catalog-store.ts";
import { inspectCatalog } from "../catalog-resolver.ts";
import { parseDefinition, serializeDefinition } from "../catalog-schema.ts";

const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text, inverse: (text) => text };
const Type = { Object: (x) => x, String: (x) => x, Optional: (x) => x };
const role = (defaults = {}) => ({ schema: "pi-agent/v1", kind: "role", id: "role.work", name: "Worker", defaults: { model: "openai/alpha", effort: "medium", tier: "balanced", ...defaults }, executionRestrictions: [], body: "Role instructions." });
const agent = (overrides = {}) => ({ schema: "pi-agent/v1", kind: "agent", id: "agent.worker", name: "Named Worker", roleId: "role.work", instructionMode: "add", overrides, executionRestrictions: [], provenance: { origin: "imported", format: "codex-toml", sourceRef: "source.toml" }, body: "Named instructions." });

function fixture(t, scope = "user", definition = agent()) {
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
    const commandHost = { cwd: loc.cwd, hasUI: true, mode: "tui", isProjectTrusted: () => loc.projectTrusted, ui };
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
    component.handleInput("e");
    component.handleInput("\r");
    component.handleInput(label);
    component.handleInput("\r");
}

describe("branch-local agent model and effort", () => {
    it("UI edits persist to the session, not catalog files; discovery and launches use effective settings", async (t) => {
        const fx = fixture(t);
        const original = readFileSync(fx.saved.path, "utf8");
        const { component, result } = await fx.open();
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
        component.handleInput("\x1b");
        assert.match(component.render(100).join("\n"), /Actual\s+openai\/beta\s+·\s+high/);
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
        const definition = parseDefinition(readFileSync(saved.path, "utf8")).definition;
        assert.deepEqual(definition.overrides, {});
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
        component.handleInput("e");
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

    for (const scope of ["user", "project", "bundled"]) it(`Ctrl+S saves only the selected ${scope} definition, never the bundled source`, async (t) => {
        const definition = scope === "bundled" ? role() : agent();
        const fx = fixture(t, scope, definition);
        const bundled = readFileSync(fx.bundledPath, "utf8");
        fx.settings.change("role.work", "effort", "low");
        const { component, result } = await fx.open(definition.id);
        editModel(component, "beta");
        component.handleInput("\x13");
        assert.match(component.render(80).join("\n"), /Defaults saved/);
        assert.equal(result.wrote, true);
        assert.equal(result.scope, scope === "project" ? "project" : "user");
        const fresh = loadCatalog(fx.loc);
        const entry = definition.kind === "role" ? fresh.roles.get(definition.id) : fresh.agents.get(definition.id);
        const preferences = definition.kind === "role" ? entry.definition.defaults : entry.definition.overrides;
        assert.equal(preferences.model, "openai/beta");
        assert.equal(preferences.effort, definition.kind === "role" ? "low" : undefined);
        assert.equal(readFileSync(fx.bundledPath, "utf8"), bundled);
        if (scope !== "bundled") assert.equal(inspectCatalog(fresh, "agent.worker").fields.effort.value, "medium");
        if (scope === "bundled") assert.ok(existsSync(join(fx.loc.userRoot, "agents", "roles", "role.work.md")));
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
        assert.equal(failed.diagnostics.some((item) => item.code === "io-error"), true);
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
});
