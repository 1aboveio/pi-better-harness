import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire, syncBuiltinESMExports } from "node:module";
import fs from "node:fs";
import { loadCatalog, resetRuntimeToBundled, resetToBundled, resetUserDefinition } from "../catalog-store.ts";
import { inspectCatalog } from "../catalog-resolver.ts";
import { readCatalogPreferences, writeCatalogPreferences } from "../catalog-preferences.ts";

const markdown = body => `---\nschema: pi-agent/v1\nkind: role\nid: role.work\nname: Worker\ndefaults:\n  model: openai/alpha\n  effort: high\n---\n${body}\n`;
function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), "catalog-reset-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const loc = { cwd: join(root, "project"), userRoot: join(root, "user"), bundledRoot: join(root, "bundled"), projectTrusted: true };
    const roles = join(loc.userRoot, "agents", "roles");
    const path = join(roles, "worker.md");
    mkdirSync(roles, { recursive: true }); mkdirSync(loc.cwd); mkdirSync(loc.bundledRoot);
    writeFileSync(path, markdown("User prompt."));
    writeFileSync(join(loc.bundledRoot, "worker.md"), markdown("Bundled prompt."));
    const entry = loadCatalog(loc).roles.get("role.work");
    const reset = () => resetUserDefinition({ ...loc, id: entry.id, expectedPath: entry.path, expectedDigest: entry.contentDigest });
    return { root, loc, roles, path, entry, reset };
}

test("reset archives exact original bytes and preserves config preferences over legacy values", t => {
    const f = fixture(t);
    writeCatalogPreferences(join(f.loc.userRoot, "agents"), "role.work", { model: "openai/beta" });
    const original = readFileSync(f.path);
    const held = loadCatalog(f.loc);
    const result = f.reset();
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(existsSync(f.path), false);
    assert.deepEqual(readFileSync(result.backupPath), original);
    const fresh = loadCatalog(f.loc);
    assert.equal(fresh.roles.get("role.work").scope, "bundled");
    assert.deepEqual(fresh.savedSettings["role.work"], { model: "openai/beta", effort: "high" });
    assert.equal(inspectCatalog(fresh, "role.work").instructions.trim(), "Bundled prompt.");
    assert.equal(inspectCatalog(held, "role.work").instructions.trim(), "User prompt.", "held launch snapshots stay immutable");
});

test("stale paths and digests cannot archive a newly edited definition", t => {
    const f = fixture(t);
    const result = resetUserDefinition({ ...f.loc, id: f.entry.id, expectedPath: join(f.roles, "other.md"), expectedDigest: f.entry.contentDigest });
    assert.equal(result.ok, false);
    const changed = markdown("New user prompt.");
    writeFileSync(f.path, changed);
    assert.equal(f.reset().ok, false);
    assert.equal(readFileSync(f.path, "utf8"), changed);
    assert.deepEqual(readdirSync(f.roles), ["worker.md"]);
});

test("project winners and same-scope duplicates leave every definition intact", t => {
    const f = fixture(t);
    writeFileSync(join(f.roles, "duplicate.md"), markdown("Duplicate user."));
    assert.equal(f.reset().ok, false);
    rmSync(join(f.roles, "duplicate.md"));
    const projectRoles = join(f.loc.cwd, ".pi", "agents", "roles");
    mkdirSync(projectRoles, { recursive: true });
    const project = join(projectRoles, "worker.md");
    writeFileSync(project, markdown("Project prompt."));
    assert.equal(f.reset().ok, false);
    assert.equal(readFileSync(project, "utf8"), markdown("Project prompt."));
    assert.equal(readFileSync(f.path, "utf8"), markdown("User prompt."));
});

test("missing, duplicate, and blocking bundled fallbacks refuse cleanup", t => {
    const f = fixture(t);
    const bundled = join(f.loc.bundledRoot, "worker.md");
    rmSync(bundled);
    assert.equal(f.reset().ok, false);
    writeFileSync(bundled, markdown("Bundled prompt."));
    writeFileSync(join(f.loc.bundledRoot, "duplicate.md"), markdown("Ambiguous fallback."));
    assert.equal(f.reset().ok, false);
    rmSync(join(f.loc.bundledRoot, "duplicate.md"));
    writeFileSync(bundled, markdown("Blocked fallback.").replace("defaults:", "api_key: secret-test-value\ndefaults:"));
    assert.equal(f.reset().ok, false);
    assert.equal(readFileSync(f.path, "utf8"), markdown("User prompt."));
    assert.equal(existsSync(join(f.loc.userRoot, "agents", "settings.json")), false);
});

