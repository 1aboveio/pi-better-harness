import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const parseModule = "../../pi-better-subagents/parse.ts";
const healthModule = "../../pi-better-subagents/health-observation.ts";
const { parseRun, encodeParseLogState, decodeParseLogState } = await import(parseModule);
const { extractChildEventFactsFromLog, encodeHealthLogState, decodeHealthLogState } = await import(healthModule);
const event = (value: any) => JSON.stringify(value) + "\n";
const usage = event({ type: "message_end", message: { role: "assistant", usage: { input: 1, cost: { total: 0.01 } } } });

test("cumulative catch-up and recent health retain independent coverage across serialization", () => {
  const parent = resolve("../../.work/801"); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "folds-")), path = join(root, "output.log");
  let display = new Map(), health = new Map();
  const oldHealthBudget = process.env.PI_SUBAGENT_MAX_HEALTH_READ_BYTES;
  process.env.PI_SUBAGENT_MAX_HEALTH_READ_BYTES = "128000";
  try {
    const padding = event({ type: "message_update", message: { role: "assistant", content: "x".repeat(60000) } });
    writeFileSync(path, usage + padding.repeat(40) + event({ type: "tool_execution_start", toolCallId: "open", toolName: "bash" }));
    const first = parseRun("run", { logPath: path, states: display, summaryOnly: true });
    assert.equal(first.usage.input, 1); assert.equal(display.get(path).catchingUp, true);
    const facts = extractChildEventFactsFromLog("run", { logPath: path, states: health });
    assert.equal(facts.facts.activeTools.length, 1);
    assert.equal(facts.rawLog.windowTruncated, true);
    assert.ok(display.get(path).cursor.offset < health.get(path).cursor.offset);
    const displaySnapshot = () => decodeParseLogState(JSON.parse(JSON.stringify(encodeParseLogState(display.get(path)))));
    display = new Map([[path, displaySnapshot()]]);
    health = new Map([[path, decodeHealthLogState(JSON.parse(JSON.stringify(encodeHealthLogState(health.get(path)))))]]);
    for (let n = 0; n < 5 && display.get(path).catchingUp; n++) parseRun("run", { logPath: path, states: display, summaryOnly: true });
    assert.equal(display.get(path).catchingUp, false);
    assert.equal(parseRun("run", { logPath: path, states: display, summaryOnly: true }).usage.input, 1);
    appendFileSync(path, usage.trimEnd());
    assert.equal(parseRun("run", { logPath: path, states: display, summaryOnly: true }).usage.input, 2);
    display = new Map([[path, displaySnapshot()]]);
    appendFileSync(path, "\n" + event({ type: "tool_execution_end", toolCallId: "open", toolName: "bash" }));
    assert.equal(parseRun("run", { logPath: path, states: display, summaryOnly: true }).usage.input, 2);
    assert.equal(extractChildEventFactsFromLog("run", { logPath: path, states: health }).facts.activeTools.length, 0);
    // Same prefix and a larger replacement must still discard the old generation.
    writeFileSync(join(root, "new"), usage + padding.repeat(42)); renameSync(join(root, "new"), path);
    for (let n = 0; n < 5; n++) parseRun("run", { logPath: path, states: display, summaryOnly: true });
    assert.equal(display.get(path).usage.input, 1);
    writeFileSync(path, usage);
    assert.equal(parseRun("run", { logPath: path, states: display, summaryOnly: true }).usage.input, 1);
    writeFileSync(path, event({ type: "message_update", message: { role: "assistant", content: "x".repeat(2400000) } }) + usage);
    for (let n = 0; n < 5; n++) parseRun("run", { logPath: path, states: display, summaryOnly: true });
    const incomplete = parseRun("run", { logPath: path, states: display, summaryOnly: true });
    assert.equal(incomplete.usage.input, 1);
    assert.ok(incomplete.diagnostics.some((line: string) => line.includes("Incomplete usage")));
    assert.ok(display.get(path).cursor.missing[1] > 2400000);
  } finally {
    if (oldHealthBudget === undefined) delete process.env.PI_SUBAGENT_MAX_HEALTH_READ_BYTES;
    else process.env.PI_SUBAGENT_MAX_HEALTH_READ_BYTES = oldHealthBudget;
    rmSync(root, { recursive: true, force: true });
  }
});
