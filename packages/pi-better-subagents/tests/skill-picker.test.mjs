import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createSkillPicker } from "../skill-picker.ts";

const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text, inverse: (text) => text };
const alpha = { name: "alpha", description: "Reviews changes.", path: "/skills/alpha/SKILL.md" };
const beta = { name: "beta", description: "Tests changes.", path: "/skills/beta/SKILL.md" };

function stripAnsi(text) {
    return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b_pi:[^\x07]*\x07/g, "");
}

function harness({ skills = [alpha, beta], selected = [], height = 20 } = {}) {
    const applies = [];
    let finished = 0;
    let cancelled = 0;
    const picker = createSkillPicker({
        theme, skills, selected, getHeight: () => typeof height === "function" ? height() : height,
        requestRender() {}, finish() { finished++; }, cancel() { cancelled++; },
        apply(paths) { applies.push([...paths]); return { ok: true }; },
    });
    picker.focused = true;
    return { picker, applies, finished: () => finished, cancelled: () => cancelled };
}

function selectedText(picker) {
    return stripAnsi(picker.render(160).join("\n")).split("\n").find((line) => line.trimStart().startsWith("> "))?.trimStart().slice(2).trim();
}

function selectEntry(picker, text) {
    for (let attempt = 0; attempt < 48; attempt++) picker.handleInput("\x1b[A");
    for (let attempt = 0; attempt < 64; attempt++) {
        if ((selectedText(picker) ?? "").includes(text)) return;
        picker.handleInput("\x1b[B");
    }
    throw new Error(`could not select ${text}; selected ${selectedText(picker)}`);
}

test("filtering hides rows without losing checked skills", () => {
    const h = harness();
    assert.match(stripAnsi(h.picker.render(100).join("\n")), /\[ \] alpha/);
    h.picker.handleInput(" ");
    assert.match(stripAnsi(h.picker.render(100).join("\n")), /\[x\] alpha/);
    h.picker.handleInput("beta");
    const screen = stripAnsi(h.picker.render(100).join("\n"));
    assert.doesNotMatch(screen, /alpha/);
    assert.match(screen, /1 checked hidden by filter/);
    h.picker.handleInput("\r");
    assert.deepEqual(h.applies, [[alpha.path]]);
    assert.equal(h.finished(), 1);
});

test("Escape cancels without applying or saving a draft", () => {
    const h = harness();
    h.picker.handleInput(" ");
    h.picker.handleInput("\x1b");
    assert.deepEqual(h.applies, []);
    assert.equal(h.finished(), 0);
    assert.equal(h.cancelled(), 1);
});

test("saved paths absent from discovery stay unavailable and survive apply", () => {
    const legacy = "/skills/legacy, archived/SKILL.md";
    const h = harness({ selected: [legacy] });
    assert.match(stripAnsi(h.picker.render(120).join("\n")), /\(unavailable\)/);
    selectEntry(h.picker, "alpha");
    h.picker.handleInput(" ");
    selectEntry(h.picker, "Apply selection");
    h.picker.handleInput("\r");
    assert.deepEqual(h.applies, [[legacy, alpha.path]]);
});

test("unavailable saved paths can be unchecked and checked again before applying", () => {
    const legacy = "/skills/legacy, archived/SKILL.md";
    const h = harness({ selected: [legacy] });
    selectEntry(h.picker, "unavailable");
    h.picker.handleInput(" ");
    assert.match(stripAnsi(h.picker.render(120).join("\n")), /\[ \].*\(unavailable\)/);
    h.picker.handleInput(" ");
    assert.match(stripAnsi(h.picker.render(120).join("\n")), /\[x\].*\(unavailable\)/);
    h.picker.handleInput("\r");
    assert.deepEqual(h.applies, [[legacy]]);
});

test("Enter with zero checked applies an explicit empty list", () => {
    const h = harness({ skills: [] });
    h.picker.handleInput("\r");
    assert.deepEqual(h.applies, [[]]);
    assert.equal(h.finished(), 1);
});

test("manual Add skill path validates and accepts commas and spaces", (t) => {
    const root = mkdtempSync(join(tmpdir(), "skill-picker-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "review, final SKILL.md");
    writeFileSync(path, "---\nname: review\n---\n");
    const h = harness({ skills: [], selected: [] });

    selectEntry(h.picker, "Add skill path");
    h.picker.handleInput("\r");
    h.picker.handleInput("relative/SKILL.md");
    h.picker.handleInput("\r");
    assert.match(stripAnsi(h.picker.render(120).join("\n")), /absolute path/);
    h.picker.handleInput("\x1b");

    selectEntry(h.picker, "Add skill path");
    h.picker.handleInput("\r");
    h.picker.handleInput(join(root, "missing SKILL.md"));
    h.picker.handleInput("\r");
    assert.match(stripAnsi(h.picker.render(120).join("\n")), /No file or directory/);
    h.picker.handleInput("\x1b");

    selectEntry(h.picker, "Add skill path");
    h.picker.handleInput("\r");
    h.picker.handleInput(path);
    h.picker.handleInput("\r");
    assert.match(stripAnsi(h.picker.render(120).join("\n")), /Skill path added/);
    selectEntry(h.picker, "Add skill path");
    h.picker.handleInput("\r");
    h.picker.handleInput(path);
    h.picker.handleInput("\r");
    assert.match(stripAnsi(h.picker.render(120).join("\n")), /already selected/);
    h.picker.handleInput("\x1b");
    selectEntry(h.picker, "Apply selection");
    h.picker.handleInput("\r");
    assert.deepEqual(h.applies, [[path]]);
});

test("empty and unmatched lists keep the selected action visible in a short viewport", () => {
    for (const skills of [[], [alpha]]) {
        const h = harness({ skills, height: 7 });
        if (skills.length) h.picker.handleInput("no-match");
        h.picker.handleInput("\x1b[B");
        const screen = stripAnsi(h.picker.render(100).join("\n"));
        assert.match(screen, /> \+ Add skill path/);
        h.picker.handleInput("\r");
        h.picker.handleInput("/skills/draft");
        assert.match(stripAnsi(h.picker.render(100).join("\n")), /\/skills\/draft/);
    }
});

test("very short windows retain the selected control and active path input", () => {
    let height = 20;
    const h = harness({ skills: [], height: () => height });
    selectEntry(h.picker, "Add skill path");
    height = 2;
    assert.match(stripAnsi(h.picker.render(100).join("\n")), /> \+ Add skill path/);
    h.picker.handleInput("\r");
    h.picker.handleInput("/skills/draft");
    for (const rows of [1, 2, 5]) {
        height = rows;
        const screen = h.picker.render(100);
        assert.ok(screen.length <= rows);
        assert.match(stripAnsi(screen.join("\n")), /\/skills\/draft/);
    }
});

test("checkbox rows fit narrow and normal terminal widths", () => {
    const h = harness({ selected: ["/skills/legacy, archived/SKILL.md"] });
    for (const width of [1, 10, 20, 40, 60, 100]) {
        for (const line of h.picker.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${JSON.stringify(line)}`);
    }
    assert.match(stripAnsi(h.picker.render(120).join("\n")), /\[ \] alpha\s+Reviews changes\./);
    assert.match(stripAnsi(h.picker.render(40).join("\n")), /Reviews changes/);
});
