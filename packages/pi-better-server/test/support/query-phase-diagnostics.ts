import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { EventEmitter } from "node:events";
import { createQueryPhaseBuffer, queryPhase, readQueryPhases, recordQueryPhase, recordQuerySample } from "../../src/runtime/query-phase-diagnostics.mjs";

test("temporary query phase evidence is bounded and generation-qualified", () => {
  const buffer = createQueryPhaseBuffer();
  recordQueryPhase(undefined, queryPhase.dispatch, 1, 4);
  for (let index = 0; index < 1000; index++) recordQueryPhase(buffer, queryPhase.dispatch, 1, 4);
  recordQueryPhase(buffer, queryPhase.dispatch, 3, 4);
  recordQuerySample(buffer, "accepted");
  const evidence = readQueryPhases(buffer);
  assert.equal(evidence.total, 1000);
  assert.equal(evidence.capacity, 48);
  assert.equal(evidence.dropped, 952);
  assert.equal(evidence.records.length, 48);
  assert.ok(evidence.records.every(row => row.id === 1));
  assert.equal(evidence.samples.accepted?.count, 1);
  assert.ok(evidence.records.every(row => row.generation === 4 && row.phase === "dispatch" && BigInt(row.atNs) > 0n));
  assert.ok(Buffer.byteLength(JSON.stringify(evidence)) < 8192);
});

test("held bootstrap and import catches emit bounded failure context and rethrow the original error", async () => {
  const path = new URL("../query-executor.test.ts", import.meta.url);
  const source = readFileSync(path, "utf8");
  const tree = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.Latest, true);
  const ready = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "ready")!;
  for (const name of ["slow caller cancellation preserves other clients and ignores late replies",
    "an 800 ms setup subscription cannot verify a source while fixture bootstrap is held",
    "responsive fixture imports outlive the wedge watchdog without source readiness"]) {
    const statement = tree.statements.find(node => {
      if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) return false;
      const nameArgument = node.expression.arguments[0];
      return nameArgument && ts.isStringLiteral(nameArgument) && nameArgument.text === name;
    }) as ts.ExpressionStatement;
    const callback = (statement.expression as ts.CallExpression).arguments[2];
    assert.ok(callback);
    const emitted = ts.transpileModule(`${ready.getText(tree)}\nreturn (${callback.getText(tree)});`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      transformers: { before: [context => node => {
        const visit = (child: ts.Node): ts.VisitResult<ts.Node> => {
          if (ts.isPropertyAccessExpression(child) && ts.isMetaProperty(child.expression)) return ts.factory.createStringLiteral(path.href);
          return ts.visitEachChild(child, visit, context);
        };
        return ts.visitNode(node, visit) as ts.SourceFile;
      }], after: [context => node => context.factory.updateSourceFile(node,
        node.statements.filter(statement => !ts.isExportDeclaration(statement)))] },
    }).outputText;
    const original = new Error(name.startsWith("an 800")
      ? "runtime-timeout: caller read deadline exceeded; source was not verified"
      : "query fixture worker exited before source inventory readiness (code 1); runtime-unhealthy: read worker unresponsive; watchdog deadline exceeded");
    const diagnostics: string[] = [];
    let closed = false, subscriptions = 0, clients = 0;
    const fixture = async (options: { queryPhaseDiagnostics: SharedArrayBuffer }) => {
      const buffer = options.queryPhaseDiagnostics;
      const client = {
        request(type: string) {
          if (type === "ping") return Promise.resolve({ ok: true });
          assert.equal(type, "runtime_subscribe");
          const id = ++subscriptions;
          for (const phase of [queryPhase.dispatch, queryPhase.queryReceived, queryPhase.handlerEntered, queryPhase.snapshotBegin, queryPhase.callerDeadline])
            recordQueryPhase(buffer, phase, id, 7);
          return Promise.reject(original);
        },
        subscribe() { return this.request("runtime_subscribe"); },
      };
      const worker = Object.assign(new EventEmitter(), { postMessage() {} });
      setImmediate(() => { for (let index = 0; index < 6; index++) worker.emit("message", { type: "heartbeat" }); });
      return { bootstrapped: Promise.resolve(), client: async () => { clients++; return { ...client }; }, worker,
        waitForSourceReady: async () => {
          recordQueryPhase(buffer, queryPhase.inventoryBegin, 0, 7);
          recordQuerySample(buffer, "response"); recordQuerySample(buffer, "watchdog");
          recordQueryPhase(buffer, queryPhase.watchdogFired, 0, 7);
          throw original;
        },
        executor: { observation: () => ({ status: "rebuilding" }), metrics: () => ({ executor: {
          callerTimeouts: subscriptions ? 1 : 0, queueTimeouts: 0, singleflightHits: 0, restarts: 0,
          clients, active: subscriptions ? 1 : 0, queued: 0, completed: 0, readMs: [] } }) },
        close: async () => { closed = true; } };
    };
    const run = new Function("fixture", "createQueryPhaseBuffer", "readQueryPhases", "recordQueryPhase", "queryPhase", "assert", emitted)(
      fixture, createQueryPhaseBuffer, readQueryPhases, recordQueryPhase, queryPhase, assert);
    await assert.rejects(run({ diagnostic: (message: string) => diagnostics.push(message) }), error => error === original);
    assert.equal(closed, true);
    assert.equal(diagnostics.length, 1);
    assert.ok(Buffer.byteLength(diagnostics[0]!) <= 8192);
    const data = JSON.parse(diagnostics[0]!);
    const context = data.heldFixtureFailure ?? data.slowCallerFailure;
    assert.equal(context.phase, name.startsWith("slow") ? "source-inventory-ready"
      : name.startsWith("an 800") ? "post-bootstrap-subscription" : "inventory-ready");
    const trace = context.trace ?? context.queryPhases;
    assert.ok(trace.records.some((row: any) => row.generation === 7));
    assert.equal(trace.dropped, 0);
    if (name.startsWith("slow")) {
      assert.equal(clients, 0);
      assert.equal(subscriptions, 0);
      assert.deepEqual(context.requests, []);
      assert.equal(context.executor.active, 0);
      assert.equal(trace.samples.watchdog.count, 1);
      assert.ok(BigInt(trace.samples.watchdog.lastNs) >= BigInt(trace.samples.response.lastNs));
    }
  }
});