test("an edit while reset acquires the config lock keeps the active file and rolls back migrated preferences", t => {
    const f = fixture(t);
    const catalog = join(f.loc.userRoot, "agents");
    writeCatalogPreferences(catalog, "role.work", { model: "openai/beta" });
    const lockfile = createRequire(import.meta.url)("proper-lockfile");
    const original = lockfile.lockSync;
    let intercepted = false;
    const changed = markdown("Edited while saving preferences.");
    lockfile.lockSync = (...args) => {
        if (!intercepted) { intercepted = true; writeFileSync(f.path, changed); }
        return original(...args);
    };
    try {
        const result = f.reset();
        assert.equal(result.ok, false);
        assert.ok(result.diagnostics.some(item => /changed while saving/.test(item.message)));
        assert.equal(readFileSync(f.path, "utf8"), changed);
        assert.deepEqual(readCatalogPreferences(catalog).settings["role.work"], { model: "openai/beta" });
        assert.deepEqual(readdirSync(f.roles), ["worker.md"]);
    } finally { lockfile.lockSync = original; }
});

test("a failed archive restores previous preferences and leaves the Markdown active", t => {
    const f = fixture(t);
    const catalog = join(f.loc.userRoot, "agents");
    writeCatalogPreferences(catalog, "role.work", { model: "openai/beta" });
    const original = fs.renameSync;
    fs.renameSync = (source, target) => {
        if (source === f.path) throw Object.assign(new Error("archive denied"), { code: "EACCES" });
        return original(source, target);
    };
    syncBuiltinESMExports();
    try {
        const result = f.reset();
        assert.equal(result.ok, false);
        assert.ok(result.diagnostics.some(item => /archive denied/.test(item.message)));
        assert.equal(readFileSync(f.path, "utf8"), markdown("User prompt."));
        assert.deepEqual(readCatalogPreferences(catalog).settings["role.work"], { model: "openai/beta" });
        assert.deepEqual(readdirSync(f.roles), ["worker.md"]);
    } finally { fs.renameSync = original; syncBuiltinESMExports(); }
});

for (const runtimeOnly of [false, true]) test(`symlink catalog roots and files cannot redirect ${runtimeOnly ? "runtime reset" : "cleanup"}`, t => {
    const f = fixture(t);
    const reset = () => runtimeOnly ? resetRuntimeSelected(f.loc, f.entry) : f.reset();
    const outside = join(f.root, "outside");
    mkdirSync(outside);
    const target = join(outside, "worker.md");
    writeFileSync(target, markdown("External prompt."));
    rmSync(f.path); symlinkSync(target, f.path);
    assert.equal(reset().ok, false);
    assert.equal(readFileSync(target, "utf8"), markdown("External prompt."));
    rmSync(f.path); writeFileSync(f.path, markdown("User prompt."));
    const catalog = join(f.loc.userRoot, "agents");
    const moved = join(f.root, "moved-catalog");
    mkdirSync(join(moved, "roles"), { recursive: true });
    writeFileSync(join(moved, "roles", "worker.md"), markdown("User prompt."));
    rmSync(catalog, { recursive: true }); symlinkSync(moved, catalog);
    assert.equal(reset().ok, false);
    assert.deepEqual(readdirSync(join(moved, "roles")), ["worker.md"]);
});

function resetSelected(loc, entry = loadCatalog(loc).roles.get("role.work")) {
    return resetToBundled({ ...loc, id: entry.id, expectedPath: entry.path, expectedDigest: entry.contentDigest });
}

function resetRuntimeSelected(loc, entry = loadCatalog(loc).roles.get("role.work")) {
    return resetRuntimeToBundled({ ...loc, id: entry.id, expectedPath: entry.path, expectedDigest: entry.contentDigest });
}

function runtimeMarkdown(body, defaults) {
    return markdown(body).replace("defaults:\n  model: openai/alpha\n  effort: high\n",
        Object.keys(defaults).length ? `defaults:\n${Object.entries(defaults).map(([key, value]) => `  ${key}: ${value}\n`).join("")}` : "");
}

