import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

test("actual resource phase writer retains incomplete setup and primary failure before cleanup can stall", () => {
  const source = readFileSync(new URL("../scripts/measure-full-runtime.mjs", import.meta.url), "utf8");
  const tree = ts.createSourceFile("measure.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declaration = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "reportPhase");
  assert.ok(declaration);
  const root = mkdtempSync(join(tmpdir(), "resource-phase-")), output = join(root, "report.json");
  const report = { mode: "resource-smoke-not-qualified", scenarios: [], measurement: { coverage: { exit: false } } } as any;
  const stderr: string[] = [];
  const phase = new Function("report", "output", "writeFileSync", "process", `${declaration.getText(tree)}; return reportPhase;`)(
    report, output, writeFileSync, { stderr: { write: (value: string) => stderr.push(value) } });
  try {
    phase("hosted-0-create-session");
    const setup = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(setup.phase, "hosted-0-create-session");
    assert.deepEqual(setup.scenarios, []);
    assert.equal(setup.measurement.coverage.exit, false);
    report.failure = "original await rejected";
    phase("cleanup-remote-0-dispose");
    const cleanup = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(cleanup.failure, "original await rejected");
    assert.equal(cleanup.phase, "cleanup-remote-0-dispose");
    assert.equal(cleanup.measurement.coverage.exit, false, "entering cleanup cannot prove exit");
    assert.deepEqual(stderr.map(line => JSON.parse(line).phase), ["hosted-0-create-session", "cleanup-remote-0-dispose"]);
    assert.ok(stderr.every(line => Buffer.byteLength(line) < 256));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
