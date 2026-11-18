import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

test("actual worker failure callback retains a bounded SQLite producer without changing other errors or generation fences", () => {
  const source = ts.createSourceFile("query-executor.ts", readFileSync(new URL("../src/runtime/query-executor.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let callback: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "on"
        && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === "error"
        && node.arguments[1] && ts.isArrowFunction(node.arguments[1])) callback ??= node.arguments[1];
    ts.forEachChild(node, visit);
  };
  visit(source); assert.ok(callback);
  const code = ts.transpileModule(`const callback = ${ts.createPrinter().printNode(ts.EmitHint.Unspecified, callback, source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const failures: Error[] = [], owner = { worker: {}, fail: (error: Error) => { failures.push(error); } };
  const receive = new Function("worker", `${code}; return callback;`).call(owner, owner.worker);
  const error = new Error("database is locked");
  error.stack = `Error: database is locked\n at AssignmentInbox.metrics (actual-producer:110:129)\n${("long-frame".repeat(100) + "\n").repeat(30)}`;
  receive(error);
  assert.ok(failures[0]!.message.startsWith("runtime-unhealthy: read worker failed: Error: database is locked"));
  assert.match(failures[0]!.message, /AssignmentInbox.metrics/);
  assert.ok(failures[0]!.message.length <= 4097 + String(error).length + "runtime-unhealthy: read worker failed: ".length);
  const other = new Error("unrelated worker fault"); receive(other);
  assert.equal(failures[1]!.message, `runtime-unhealthy: read worker failed: ${String(other)}`);
  owner.worker = {}; receive(error);
  assert.equal(failures.length, 2, "an old generation cannot replace the current failure");
});