test("runtime reset restores bundled model and effort without changing custom Markdown or sibling preferences", t => {
    const f = fixture(t);
    const catalog = join(f.loc.userRoot, "agents");
    const original = runtimeMarkdown("Custom instructions.\r\n", { model: "openai/user", effort: "low", tier: "efficient" });
    writeFileSync(f.path, original);
    writeCatalogPreferences(catalog, "role.work", { model: "openai/saved", effort: "max" });
    writeCatalogPreferences(catalog, "role.sibling", { model: "openai/sibling", effort: null });
    const bundledPath = join(f.loc.bundledRoot, "worker.md");
    const bundled = readFileSync(bundledPath);
    const held = loadCatalog(f.loc);
    const result = resetRuntimeSelected(f.loc, held.roles.get("role.work"));
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(result.path, join(catalog, "settings.json"));
    assert.deepEqual(readFileSync(f.path), Buffer.from(original));
    assert.deepEqual(readFileSync(bundledPath), bundled);
    assert.deepEqual(readdirSync(f.roles), ["worker.md"], "no backup was created");
    assert.deepEqual(readdirSync(f.loc.bundledRoot), ["worker.md"]);
    assert.deepEqual(readCatalogPreferences(catalog).settings, {
        "role.work": { bundled: true },
        "role.sibling": { model: "openai/sibling", effort: null },
    });
    const fresh = loadCatalog(f.loc);
    const view = inspectCatalog(fresh, "role.work");
    assert.equal(fresh.roles.get("role.work").scope, "user");
    assert.equal(view.instructions.trim(), "Custom instructions.");
    assert.equal(view.fields.model.value, "openai/alpha");
    assert.equal(view.fields.effort.value, "high");
    assert.equal(view.fields.tier.value, "efficient");
    assert.equal(inspectCatalog(held, "role.work").fields.model.value, "openai/saved");
});

for (const [name, user, bundled] of [
    ["matching legacy values", { model: "openai/alpha", effort: "high" }, { model: "openai/alpha", effort: "high" }],
    ["absent legacy values", {}, { model: "openai/alpha", effort: "high" }],
    ["only model differs", { model: "openai/user", effort: "high" }, { model: "openai/alpha", effort: "high" }],
    ["only effort differs", { model: "openai/alpha", effort: "low" }, { model: "openai/alpha", effort: "high" }],
    ["bundled model absent", { model: "openai/user", effort: "high" }, { effort: "high" }],
    ["bundled effort absent", { model: "openai/alpha", effort: "low" }, { model: "openai/alpha" }],
    ["both bundled fields absent", { model: "openai/user", effort: "low" }, {}],
    ["both legacy and bundled fields absent", {}, {}],
]) test(`runtime reset follows bundled fields: ${name}`, t => {
    const f = fixture(t);
    const catalog = join(f.loc.userRoot, "agents");
    const original = runtimeMarkdown("Keep this prompt.", user);
    writeFileSync(f.path, original);
    writeFileSync(join(f.loc.bundledRoot, "worker.md"), runtimeMarkdown("Bundled prompt.", bundled));
    writeCatalogPreferences(catalog, "role.work", { model: "openai/saved", effort: "max" });
    const result = resetRuntimeSelected(f.loc);
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.deepEqual(readCatalogPreferences(catalog).settings["role.work"], { bundled: true });
    const view = inspectCatalog(loadCatalog(f.loc), "role.work");
    assert.equal(view.fields.model.value, bundled.model ?? null);
    assert.equal(view.fields.effort.value, bundled.effort ?? null);
    assert.equal(readFileSync(f.path, "utf8"), original);
    assert.deepEqual(readdirSync(f.roles), ["worker.md"]);
});

test("runtime reset of a bundled winner clears only its saved preference record", t => {
    const f = fixture(t);
    rmSync(f.path);
    const catalog = join(f.loc.userRoot, "agents");
    writeCatalogPreferences(catalog, "role.work", { model: "openai/saved", effort: null });
    writeCatalogPreferences(catalog, "agent.other", { model: null, effort: "max" });
    const bundledPath = join(f.loc.bundledRoot, "worker.md");
    const original = readFileSync(bundledPath);
    const result = resetRuntimeSelected(f.loc);
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.deepEqual(readCatalogPreferences(catalog).settings, { "agent.other": { model: null, effort: "max" } });
    assert.deepEqual(readFileSync(bundledPath), original);
    assert.deepEqual(readdirSync(f.roles), []);
    assert.deepEqual(readdirSync(f.loc.bundledRoot), ["worker.md"]);
    const view = inspectCatalog(loadCatalog(f.loc), "role.work");
    assert.equal(view.fields.model.value, "openai/alpha");
    assert.equal(view.fields.effort.value, "high");
});

