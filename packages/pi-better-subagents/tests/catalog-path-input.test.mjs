import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCatalog } from "../catalog-store.ts";
import { presentCatalog } from "../agent-inspection.ts";
import { createCatalogComponent } from "../catalog-ui.ts";

const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: text => text, inverse: text => text };

function fixture(t, skillPath, save) {
    const root = mkdtempSync(join(tmpdir(), "catalog-path-input-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const roles = join(root, "roles");
    mkdirSync(roles);
    writeFileSync(join(roles, "role.input.md"), `---\nschema: pi-agent/v1\nkind: role\nid: role.input\nname: Input test\ndefaults:\n  skills:\n    - ${JSON.stringify(skillPath)}\n---\nInspect inputs.\n`);
    const catalog = presentCatalog(loadCatalog({ cwd: root, userRoot: join(root, "user"), bundledRoot: roles, projectTrusted: true }));
    const page = createCatalogComponent(catalog, theme, () => {}, () => {}, "role.input", {
        get: () => catalog, models: () => [], settings: () => ({}), change() {},
        save: () => ({ ok: true, message: "Saved" }), changeSkills: save,
    });
    page.focused = true;
    page.render(100);
    page.handleInput("\x1b[B");
    page.handleInput("\x1b[B");
    page.handleInput("\r");
    // The existing explicit selection is highlighted in the picker.
    page.handleInput("\r");
    assert.match(page.render(100).join("\n"), /skills · selected/);
    return page;
}

test("a failed skill save keeps the editable draft available for retry", t => {
    const attempts = [];
    const page = fixture(t, "/skills/original/SKILL.md", (_entry, edit) => {
        attempts.push(edit);
        return attempts.length === 1 ? { ok: false, message: "Definition changed; retry after review." }
            : { ok: true, message: "Saved" };
    });
    page.handleInput("\x15");
    page.handleInput("/skills/new draft/SKILL.md");
    page.handleInput("\r");
    const screen = page.render(120).join("\n");
    assert.match(screen, /skills · selected/, "failed save must keep the path editor open");
    assert.match(screen, /Definition changed/);
    page.handleInput("\r");
    assert.deepEqual(attempts.map(edit => edit.paths), [
        ["/skills/new draft/SKILL.md"], ["/skills/new draft/SKILL.md"],
    ], "retry must submit the user's unchanged draft");
});

test("an existing absolute path containing a comma round-trips through the editor", t => {
    const path = "/skills/review, final/SKILL.md";
    const attempts = [];
    const page = fixture(t, path, (_entry, edit) => {
        attempts.push(edit);
        return { ok: true, message: "Saved" };
    });
    page.handleInput("\r");
    assert.deepEqual(attempts, [{ mode: "explicit", paths: [path] }]);
});
