import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createSubagentSettingsPage } from "../settings-page.ts";

const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text, inverse: (text) => text };

function harness({ openAgents = true } = {}) {
    let current = { mode: "adaptive", maxConcurrent: 4, modeSource: "config", capSource: "config", defaultMode: "adaptive", defaultCap: 4 };
    let saved = 0;
    let closed = 0;
    let agents = 0;
    let saveFailure = false;
    const handlers = {
        get: () => current,
        changeMode(mode) { current = { ...current, mode, modeSource: "session" }; },
        changeCap(maxConcurrent) { current = { ...current, maxConcurrent, capSource: "session" }; },
        save() {
            if (saveFailure) return { ok: false, message: "Read-only config." };
            saved++;
            current = { ...current, defaultMode: current.mode, defaultCap: current.maxConcurrent, modeSource: "config", capSource: "config" };
            return { ok: true, message: "Subagent defaults saved." };
        },
        reset() { current = { ...current, mode: current.defaultMode, maxConcurrent: current.defaultCap, modeSource: "config", capSource: "config" }; },
    };
    if (openAgents) handlers.openAgents = () => { agents++; };
    const page = createSubagentSettingsPage(theme, handlers, () => {}, () => { closed++; });
    page.focused = true;
    return { page, settings: () => current, saved: () => saved, closed: () => closed, agents: () => agents, failSave: () => { saveFailure = true; } };
}

const LABELS = ["Delegation mode", "Concurrent subagents", "Agents", "Reset to defaults"];

function rowLabels(page) {
    return page.render(100).flatMap((line) => {
        const text = line.trimStart().replace(/^> /, "");
        const label = LABELS.find((name) => text.startsWith(name));
        return label ? [label] : [];
    });
}

function selectedRow(page) {
    return page.render(100).find((line) => line.trimStart().startsWith("> "))?.trimStart().slice(2).trim();
}

function enterCap(page, value) {
    page.handleInput("\r");
    page.handleInput("\x15");
    page.handleInput(value);
    page.handleInput("\r");
}

test("settings page changes session mode and numeric cap, saves both, and resets", () => {
    const h = harness();
    h.page.handleInput("\r");
    assert.equal(h.settings().mode, "coordinator");
    assert.equal(h.saved(), 0, "editing applies only to the session");
    h.page.handleInput("\x1b[B");
    enterCap(h.page, "7");
    assert.equal(h.settings().maxConcurrent, 7);
    assert.equal(h.settings().capSource, "session");
    assert.equal(h.saved(), 0, "cap changes do not save defaults");
    h.page.handleInput("\x13");
    assert.equal(h.saved(), 1);
    assert.equal(h.settings().defaultCap, 7);
    assert.equal(h.settings().defaultMode, "coordinator");
    enterCap(h.page, "2");
    h.page.handleInput("\x1b[B");
    h.page.handleInput("\x1b[B");
    h.page.handleInput("\r");
    assert.equal(h.settings().maxConcurrent, 7);
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

test("failed save keeps session choices and narrow rendering fits the terminal", () => {
    const h = harness();
    h.page.handleInput("\r");
    h.failSave();
    h.page.handleInput("\x13");
    assert.equal(h.saved(), 0);
    assert.equal(h.settings().mode, "coordinator");
    assert.equal(h.settings().modeSource, "session");
    assert.match(h.page.render(80).join("\n"), /Read-only config/);
    for (const width of [1, 10, 20, 40, 59, 60, 80, 120]) {
        for (const line of h.page.render(width)) assert.ok(visibleWidth(line) <= width);
    }
    h.page.handleInput("\x1b[B");
    h.page.handleInput("\r");
    for (const line of h.page.render(20)) assert.ok(visibleWidth(line) <= 20);
});

test("Agents row opens the catalog action without touching or saving settings", () => {
    const h = harness();
    h.page.handleInput("\r"); // session mode -> coordinator
    h.page.handleInput("\x13"); // save defaults
    const before = h.settings();
    h.page.handleInput("\x1b[B");
    h.page.handleInput("\x1b[B");
    assert.equal(selectedRow(h.page), "Agents");
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
    assert.deepEqual(rowLabels(h.page), ["Delegation mode", "Concurrent subagents", "Agents", "Reset to defaults"]);
    h.page.handleInput("\r"); // session mode -> coordinator
    h.page.handleInput("\x1b[B");
    h.page.handleInput("\x1b[B");
    h.page.handleInput("\r");
    assert.equal(h.agents(), 1);
    assert.equal(h.settings().mode, "coordinator", "Agents is not the reset action");
    h.page.handleInput("\x1b[B");
    assert.equal(selectedRow(h.page), "Reset to defaults");
    h.page.handleInput("\r");
    assert.equal(h.settings().mode, "adaptive");
    assert.equal(h.agents(), 1);
});

test("Agents row stays inert when its handler is not provided", () => {
    const h = harness({ openAgents: false });
    const before = h.settings();
    h.page.handleInput("\x1b[B");
    h.page.handleInput("\x1b[B");
    h.page.handleInput("\r");
    assert.deepEqual(h.settings(), before);
    assert.equal(h.saved(), 0);
    assert.equal(h.closed(), 0);
});