test("runtime reset of a named agent restores bundled own fields and inherits absent fields", t => {
    const f = fixture(t);
    f.loc.bundledAgentsRoot = join(f.root, "bundled-agents");
    const agents = join(f.loc.userRoot, "agents", "agents");
    mkdirSync(f.loc.bundledAgentsRoot); mkdirSync(agents);
    const bundled = `---\nschema: pi-agent/v1\nkind: agent\nid: agent.specialist\nname: Specialist\nroleId: role.work\ninstructionMode: add\noverrides:\n  model: openai/bundled-agent\n---\nBundled agent prompt.\n`;
    const original = bundled.replace("model: openai/bundled-agent", "model: openai/user-agent\n  effort: low\n  tier: frontier").replace("Bundled agent prompt.", "Custom agent prompt.");
    const path = join(agents, "specialist.md");
    writeFileSync(join(f.loc.bundledAgentsRoot, "specialist.md"), bundled);
    writeFileSync(path, original);
    const catalog = join(f.loc.userRoot, "agents");
    writeCatalogPreferences(catalog, "agent.specialist", { effort: "max" });
    const result = resetRuntimeSelected(f.loc, loadCatalog(f.loc).agents.get("agent.specialist"));
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.deepEqual(readCatalogPreferences(catalog).settings["agent.specialist"], { bundled: true });
    const view = inspectCatalog(loadCatalog(f.loc), "agent.specialist");
    assert.equal(view.fields.model.value, "openai/bundled-agent");
    assert.equal(view.fields.effort.value, "high", "missing bundled effort restores base-role inheritance");
    assert.equal(view.fields.tier.value, "frontier");
    assert.match(view.instructions, /Custom agent prompt/);
    assert.equal(readFileSync(path, "utf8"), original);
    assert.deepEqual(readdirSync(agents), ["specialist.md"]);
});

for (const scope of ["user", "bundled"]) test(`runtime reset rejects active project preferences over a ${scope} winner`, t => {
    const f = fixture(t);
    if (scope === "bundled") rmSync(f.path);
    const catalog = join(f.loc.userRoot, "agents");
    const project = join(f.loc.cwd, ".pi", "agents");
    mkdirSync(project, { recursive: true });
    writeCatalogPreferences(catalog, "role.work", { model: "openai/saved" });
    writeCatalogPreferences(project, "role.work", { effort: null });
    const before = readFileSync(join(catalog, "settings.json"));
    const projectBefore = readFileSync(join(project, "settings.json"));
    const result = resetRuntimeSelected(f.loc);
    assert.equal(result.ok, false);
    assert.match(result.diagnostics[0].message, /Project preferences/);
    assert.deepEqual(readFileSync(join(catalog, "settings.json")), before);
    assert.deepEqual(readFileSync(join(project, "settings.json")), projectBefore);
    assert.deepEqual(readdirSync(f.roles), scope === "user" ? ["worker.md"] : []);
});

test("runtime reset rejects stale selections and project winners before changing preferences", t => {
    const f = fixture(t);
    const catalog = join(f.loc.userRoot, "agents");
    writeCatalogPreferences(catalog, "role.work", { model: "openai/saved" });
    const before = readFileSync(join(catalog, "settings.json"));
    assert.equal(resetRuntimeSelected(f.loc, { ...f.entry, path: join(f.roles, "wrong.md") }).ok, false);
    const changed = markdown("Edited user prompt.");
    writeFileSync(f.path, changed);
    assert.equal(resetRuntimeSelected(f.loc, f.entry).ok, false);
    const projectRoles = join(f.loc.cwd, ".pi", "agents", "roles");
    mkdirSync(projectRoles, { recursive: true });
    const projectPath = join(projectRoles, "worker.md");
    writeFileSync(projectPath, markdown("Project prompt."));
    assert.equal(resetRuntimeSelected(f.loc).ok, false);
    assert.deepEqual(readFileSync(join(catalog, "settings.json")), before);
    assert.equal(readFileSync(f.path, "utf8"), changed);
    assert.equal(readFileSync(projectPath, "utf8"), markdown("Project prompt."));
    assert.deepEqual(readdirSync(f.roles), ["worker.md"]);
});