test("held inventory failure keeps valid bounded evidence even after the phase ring fills", () => {
  const path = new URL("../query-executor.test.ts", import.meta.url);
  const tree = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const statement = tree.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.arguments[0]?.getText(tree).includes("responsive rebuilding outlives")) as ts.ExpressionStatement;
  const callback = (statement.expression as ts.CallExpression).arguments[2] as ts.ArrowFunction;
  const guarded = (callback.body as ts.Block).statements.find(node => ts.isTryStatement(node) && node.catchClause) as ts.TryStatement;
  const body = guarded.catchClause!.block.statements.map(node => node.getText(tree)).join("\n");
  const run = new Function("t", "f", "phase", "queryPhaseDiagnostics", "readQueryPhases", "error", body);
  const buffer = createQueryPhaseBuffer();
  for (let index = 0; index < 1000; index++) recordQueryPhase(buffer, queryPhase.inventoryBegin, 0, 0);
  const diagnostics: string[] = [], error = new Error("worker watchdog failure");
  const f = { executor: { observation: () => ({ status: "degraded", reason: String(error) }),
    metrics: () => ({ executor: { readMs: [], waitMs: [] } }) } };
  assert.throws(() => run({ diagnostic: (value: string) => diagnostics.push(value) }, f, "inventory-ready", buffer, readQueryPhases, error), value => value === error);
  assert.equal(diagnostics.length, 1);
  assert.ok(Buffer.byteLength(diagnostics[0]!) <= 8192);
  const failure = JSON.parse(diagnostics[0]!).heldFixtureFailure;
  assert.equal(failure.case, 114);
  assert.equal(failure.phase, "inventory-ready");
  assert.equal(failure.trace.records.length, 48);
  assert.equal(failure.trace.dropped, 952);
});
