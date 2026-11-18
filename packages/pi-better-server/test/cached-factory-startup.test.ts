import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import ts from "typescript";
import { WorkQueryExecutor } from "../src/runtime/query-executor.ts";
import { acquireMutationStore } from "../src/runtime/mutation-store.ts";

test("actual cached-factory setup does not supervise a worker during cold host imports", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const path = new URL("./runtime-background-history-regressions.test.ts", import.meta.url);
  const tree = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const call = tree.statements.filter(ts.isExpressionStatement).map(statement => statement.expression)
    .find((node): node is ts.CallExpression => ts.isCallExpression(node) && ts.isStringLiteral(node.arguments[0]!)
      && node.arguments[0].text.startsWith("cached parent and headless child factories"));
  assert.ok(call);
  const callback = call.arguments[2];
  assert.ok(callback && ts.isArrowFunction(callback) && ts.isBlock(callback.body));
  const statements = [...callback.body.statements];
  const declarationIndex = (name: string) => statements.findIndex(statement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration => declaration.name.getText(tree).includes(name)));
  const setup = statements.slice(0, Math.max(declarationIndex("executor"), declarationIndex("initTheme")) + 1);
  // Execute the real fixture setup; replace only external module/worker boundaries.
  const printer = ts.createPrinter();
  const source = setup.map(statement => printer.printNode(ts.EmitHint.Unspecified, statement, tree)).join("\n") + "\nreturn executor;";
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    transformers: { before: [context => node => {
      const visit = (child: ts.Node): ts.VisitResult<ts.Node> => {
        if (ts.isCallExpression(child) && child.expression.kind === ts.SyntaxKind.ImportKeyword)
          return ts.factory.updateCallExpression(child, ts.factory.createIdentifier("importExternal"), child.typeArguments, child.arguments);
        if (ts.isPropertyAccessExpression(child) && ts.isMetaProperty(child.expression) && child.name.text === "url")
          return ts.factory.createStringLiteral(path.href);
        return ts.visitEachChild(child, visit, context);
      };
      return ts.visitNode(node, visit) as ts.SourceFile;
    }], after: [context => node => context.factory.updateSourceFile(node,
      node.statements.filter(statement => !ts.isExportDeclaration(statement)))] },
  }).outputText;
  const root = mkdtempSync(join(tmpdir(), "cached-factory-startup-"));
  let lease: ReturnType<typeof acquireMutationStore> | undefined, executor: WorkQueryExecutor | undefined;
  let imports = 0;
  const worker = { postMessage() {}, terminate: async () => 0, unref() {} };
  const prototype = WorkQueryExecutor.prototype as any, startWorker = prototype.startWorker;
  prototype.startWorker = () => worker;
  const importExternal = async (specifier: string) => {
    imports++;
    if (specifier.endsWith("/pi-better-subagents/index.ts")) { now += 4200; t.mock.timers.tick(4200); }
    return { default() {}, initTheme() {} };
  };
  try {
    const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
    executor = await new AsyncFunction("mkdtempSync", "join", "tmpdir", "acquireMutationStore", "WorkQueryExecutor",
      "load", "EventEmitter", "registerHooks", "importExternal", output)(
      () => root, join, tmpdir, (directory: string) => lease = acquireMutationStore(directory), WorkQueryExecutor,
      async () => ({ registerTools() {} }), EventEmitter, () => ({ deregister() {} }), importExternal);
    assert.equal(imports, 3, "all real factory/theme imports precede supervision");
    assert.equal(executor!.metrics().executor.worker, "running", "cold host setup must not spend the worker's unchanged4000ms watchdog");
    (executor as any).receive({ type: "heartbeat" });
    assert.equal(executor!.metrics().executor.restarts, 0);
    assert.equal(executor!.metrics().executor.completed, 0);
  } finally {
    prototype.startWorker = startWorker;
    await executor?.close(); lease?.release();
    delete (globalThis as any)[Symbol.for("803.component.command-transport")];
    rmSync(root, { recursive: true, force: true });
  }
});