test("reset to bundled restores model, effort, and instructions while preserving siblings and held snapshots", t => {
    const f = fixture(t);
    const catalog = join(f.loc.userRoot, "agents");
    const original = markdown("Custom user instructions.\r\n").replace("openai/alpha", "openai/user").replace("effort: high", "effort: low");
    writeFileSync(f.path, original);
    const siblingPath = join(f.roles, "sibling.md");
    const sibling = markdown("Sibling instructions.").replace("role.work", "role.sibling");
    writeFileSync(siblingPath, sibling);
    writeCatalogPreferences(catalog, "role.work", { model: "openai/saved", effort: "max" });
    writeCatalogPreferences(catalog, "role.sibling", { model: "openai/sibling", effort: null });
    const held = loadCatalog(f.loc);
    const result = resetSelected(f.loc, held.roles.get("role.work"));
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(existsSync(f.path), false);
    assert.deepEqual(readFileSync(result.backupPath), Buffer.from(original));
    assert.deepEqual(readCatalogPreferences(catalog).settings, { "role.sibling": { model: "openai/sibling", effort: null } });
    assert.equal(readFileSync(siblingPath, "utf8"), sibling);
    const fresh = loadCatalog(f.loc);
    const view = inspectCatalog(fresh, "role.work");
    assert.equal(fresh.roles.get("role.work").scope, "bundled");
    assert.equal(view.fields.model.value, "openai/alpha");
    assert.equal(view.fields.effort.value, "high");
    assert.equal(view.instructions.trim(), "Bundled prompt.");
    assert.equal(inspectCatalog(fresh, "role.sibling").fields.model.value, "openai/sibling");
    assert.equal(inspectCatalog(held, "role.work").fields.model.value, "openai/saved");
    assert.equal(inspectCatalog(held, "role.work").instructions.trim(), "Custom user instructions.");
});

test("a selected bundled definition clears its saved preferences without archiving or rewriting Markdown", t => {
    const f = fixture(t);
    rmSync(f.path);
    const catalog = join(f.loc.userRoot, "agents");
    writeCatalogPreferences(catalog, "role.work", { model: null, effort: "low" });
    writeCatalogPreferences(catalog, "agent.other", { effort: "max" });
    const bundledPath = join(f.loc.bundledRoot, "worker.md");
    const original = readFileSync(bundledPath);
    const result = resetSelected(f.loc);
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(result.backupPath, undefined);
    assert.equal(result.path, join(catalog, "settings.json"));
    assert.deepEqual(readFileSync(bundledPath), original);
    assert.deepEqual(readdirSync(f.loc.bundledRoot), ["worker.md"]);
    assert.deepEqual(readdirSync(f.roles), []);
    assert.deepEqual(readCatalogPreferences(catalog).settings, { "agent.other": { effort: "max" } });
    const view = inspectCatalog(loadCatalog(f.loc), "role.work");
    assert.equal(view.fields.model.value, "openai/alpha");
    assert.equal(view.fields.effort.value, "high");
    assert.equal(view.instructions.trim(), "Bundled prompt.");
});

test("reset to bundled works for named agents without a fixed role list", t => {
    const f = fixture(t);
    f.loc.bundledAgentsRoot = join(f.root, "bundled-agents");
    const userAgents = join(f.loc.userRoot, "agents", "agents");
    mkdirSync(f.loc.bundledAgentsRoot); mkdirSync(userAgents);
    const agent = `---\nschema: pi-agent/v1\nkind: agent\nid: agent.specialist\nname: Specialist\nroleId: role.work\ninstructionMode: add\noverrides:\n  model: openai/bundled-agent\n  effort: medium\n---\nBundled agent prompt.\n`;
    const userPath = join(userAgents, "specialist.md");
    writeFileSync(join(f.loc.bundledAgentsRoot, "specialist.md"), agent);
    writeFileSync(userPath, agent.replace("openai/bundled-agent", "openai/user-agent").replace("Bundled agent", "User agent"));
    writeCatalogPreferences(join(f.loc.userRoot, "agents"), "agent.specialist", { effort: "high" });
    const result = resetSelected(f.loc, loadCatalog(f.loc).agents.get("agent.specialist"));
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(existsSync(userPath), false);
    assert.ok(existsSync(result.backupPath));
    const view = inspectCatalog(loadCatalog(f.loc), "agent.specialist");
    assert.equal(view.fields.model.value, "openai/bundled-agent");
    assert.equal(view.fields.effort.value, "medium");
    assert.match(view.instructions, /Bundled agent prompt/);
    assert.doesNotMatch(view.instructions, /User agent prompt/);
    assert.equal(existsSync(f.path), true, "the base role's user definition remains active");
});

