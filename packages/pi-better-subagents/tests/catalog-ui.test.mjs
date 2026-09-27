import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createCatalogComponent, catalogColumns } from "../catalog-ui.ts";

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

    it("aligns model, source, and state columns and keeps model at narrow widths", () => {
        const role = entry("role.reviewer", "Reviewer");
        const agent = entry("agent.payments", "Payments Analyst", false);
        agent.actualModel = "openai/gpt-6-astra";
        const header = catalogColumns(null, 90);
        const roleRow = catalogColumns(role, 90);
        const agentRow = catalogColumns(agent, 90);
        assert.equal(header.indexOf("MODEL"), roleRow.indexOf("xai/grok-4.5"));
        assert.equal(header.indexOf("MODEL"), agentRow.indexOf("openai/gpt-6-astra"));
        assert.equal(header.indexOf("SOURCE"), agentRow.indexOf("user"));
        assert.equal(header.indexOf("STATE"), agentRow.indexOf("blocked"));
        assert.match(catalogColumns(agent, 42), /openai\/gpt-6-astra/);
        assert.ok(visibleWidth(catalogColumns(agent, 42)) <= 40);
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
});