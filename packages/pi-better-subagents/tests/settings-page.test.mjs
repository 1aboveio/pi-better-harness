import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createSubagentSettingsPage } from "../settings-page.ts";

const theme = { fg: (_color, text) => text, bold: (text) => text };

function harness() {
    let current = { mode: "adaptive", maxConcurrent: 4, modeSource: "config", capSource: "config", defaultMode: "adaptive", defaultCap: 4 };
    let saved = 0;
    let closed = 0;
    let saveFailure = false;
    const page = createSubagentSettingsPage(theme, {
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
    }, () => {}, () => { closed++; });
    page.focused = true;
    return { page, settings: () => current, saved: () => saved, closed: () => closed, failSave: () => { saveFailure = true; } };
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
    h.page.handleInput("\x1b[B");
    enterCap(h.page, "7");
    assert.equal(h.settings().maxConcurrent, 7);
    assert.equal(h.settings().capSource, "session");
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

test("failed save keeps session choices and narrow rendering fits the terminal", () => {
    const h = harness();
    h.page.handleInput("\r");
    h.failSave();
    h.page.handleInput("\x13");
    assert.equal(h.saved(), 0);
    assert.equal(h.settings().mode, "coordinator");
    assert.equal(h.settings().modeSource, "session");
    assert.match(h.page.render(80).join("\n"), /Read-only config/);
    for (const width of [20, 40, 80, 120]) {
        for (const line of h.page.render(width)) assert.ok(visibleWidth(line) <= width);
    }
    h.page.handleInput("\x1b[B");
    h.page.handleInput("\r");
    for (const line of h.page.render(20)) assert.ok(visibleWidth(line) <= 20);
});