for (const scope of ["user", "bundled"]) test(`reset refuses effective project preferences over a ${scope} definition`, t => {
    const f = fixture(t);
    if (scope === "bundled") rmSync(f.path);
    const user = join(f.loc.userRoot, "agents");
    const project = join(f.loc.cwd, ".pi", "agents");
    mkdirSync(project, { recursive: true });
    writeCatalogPreferences(user, "role.work", { model: "openai/personal" });
    writeCatalogPreferences(project, "role.work", { effort: null });
    const before = readFileSync(join(user, "settings.json"));
    const projectBefore = readFileSync(join(project, "settings.json"));
    const result = resetSelected(f.loc);
    assert.equal(result.ok, false);
    assert.match(result.diagnostics[0].message, /Project preferences/);
    assert.deepEqual(readFileSync(join(user, "settings.json")), before);
    assert.deepEqual(readFileSync(join(project, "settings.json")), projectBefore);
    assert.equal(existsSync(f.path), scope === "user");
    assert.ok(readdirSync(f.roles).every(name => !name.endsWith(".backup")));
    const untrusted = resetSelected({ ...f.loc, projectTrusted: false });
    assert.equal(untrusted.ok, true, JSON.stringify(untrusted.diagnostics));
    assert.deepEqual(readFileSync(join(project, "settings.json")), projectBefore, "suppressed project config is untouched");
});

test("reset refuses project winners and stale selections before clearing user preferences", t => {
    const f = fixture(t);
    const catalog = join(f.loc.userRoot, "agents");
    writeCatalogPreferences(catalog, "role.work", { model: "openai/personal" });
    assert.equal(resetSelected(f.loc, { ...f.entry, path: join(f.roles, "wrong.md") }).ok, false);
    writeFileSync(f.path, markdown("Changed user instructions."));
    assert.equal(resetSelected(f.loc, f.entry).ok, false);
    const projectRoles = join(f.loc.cwd, ".pi", "agents", "roles");
    mkdirSync(projectRoles, { recursive: true });
    const projectPath = join(projectRoles, "worker.md");
    writeFileSync(projectPath, markdown("Project instructions."));
    assert.equal(resetSelected(f.loc).ok, false);
    assert.equal(readFileSync(projectPath, "utf8"), markdown("Project instructions."));
    assert.equal(readFileSync(f.path, "utf8"), markdown("Changed user instructions."));
    assert.deepEqual(readCatalogPreferences(catalog).settings["role.work"], { model: "openai/personal" });
});

for (const [kind, reset] of [["combined", resetSelected], ["runtime", resetRuntimeSelected]])
for (const scope of ["user", "bundled"]) test(`invalid, duplicate, symlinked, and stale bundled definitions refuse ${scope} ${kind} reset`, t => {
    const f = fixture(t);
    if (scope === "bundled") rmSync(f.path);
    const entry = loadCatalog(f.loc).roles.get("role.work");
    const catalog = join(f.loc.userRoot, "agents");
    writeCatalogPreferences(catalog, "role.work", { effort: "low" });
    const bundledPath = join(f.loc.bundledRoot, "worker.md");
    const original = readFileSync(bundledPath, "utf8");
    rmSync(bundledPath);
    assert.equal(reset(f.loc, entry).ok, false);
    writeFileSync(bundledPath, original.replace("defaults:", "api_key: secret-test-value\ndefaults:"));
    assert.equal(reset(f.loc, entry).ok, false);
    writeFileSync(bundledPath, original);
    writeFileSync(join(f.loc.bundledRoot, "duplicate.md"), original);
    assert.equal(reset(f.loc, entry).ok, false);
    rmSync(join(f.loc.bundledRoot, "duplicate.md"));
    const external = join(f.root, "external.md");
    writeFileSync(external, original);
    rmSync(bundledPath); symlinkSync(external, bundledPath);
    assert.equal(reset(f.loc, entry).ok, false);
    rmSync(bundledPath); writeFileSync(bundledPath, original);
    if (scope === "bundled") {
        writeFileSync(bundledPath, markdown("New bundled instructions."));
        assert.equal(reset(f.loc, entry).ok, false);
    } else {
        writeFileSync(join(f.roles, "duplicate.md"), markdown("Duplicate user instructions."));
        assert.equal(reset(f.loc, entry).ok, false);
    }
    assert.deepEqual(readCatalogPreferences(catalog).settings["role.work"], { effort: "low" });
    assert.equal(readFileSync(external, "utf8"), original);
    assert.ok(readdirSync(f.roles).every(name => !name.endsWith(".backup")));
});

