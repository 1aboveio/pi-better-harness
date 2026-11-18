import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { subscribeBackgroundReady } from "./support/background-source-ready.ts";

test("ordinary Background client fixture waits for actual readiness before asserting shared coverage", async () => {
  const source = ts.createSourceFile("runtime-background.test.ts", readFileSync(new URL("./runtime-background.test.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let loop: ts.ForStatement | undefined, helper: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node) => {
    if (!loop && ts.isForStatement(node) && node.initializer && ts.isVariableDeclarationList(node.initializer)
        && node.initializer.declarations[0]?.name.getText(source) === "i") loop = node;
    if (!helper && ts.isVariableDeclaration(node) && node.name.getText(source) === "waitFor" && node.initializer && ts.isArrowFunction(node.initializer)) helper = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(loop && helper);
  const printer = ts.createPrinter();
  const emit = (node: ts.Node) => ts.transpileModule(printer.printNode(ts.EmitHint.Unspecified, node, source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const helperCode = ts.transpileModule(`const target = ${printer.printNode(ts.EmitHint.Unspecified, helper, source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  let ready = false, settled = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const clients: any[] = [], requests: any[] = [];
  class Client {
    snapshot: any;
    listeners = new Set<(snapshot: any) => void>();
    async subscribe(scope: any) { return this.snapshot = await this.get(scope); }
    onChange(listener: (snapshot: any) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    async get(scope: any) { requests.push(scope); return { status: ready ? "ready" : "rebuilding", activity: { active: 0 }, scopeRevision: "verified-scope" }; }
    async request(type: string) { return type === "list_sessions" ? { sessions: [] } : { hostedSessions: 0 }; }
  }
  const waitFor = new Function("clients", "root", "assert", "delay", `${helperCode}; return target;`)(clients, "workspace", assert,
    async (_ms: number) => { await gate; });
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  const completion = new AsyncFunction("WorkClient", "ready", "root", "clients", "waitFor", "assert", "subscribeBackgroundReady", "t", emit(loop))(
    Client, { ready: "unused-socket" }, "workspace", clients, waitFor, assert, subscribeBackgroundReady, { signal: new AbortController().signal });
  void completion.then(() => { settled = true; }, () => { settled = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  try {
    assert.equal(settled, false, "an initial rebuilding frame cannot satisfy the fixture's ready assertion");
    ready = true; release();
    for (const client of clients) {
      client.snapshot = { ...client.snapshot, status: "ready" };
      for (const listener of client.listeners) listener(client.snapshot);
    }
    await completion;
    assert.equal(clients.length, 10);
    for (let i = 0; i < 10; i++) assert.ok(requests.some(scope => scope.sessionId === `local-${i}`));
  } finally { ready = true; release(); await completion.catch(() => {}); }
});
