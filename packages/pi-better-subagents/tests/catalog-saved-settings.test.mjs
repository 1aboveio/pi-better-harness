import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { loadCatalog } from "../catalog-store.ts";
import { inspectCatalog } from "../catalog-resolver.ts";
import { AGENT_SESSION_SETTINGS_ENTRY, createAgentSessionSettings, withAgentSessionSettings } from "../agent-session-settings.ts";
import { writeCatalogPreferences } from "../catalog-preferences.ts";

const role = `---\nschema: pi-agent/v1\nkind: role\nid: role.work\nname: Worker\ndefaults:\n  model: openai/alpha\n  effort: medium\n---\nCurrent bundled prompt.\n`;
function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), "catalog-saved-settings-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const loc = { cwd: join(root, "project"), userRoot: join(root, "user"), bundledRoot: join(root, "bundled"), projectTrusted: true };
    const user = join(loc.userRoot, "agents");
    const project = join(loc.cwd, ".pi", "agents");
    mkdirSync(user, { recursive: true }); mkdirSync(project, { recursive: true }); mkdirSync(loc.bundledRoot);
    writeFileSync(join(loc.bundledRoot, "worker.md"), role);
    return { loc, user, project };
}
test("saved fields layer by scope below branch settings without pinning other defaults or instructions", t => {
    const f = fixture(t);
    writeCatalogPreferences(f.user, "role.work", { model: "openai/beta" });
    const before = loadCatalog(f.loc);
    assert.equal(inspectCatalog(before, "role.work").fields.effort.value, "medium");
    writeCatalogPreferences(f.project, "role.work", { effort: "high" });
    const project = loadCatalog(f.loc);
    const effective = inspectCatalog(project, "role.work");
    assert.equal(effective.fields.model.value, "openai/beta");
    assert.equal(effective.fields.effort.value, "high");
    assert.equal(effective.instructions.trim(), "Current bundled prompt.");
    assert.equal(project.roles.get("role.work").scope, "bundled");
    assert.notEqual(project.digest, before.digest);
    const branch = withAgentSessionSettings(project, { "role.work": { model: "openai/gamma" } });
    assert.equal(inspectCatalog(branch, "role.work").fields.model.value, "openai/gamma");
    assert.equal(inspectCatalog(branch, "role.work").fields.effort.value, "high");
    assert.equal(inspectCatalog(project, "role.work").fields.model.value, "openai/beta");
    const untrusted = inspectCatalog(loadCatalog({ ...f.loc, projectTrusted: false }), "role.work");
    assert.equal(untrusted.fields.effort.value, "medium", "untrusted project config is never consumed");
    assert.equal(untrusted.fields.model.value, "openai/beta");
});
test("user preferences cannot override a project-owned definition", t => {
    const f = fixture(t);
    mkdirSync(join(f.project, "roles"));
    writeFileSync(join(f.project, "roles", "worker.md"), role.replace("openai/alpha", "openai/project"));
    writeCatalogPreferences(f.user, "role.work", { model: "openai/personal", effort: "high" });
    const inspected = inspectCatalog(loadCatalog(f.loc), "role.work");
    assert.equal(inspected.fields.model.value, "openai/project");
    assert.equal(inspected.fields.effort.value, "medium");
});
test("invalid stored preferences block affected roles instead of silently falling back", t => {
    const f = fixture(t);
    writeFileSync(join(f.user, "settings.json"), '{"version":1,"defaults":{"role.work":{"model":"bad-reference"}}}');
    const inspected = inspectCatalog(loadCatalog(f.loc), "role.work");
    assert.equal(inspected.launchable, false);
    assert.ok(inspected.validation.some(item => item.code === "catalog-preferences" && item.blocking));
});

function sessionFixture(t) {
    const f = fixture(t);
    let session = SessionManager.create(f.loc.cwd, join(f.loc.cwd, "sessions"));
    session.appendMessage({ role: "user", content: "Test reset settings.", timestamp: 1 });
    session.appendMessage({ role: "assistant", content: [], provider: "openai", model: "alpha", api: "openai-responses", stopReason: "stop", timestamp: 2 });
    const pi = { appendEntry: (type, data) => session.appendCustomEntry(type, data) };
    let settings = createAgentSessionSettings(pi);
    const restore = () => settings.restore({ sessionManager: session });
    return {
        ...f, restore, pi,
        get session() { return session; },
        get settings() { return settings; },
        reload(path = session.getSessionFile()) {
            session = SessionManager.open(path);
            settings = createAgentSessionSettings(pi);
            restore();
        },
    };
}

