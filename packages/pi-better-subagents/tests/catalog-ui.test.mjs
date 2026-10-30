import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createCatalogComponent, catalogColumns, catalogDetailLines } from "../catalog-ui.ts";

const theme = { fg: (_color, text) => text };
const entry = (id, name, status = null) => ({
    id,
    identity: { id, name, kind: id.startsWith("role") ? "role" : "agent", scope: "user", path: `/tmp/${id}` },
    role: id.startsWith("agent") ? { id: "role.reviewer", found: true } : undefined,
    launchable: status,
    launchabilityReason: "Model availability is not resolved yet.",
    actualModel: null,
    requestedModel: null,
    actualEffort: null,
    fields: { model: { value: "xai/grok-4.5", source: "role-default" }, effort: { value: null, source: "absent" }, tier: { value: null, source: "absent" } },
    validation: [], shadowed: [], restrictions: [], instructions: "Long instructions ".repeat(20),
});

describe("catalog command surface", () => {
    it("colors labels separately from values without changing content or column widths", () => {
        const agent = entry("agent.payments", "Payments Analyst");
        agent.instructionMode = "add";
        const colors = { muted: "\x1b[90m", dim: "\x1b[2m", accent: "\x1b[36m" };
        const coloredTheme = { fg: (color, text) => `${colors[color] ?? ""}${text}\x1b[0m` };
        for (const width of [24, 42, 90, 120]) {
            const plain = catalogDetailLines(agent, false, width);
            const colored = catalogDetailLines(agent, false, width, [], coloredTheme);
            const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");
            assert.equal(colored.map(strip).join("").replace(/\s+/g, ""), plain.join("").replace(/\s+/g, ""));
            assert.ok(colored.every((row) => visibleWidth(row) <= width));
            assert.ok(colored.some((row) => /\x1b\[90mID\s+\x1b\[0magent/.test(row)));
        }
        const wide = catalogDetailLines(agent, false, 120, [], coloredTheme).join("\n");
        assert.match(wide, /\x1b\[90mInstructions\s+\x1b\[0madd/);
        assert.match(wide, /\x1b\[90m  Model\s+\x1b\[0mxai\/grok/);
        assert.match(wide, /\x1b\[2minherited\x1b\[0m/);
    });

    it("shows the resolved prompt inline and keeps long definition details readable across widths", () => {
        const agent = entry(`agent.${"long-identity-".repeat(6)}`, "Payments Analyst");
        agent.instructions = "Role instructions.\n\nNamed agent instructions.";
        agent.identity.path = `/tmp/${"long-directory/".repeat(10)}agent.md`;
        for (const width of [24, 42, 90, 120]) {
            const lines = catalogDetailLines(agent, false, width);
            assert.ok(lines.every((line) => visibleWidth(line) <= width));
            const compact = lines.join("").replace(/\s+/g, "");
            const identityRows = lines.slice(lines.findIndex((row) => /ID\s+agent/.test(row)), lines.findIndex((row) => /Kind\s+agent/.test(row)));
            const identity = identityRows.map((row) => width >= 90 ? row.slice(2, 2 + Math.floor((width - 8) / 2)) : row)
                .join("").replace(/^\s*ID\s+/, "").replace(/\s+/g, "");
            assert.equal(identity, agent.id, `complete identity at ${width} columns`);
            assert.ok(compact.includes(agent.identity.path), `complete source path at ${width} columns`);
            assert.ok(compact.includes(agent.instructions.replace(/\s+/g, "")), `resolved prompt at ${width} columns`);
        }
        const component = createCatalogComponent({ entries: [agent], diagnostics: [] }, theme, () => {}, () => {}, agent.id, undefined, () => 40);
        assert.match(component.render(100).join("\n"), /Role instructions/);
        const wide = catalogDetailLines(agent, false, 120);
        assert.match(wide.find((row) => /Status/.test(row)), /ID\s+agent\..*Status\s+unresolved/);
        const model = wide.find((row) => /Model\s+xai/.test(row));
        const effort = wide.find((row) => /Effort\s+\(unset\)/.test(row));
        assert.equal(model.indexOf("xai"), effort.indexOf("(unset)"));
        assert.equal(model.indexOf("inherited"), effort.indexOf("absent"));
    });

    it("filters by name or role, inspects, scrolls, and returns without closing", () => {
        const rows = [entry("role.reviewer", "Reviewer"), entry("agent.payments", "Payments Analyst", false)];
        let closed = 0;
        const component = createCatalogComponent({ entries: rows, diagnostics: [], revision: "", text: "" }, theme, () => {}, () => { closed++; });
        component.handleInput("P");
        assert.match(component.render(60).join("\n"), /Payments Analyst/);
        assert.doesNotMatch(component.render(60).join("\n"), /› Reviewer/);
        component.handleInput("\r");
        assert.match(component.render(60).join("\n"), /blocked/);
        assert.match(component.render(60).join("\n"), /inherited/);
        component.handleInput("p");
        assert.match(component.render(60).join("\n"), /Agents \/ prompt/);
        assert.match(component.render(60).join("\n"), /Long instructions/);
        component.handleInput("\x1b");
        assert.match(component.render(60).join("\n"), /Agents \/ inspect/);
        component.handleInput("\x1b[B");
        component.handleInput("\x1b");
        assert.match(component.render(60).join("\n"), /Search  P/);
        component.handleInput("\x1b");
        assert.match(component.render(60).join("\n"), /Reviewer/);
        component.handleInput("\x1b");
        assert.equal(closed, 1);
    });

    it("reaches the last detail rows after editable settings wrap in a short terminal", () => {
        const agent = entry("agent.payments", "Payments Analyst");
        agent.fields.model.value = "provider/" + "long-model-name".repeat(8);
        agent.restrictions = [{ honored: false, name: "final-restriction" }];
        const catalog = { entries: [agent], diagnostics: [] };
        const editor = { get: () => catalog, models: () => [], settings: () => ({}), change() {}, save: () => ({ ok: true, message: "saved" }) };
        const component = createCatalogComponent(catalog, theme, () => {}, () => {}, agent.id, editor, () => 12);
        for (let i = 0; i < 250; i++) {
            component.handleInput("\x1b[B");
            component.render(42);
        }
        assert.match(component.render(42).join("\n"), /final-restriction/);
        component.handleInput("e");
        assert.match(component.render(100).join("\n"), /Payments Analyst/);
    });

    it("reveals and selects both editable fields in a short terminal", () => {
        const agent = entry("agent.payments", "Payments Analyst");
        agent.definitionValid = true;
        const catalog = { entries: [agent], diagnostics: [] };
        const editor = { get: () => catalog, models: () => [], settings: () => ({}), change() {}, save: () => ({ ok: true, message: "saved" }) };
        const component = createCatalogComponent(catalog, theme, () => {}, () => {}, agent.id, editor, () => 12);
        component.render(42);
        component.handleInput("\x1b[B");
        assert.match(component.render(42).join("\n"), /> Effort/);
        component.handleInput("\r");
        assert.match(component.render(42).join("\n"), /Agents \/ effort/);
        component.handleInput("\x1b");
        component.render(42);
        component.handleInput("\x1b[A");
        assert.match(component.render(42).join("\n"), /> Model/);
        component.handleInput("\r");
        assert.match(component.render(42).join("\n"), /Agents \/ model/);
        component.handleInput("\x1b");
        component.handleInput("e");
        assert.match(component.render(42).join("\n"), /> Model/);
    });

    it("aligns model, effort, source, and state columns and keeps model at narrow widths", () => {
        const role = entry("role.reviewer", "Reviewer");
        const agent = entry("agent.payments", "Payments Analyst", false);
        agent.actualModel = "openai/gpt-6-astra";
        role.fields.effort.value = "medium";
        agent.fields.effort.value = "xhigh";
        agent.actualEffort = "high";
        const header = catalogColumns(null, 90);
        const roleRow = catalogColumns(role, 90);
        const agentRow = catalogColumns(agent, 90);
        assert.equal(header.indexOf("MODEL"), roleRow.indexOf("xai/grok-4.5"));
        assert.equal(header.indexOf("MODEL"), agentRow.indexOf("openai/gpt-6-astra"));
        assert.equal(header.indexOf("EFFORT"), roleRow.indexOf("medium"));
        assert.equal(header.indexOf("EFFORT"), agentRow.indexOf("high"));
        assert.match(catalogColumns(entry("role.unset", "Unset"), 90), /\(unset\)/);
        assert.equal(header.indexOf("SOURCE"), agentRow.indexOf("user"));
        assert.equal(header.indexOf("STATE"), agentRow.indexOf("blocked"));
        assert.match(catalogColumns(agent, 42), /openai\/gpt-6-astra/);
        assert.match(catalogColumns(agent, 42), /high/);
        for (const width of [20, 34, 42, 60, 80, 90, 140]) {
            assert.ok(visibleWidth(catalogColumns(agent, width)) <= width - 2);
        }
    });

    it("fills the viewport and resizes list and prompt content with terminal height", () => {
        const rows = Array.from({ length: 60 }, (_, i) => entry(`agent.${i}`, `Agent ${i}`));
        rows[0].instructions = Array.from({ length: 100 }, (_, i) => `Instruction ${i}`).join("\n");
        let height = 40;
        const component = createCatalogComponent({ entries: rows, diagnostics: [] }, theme, () => {}, () => {}, undefined, undefined, () => height);
        let lines = component.render(100);
        assert.equal(lines.length, 40);
        assert.match(lines.join("\n"), /Agent 30/);
        height = 24;
        lines = component.render(40);
        assert.equal(lines.length, 24);
        assert.doesNotMatch(lines.join("\n"), /Agent 30/);
        for (let i = 0; i < 50; i++) component.handleInput("\x1b[B");
        assert.match(component.render(100).join("\n"), /› Agent 50/);
        for (let i = 0; i < 50; i++) component.handleInput("\x1b[A");
        component.handleInput("\r");
        assert.equal(component.render(40).length, height);
        component.handleInput("p");
        height = 40;
        lines = component.render(100);
        assert.match(lines.join("\n"), /Instruction 30/);
        height = 24;
        lines = component.render(40);
        assert.equal(lines.length, height);
        assert.doesNotMatch(lines.join("\n"), /Instruction 30/);
        assert.ok(lines.every((line) => visibleWidth(line) <= 40));
    });

    it("shows the complete resolved prompt in its own scrollable view", () => {
        const agent = entry("agent.payments", "Payments Analyst");
        agent.instructions = `Role instruction.\n\n${"Agent instruction. ".repeat(100)}`;
        const component = createCatalogComponent({ entries: [agent], diagnostics: [], revision: "", text: "" }, theme, () => {}, () => {}, agent.id);
        assert.match(component.render(60).join("\n"), /p prompt/);
        component.handleInput("p");
        assert.match(component.render(60).join("\n"), /Role instruction/);
        for (let i = 0; i < 23; i++) component.handleInput("\x1b[B");
        assert.match(component.render(60).join("\n"), /Agent instruction/);
    });

    it("keeps selected results visible and wraps detail within narrow terminal widths", () => {
        const rows = Array.from({ length: 24 }, (_, i) => entry(`agent.${i}`, `Agent ${i}`));
        const component = createCatalogComponent({ entries: rows, diagnostics: [], revision: "", text: "" }, theme, () => {}, () => {});
        for (let i = 0; i < 20; i++) component.handleInput("\x1b[B");
        assert.match(component.render(42).join("\n"), /› Agent 20/);
        component.handleInput("\r");
        assert.ok(component.render(42).every((line) => visibleWidth(line) <= 42));
    });

    it("offers only session-scoped models and leaves an out-of-scope saved value in the detail", () => {
        const agent = entry("agent.payments", "Payments Analyst");
        agent.definitionValid = true;
        agent.fields.model.value = "openai/alpha";
        const catalog = { entries: [agent], diagnostics: [] };
        const changes = [];
        const editor = {
            get: () => catalog,
            models: () => ["openai/alpha", "openai/beta", "openai/gamma"],
            scopedModels: () => [{ model: { provider: "openai", id: "beta" } }, { model: { provider: "anthropic", id: "claude-9" } }],
            settings: () => ({}),
            change: (id, key, value) => { changes.push([id, key, value]); },
            save: () => ({ ok: true, message: "saved" }),
        };
        const component = createCatalogComponent(catalog, theme, () => {}, () => {}, agent.id, editor, () => 40);
        component.render(90);
        component.handleInput("\r");
        const picker = component.render(90).join("\n");
        assert.match(picker, /Agents \/ model/);
        assert.match(picker, /Session model scope · 2 models · saved value is outside this scope/);
        assert.match(picker, /openai\/beta/);
        assert.match(picker, /anthropic\/claude-9/);
        assert.doesNotMatch(picker, /openai\/gamma/);
        assert.doesNotMatch(picker, /openai\/alpha/, "the out-of-scope saved value is not offered");
        assert.match(picker, /→ openai\/beta/, "the first scoped model starts selected, not Inherit");
        component.handleInput("beta");
        assert.doesNotMatch(component.render(90).join("\n"), /anthropic\/claude-9/);
        component.handleInput("\r");
        assert.deepEqual(changes, [["agent.payments", "model", "openai/beta"]]);
        assert.match(component.render(90).join("\n"), /Session settings updated/);
        // The saved value stays on the definition and in the detail view.
        assert.equal(agent.fields.model.value, "openai/alpha");
        assert.match(component.render(90).join("\n"), /Model\s+openai\/alpha/);
    });

    it("falls back to available models when the session has no model scope", () => {
        const agent = entry("agent.payments", "Payments Analyst");
        agent.definitionValid = true;
        const catalog = { entries: [agent], diagnostics: [] };
        const editor = (scopedModels) => ({
            get: () => catalog,
            models: () => ["openai/alpha", "openai/gamma"],
            ...(scopedModels ? { scopedModels } : {}),
            settings: () => ({}),
            change() {},
            save: () => ({ ok: true, message: "saved" }),
        });
        for (const candidate of [editor(() => []), editor(undefined)]) {
            const component = createCatalogComponent(catalog, theme, () => {}, () => {}, agent.id, candidate, () => 40);
            component.render(90);
            component.handleInput("\r");
            const picker = component.render(90).join("\n");
            assert.match(picker, /All available models · no session scope/);
            assert.match(picker, /openai\/alpha/);
            assert.match(picker, /openai\/gamma/);
            component.handleInput("\x1b");
            assert.doesNotMatch(component.render(90).join("\n"), /All available models/);
            // Effort stays a local list and never shows a model scope note.
            component.handleInput("\x1b[B");
            component.handleInput("\r");
            const effort = component.render(90).join("\n");
            assert.match(effort, /Agents \/ effort/);
            assert.doesNotMatch(effort, /session scope/);
        }
    });
});