test("failed reset archive rolls back cleared preferences and preserves a concurrent sibling update", t => {
    const f = fixture(t);
    const catalog = join(f.loc.userRoot, "agents");
    writeCatalogPreferences(catalog, "role.work", { model: "openai/personal", effort: null });
    const original = fs.renameSync;
    fs.renameSync = (source, target) => {
        if (source === f.path) {
            writeCatalogPreferences(catalog, "agent.sibling", { model: "openai/sibling" });
            throw new Error("archive denied");
        }
        return original(source, target);
    };
    syncBuiltinESMExports();
    try {
        const result = resetSelected(f.loc);
        assert.equal(result.ok, false);
        assert.match(result.diagnostics[0].message, /archive denied/);
        assert.equal(readFileSync(f.path, "utf8"), markdown("User prompt."));
        assert.deepEqual(readCatalogPreferences(catalog).settings, {
            "role.work": { model: "openai/personal", effort: null },
            "agent.sibling": { model: "openai/sibling" },
        });
        assert.deepEqual(readdirSync(f.roles), ["worker.md"]);
    } finally { fs.renameSync = original; syncBuiltinESMExports(); }
});

for (const [kind, reset] of [["combined", resetSelected], ["runtime", resetRuntimeSelected]])
for (const scope of ["user", "bundled"]) for (const change of ["user-definition", "bundled-definition", "project-preferences"]) test(`${scope} ${kind} reset preserves settings after a concurrent ${change} change`, t => {
    const f = fixture(t);
    if (scope === "bundled") rmSync(f.path);
    const catalog = join(f.loc.userRoot, "agents");
    writeCatalogPreferences(catalog, "role.work", { model: "openai/personal" });
    const before = readFileSync(join(catalog, "settings.json"));
    const lockfile = createRequire(import.meta.url)("proper-lockfile");
    const original = lockfile.lockSync;
    const originalRename = fs.renameSync;
    let preferenceWrites = 0;
    fs.renameSync = (source, target) => {
        if (target === join(catalog, "settings.json")) preferenceWrites++;
        return originalRename(source, target);
    };
    syncBuiltinESMExports();
    let intercepted = false;
    lockfile.lockSync = (...args) => {
        if (!intercepted) {
            intercepted = true;
            if (change === "user-definition") writeFileSync(f.path, markdown("Concurrent user instructions."));
            if (change === "bundled-definition") writeFileSync(join(f.loc.bundledRoot, "worker.md"), markdown("Concurrent bundled instructions."));
            if (change === "project-preferences") {
                const project = join(f.loc.cwd, ".pi", "agents");
                mkdirSync(project, { recursive: true });
                writeCatalogPreferences(project, "role.work", { effort: "low" });
            }
        }
        return original(...args);
    };
    try {
        const result = reset(f.loc);
        assert.equal(result.ok, false);
        assert.match(result.diagnostics[0].message, /changed while saving|Project preferences/);
        assert.deepEqual(readCatalogPreferences(catalog).settings["role.work"], { model: "openai/personal" });
        if (kind === "runtime" && change === "bundled-definition") {
            assert.equal(preferenceWrites, 0, "changed fallback is rejected before saving");
            assert.deepEqual(readFileSync(join(catalog, "settings.json")), before);
        }
        const userExists = scope === "user" || change === "user-definition";
        assert.equal(existsSync(f.path), userExists);
        assert.deepEqual(readdirSync(f.roles), userExists ? ["worker.md"] : []);
    } finally {
        lockfile.lockSync = original;
        fs.renameSync = originalRename;
        syncBuiltinESMExports();
    }
});