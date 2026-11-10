import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderCompactTaskHeader } from "../../extensions/task-context/compact-task-header.js";
import { changeOutcomeTodoPreference, parseOutcomeTodoPreferences } from "../../extensions/task-context/preferences.js";

const theme = { fg: (_color: string, value: string) => value };

test("the task header groups its subtitle with progress and runtime without changing saved text", () => {
  const subtitle = "Deliver checkout\nwith a working\t支付 flow";
  for (const width of [1, 4, 8, 20, 40, 80, 120]) {
    const lines = renderCompactTaskHeader("2/8 complete", width, theme, { subtitle, disclosure: "▸", runtime: { status: "active", clock: "2:14" } });
    assert.equal(lines.length, 3);
    assert.ok(lines.every(line => visibleWidth(line) <= width), `fits ${width} terminal cells`);
    if (width >= 40) {
      assert.match(lines[0]!, /^todo ▸  2\/8 complete\s+active  2:14$/);
      assert.equal(lines[2], "");
    }
    if (width >= 80) assert.equal(lines[1], "  Deliver checkout with a working 支付 flow");
  }
  assert.equal(subtitle, "Deliver checkout\nwith a working\t支付 flow");
  const lines = renderCompactTaskHeader(undefined, 40, theme, { subtitle: "A".repeat(100) });
  assert.equal(lines[0], "todo", "an outcome alone must not invent checklist progress");
  assert.match(stripVTControlCharacters(lines[1]!), /\.\.\.$/);
});

test("the existing Todo header adds one bounded ledger count line without a second widget", () => {
  const ledger = "ledger 1/3 complete · 2 open · 1 blocked · next: Ship API";
  for (const width of [1, 12, 40, 80]) {
    const lines = renderCompactTaskHeader("0/2 complete", width, theme, {
      subtitle: "Deliver checkout",
      disclosure: "▸",
      runtime: { status: "active", clock: "2:14" },
      ledger,
    });
    assert.equal(lines.length, 4, "header, subtitle, ledger, and one blank row, with no extra widget");
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    if (width >= 80) {
      assert.equal(lines[1], "  Deliver checkout");
      assert.equal(lines[2], `  ${ledger}`);
    }
    assert.equal(lines[3], "");
  }
});

test("display, hooks, and ledger defaults and independent changes are validated without mutation", () => {
  assert.deepEqual(parseOutcomeTodoPreferences(undefined), { version: 1, enabled: false, display: true, ledger: false });
  for (const enabled of [false, true]) {
    const legacy = Object.freeze({ version: 1, enabled });
    assert.deepEqual(parseOutcomeTodoPreferences(legacy), { ...legacy, display: true, ledger: false });
    const hidden = changeOutcomeTodoPreference(legacy, "display", false);
    assert.deepEqual(hidden, { ...legacy, display: false, ledger: false });
    assert.deepEqual(changeOutcomeTodoPreference(hidden, "enabled", !enabled), { version: 1, enabled: !enabled, display: false, ledger: false });
    assert.deepEqual(changeOutcomeTodoPreference(hidden, "ledger", true), { version: 1, enabled, display: false, ledger: true });
    assert.deepEqual(legacy, { version: 1, enabled });
  }
  for (const invalid of [null, [], false, { version: 2 }, { version: 1, enabled: "false" }, { version: 1, display: 0 }, { version: 1, ledger: "On" }]) {
    assert.throws(() => changeOutcomeTodoPreference(invalid, "display", true), /Invalid outcomeTodo/);
  }
});