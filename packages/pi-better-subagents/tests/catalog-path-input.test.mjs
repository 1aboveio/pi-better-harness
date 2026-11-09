import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCatalog } from "../catalog-store.ts";
import { presentCatalog, presentCatalogEntry } from "../agent-inspection.ts";
import { createCatalogComponent } from "../catalog-ui.ts";

const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: text => text, inverse: text => text };
const alpha = { name: "alpha", description: "Reviews changes.", path: "/skills/alpha/SKILL.md" };
const beta = { name: "beta", description: "Tests changes.", path: "/skills/beta/SKILL.md" };

function stripAnsi(text) {
    return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b_pi:[^\x07]*\x07/g, "");
}

function selectedText(page) {
    return stripAnsi(page.render(160).join("\n")).split("\n").find((line) => line.trimStart().startsWith("> "))?.trimStart().slice(2).trim();
}

function skillFile(t, name) {
    const dir = mkdtempSync(join(tmpdir(), `catalog-skill-${name}-`));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "SKILL.md");
    writeFileSync(path, "---\nname: draft\n---\n");
    return path;
}

function pickerOpen(page) {
    return /Apply selection|0 checked applies No skill catalog/.test(stripAnsi(page.render(160).join("\n")));
}

function selectEntry(page, text) {
    for (let attempt = 0; attempt < 48; attempt++) page.handleInput("\x1b[A");
    for (let attempt = 0; attempt < 64; attempt++) {
        if ((selectedText(page) ?? "").includes(text)) return;
        page.handleInput("\x1b[B");
    }
    throw new Error(`could not select ${text}; selected ${selectedText(page)}`);
}

function fixture(t, skillPaths, save, discovered = []) {
    const root = mkdtempSync(join(tmpdir(), "catalog-path-input-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const roles = join(root, "roles");
    mkdirSync(roles);
    writeFileSync(join(roles, "role.input.md"), `---\nschema: pi-agent/v1\nkind: role\nid: role.input\nname: Input test\ndefaults:\n  skills:\n${skillPaths.map((path) => `    - ${JSON.stringify(path)}`).join("\n")}\n---\nInspect inputs.\n`);
    const snapshot = loadCatalog({ cwd: root, userRoot: join(root, "user"), bundledRoot: roles, projectTrusted: true });
    const catalog = presentCatalog(snapshot);
    const page = createCatalogComponent(catalog, theme, () => {}, () => {}, "role.input", {
        get: () => catalog, models: () => [], settings: () => ({}), change() {},
        save: () => ({ ok: true, message: "Saved" }), changeSkills: save,
        discoverSkills: () => discovered,
    });
    page.focused = true;
    page.render(100);
    page.handleInput("\x1b[B");
    page.handleInput("\x1b[B");
    page.handleInput("\r");
    // The mode picker starts on the definition's explicit selection.
    page.handleInput("\r");
    assert.ok(pickerOpen(page), stripAnsi(page.render(120).join("\n")));
    return { page, catalog, snapshot };
}

test("a failed skill save keeps the checked draft available for retry", t => {
    const draft = skillFile(t, "draft path");
    const attempts = [];
    const { page } = fixture(t, ["/skills/original/SKILL.md"], (_entry, edit) => {
        attempts.push(edit);
        return attempts.length === 1 ? { ok: false, message: "Definition changed; retry after review." }
            : { ok: true, message: "Saved" };
    });
    selectEntry(page, "original");
    page.handleInput(" ");
    selectEntry(page, "Add skill path");
    page.handleInput("\r");
    page.handleInput("\x15");
    page.handleInput(draft);
    page.handleInput("\r");
    selectEntry(page, "Apply selection");
    page.handleInput("\r");
    const screen = stripAnsi(page.render(120).join("\n"));
    assert.match(screen, /Definition changed/, "failed save must keep the picker open");
    selectEntry(page, "Apply selection");
    page.handleInput("\r");
    assert.deepEqual(attempts.map(edit => edit.paths), [
        [draft], [draft],
    ], "retry must submit the user's unchanged checked draft");
});

test("an existing absolute path containing a comma round-trips through the checkbox picker", t => {
    const path = "/skills/review, final/SKILL.md";
    const attempts = [];
    const { page } = fixture(t, [path], (_entry, edit) => {
        attempts.push(edit);
        return { ok: true, message: "Saved" };
    });
    selectEntry(page, "Apply selection");
    page.handleInput("\r");
    assert.deepEqual(attempts, [{ mode: "explicit", paths: [path] }]);
});

test("filtering keeps checked discovered skills in the catalog picker", t => {
    const attempts = [];
    const { page } = fixture(t, [alpha.path], (_entry, edit) => {
        attempts.push(edit);
        return { ok: true, message: "Saved" };
    }, [alpha, beta]);
    page.handleInput("beta");
    selectEntry(page, "beta");
    page.handleInput(" ");
    selectEntry(page, "Apply selection");
    page.handleInput("\r");
    assert.deepEqual(attempts.at(-1), { mode: "explicit", paths: [alpha.path, beta.path] },
        "alpha stayed checked while the filter hid it");
});

test("zero checked in the catalog picker saves No skill catalog, not discovery", t => {
    const original = "/skills/original/SKILL.md";
    const attempts = [];
    const { page } = fixture(t, [original], (_entry, edit) => {
        attempts.push(edit);
        return { ok: true, message: "Saved" };
    });
    selectEntry(page, "original");
    page.handleInput(" ");
    selectEntry(page, "Apply selection");
    page.handleInput("\r");
    assert.deepEqual(attempts, [{ mode: "none" }]);
});

test("an explicit session empty draft is an error, not none or discovery", t => {
    const root = mkdtempSync(join(tmpdir(), "catalog-empty-draft-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const roles = join(root, "roles");
    mkdirSync(roles);
    writeFileSync(join(roles, "role.empty.md"), "---\nschema: pi-agent/v1\nkind: role\nid: role.empty\nname: Empty\n---\nInspect empty defaults.\n");
    const snapshot = loadCatalog({ cwd: root, userRoot: join(root, "user"), bundledRoot: roles, projectTrusted: true });
    const view = presentCatalogEntry(snapshot, "role.empty", undefined, () => ({
        value: [], source: "session", error: "Selected skills has no paths. Add at least one skill path or choose No skill catalog.",
    }));
    assert.equal(view.skills.effective.mode, "error");
    assert.equal(view.skills.effective.source, "session");
    assert.match(view.skills.effective.error, /Selected skills has no paths/);
    assert.notEqual(view.skills.effective.mode, "none");
    assert.notEqual(view.skills.effective.mode, "discovery");
});
