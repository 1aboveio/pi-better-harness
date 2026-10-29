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

test("display and hooks defaults, legacy values, and independent changes are validated without mutation", () => {
  assert.deepEqual(parseOutcomeTodoPreferences(undefined), { version: 1, enabled: false, display: true });
  for (const enabled of [false, true]) {
    const legacy = Object.freeze({ version: 1, enabled });
    assert.deepEqual(parseOutcomeTodoPreferences(legacy), { ...legacy, display: true });
    const hidden = changeOutcomeTodoPreference(legacy, "display", false);
    assert.deepEqual(hidden, { ...legacy, display: false });
    assert.deepEqual(changeOutcomeTodoPreference(hidden, "enabled", !enabled), { version: 1, enabled: !enabled, display: false });
    assert.deepEqual(legacy, { version: 1, enabled });
  }
  for (const invalid of [null, [], false, { version: 2 }, { version: 1, enabled: "false" }, { version: 1, display: 0 }]) {
    assert.throws(() => changeOutcomeTodoPreference(invalid, "display", true), /Invalid outcomeTodo/);
  }
});