test("selected session reset survives reload and fork while sibling branches retain their overrides", t => {
    const f = sessionFixture(t);
    f.settings.change("role.work", "model", "openai/beta");
    f.settings.change("role.work", "effort", "high");
    f.settings.change("agent.sibling", "model", "openai/sibling");
    const beforeReset = f.session.getLeafId();
    const held = f.settings.snapshot();
    f.settings.reset("role.work");
    const resetLeaf = f.session.getLeafId();
    assert.deepEqual(f.settings.snapshot(), { "agent.sibling": { model: "openai/sibling" } });
    assert.deepEqual(held["role.work"], { model: "openai/beta", effort: "high" }, "held snapshots remain immutable");
    const resetEntry = f.session.getBranch().at(-1);
    assert.equal(resetEntry.customType, AGENT_SESSION_SETTINGS_ENTRY);
    assert.deepEqual(resetEntry.data, { version: 1, kind: "reset", id: "role.work" });
    f.reload();
    assert.deepEqual(f.settings.snapshot(), { "agent.sibling": { model: "openai/sibling" } });
    const view = inspectCatalog(withAgentSessionSettings(loadCatalog(f.loc), f.settings.snapshot()), "role.work");
    assert.equal(view.fields.model.value, "openai/alpha");
    assert.equal(view.fields.effort.value, "medium");
    const originalSession = f.session.getSessionFile();
    const fork = f.session.createBranchedSession(resetLeaf);
    f.reload(fork);
    assert.deepEqual(f.settings.snapshot(), { "agent.sibling": { model: "openai/sibling" } });
    f.settings.change("role.work", "effort", "low");
    f.reload();
    assert.deepEqual(f.settings.snapshot(), { "role.work": { effort: "low" }, "agent.sibling": { model: "openai/sibling" } });
    f.settings.reset("agent.sibling");
    f.reload();
    assert.deepEqual(f.settings.snapshot(), { "role.work": { effort: "low" } });
    f.reload(originalSession);
    f.session.branch(beforeReset);
    f.restore();
    assert.deepEqual(f.settings.snapshot(), {
        "role.work": { model: "openai/beta", effort: "high" },
        "agent.sibling": { model: "openai/sibling" },
    });
    f.session.branch(resetLeaf);
    f.restore();
    assert.deepEqual(f.settings.snapshot(), { "agent.sibling": { model: "openai/sibling" } });
    const branchLength = f.session.getBranch().length;
    f.settings.clear();
    assert.deepEqual(f.settings.snapshot(), {});
    assert.equal(f.session.getBranch().length, branchLength, "lifecycle clear stays ephemeral");
    f.restore();
    assert.deepEqual(f.settings.snapshot(), { "agent.sibling": { model: "openai/sibling" } });
});

test("failed reset append leaves overrides intact and malformed reset entries are ignored", t => {
    const f = sessionFixture(t);
    f.settings.change("role.work", "model", "openai/beta");
    f.settings.change("role.work", "effort", null);
    f.settings.change("agent.sibling", "effort", "high");
    const held = f.settings.snapshot();
    const failing = createAgentSessionSettings({ appendEntry() { throw new Error("session append denied"); } });
    failing.restore({ sessionManager: f.session });
    assert.throws(() => failing.reset("role.work"), /session append denied/);
    assert.deepEqual(failing.snapshot(), held);
    const branchLength = f.session.getBranch().length;
    for (const id of ["", "work", "role.Invalid", "../role.work", null]) {
        assert.throws(() => f.settings.reset(id), /valid catalog id/);
    }
    assert.equal(f.session.getBranch().length, branchLength);
    for (const data of [
        { version: 2, kind: "reset", id: "role.work" },
        { version: 1, kind: "reset", id: "../role.work" },
        { version: 1, kind: "reset" },
    ]) f.pi.appendEntry(AGENT_SESSION_SETTINGS_ENTRY, data);
    f.reload();
    assert.deepEqual(f.settings.snapshot(), held);
    f.settings.reset("role.work");
    f.settings.reset("role.work");
    f.reload();
    assert.deepEqual(f.settings.snapshot(), { "agent.sibling": { effort: "high" } });
});