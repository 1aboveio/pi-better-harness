import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { WorkQueryExecutor } from "../src/runtime/query-executor.ts";
const { bootstrapHeartbeat } = await import(new URL("./support/bootstrap-heartbeat.mjs", import.meta.url).href);

// Preserve native mailbox retention at the external worker boundary without
// starting a Worker, socket or subprocess. The executor and heartbeat are real.
class Mailbox extends EventEmitter {
  queued: any[] = [];
  send(message: any) {
    if (!this.listenerCount("message")) this.queued.push(message);
    else this.emit("message", message);
  }
  override on(event: string, listener: (...args: any[]) => void) {
    super.on(event, listener);
    if (event === "message") queueMicrotask(() => {
      if (!this.listenerCount("message")) return;
      for (const message of this.queued.splice(0)) this.emit("message", message);
    });
    return this;
  }
}

test("actual cold fixture retains the expired query and cancel until RPC owns them", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const mailbox = new Mailbox(), rpc: any[] = [];
  let executor: WorkQueryExecutor;
  const worker = { postMessage(message: any) { mailbox.send(message); },
    terminate: async () => 0, unref() {} };
  const prototype = WorkQueryExecutor.prototype as any, startWorker = prototype.startWorker;
  prototype.startWorker = () => worker;
  try { executor = new WorkQueryExecutor("unused-injected-root", "cold", { timeoutMs: 400, watchdogMs: 2000 }); }
  finally { prototype.startWorker = startWorker; }
  (mailbox as any).postMessage = (message: any) => (executor as any).receive(message);
  const stream = Object.assign(new EventEmitter(), { destroyed: false, writableLength: 0, write() { return true; } });
  const client = executor.connect(stream as any);
  const source = readFileSync(new URL("./support/cold-cancellable-query-worker.mjs", import.meta.url), "utf8");
  // Execute the actual entrypoint; replace only external module loading.
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    transformers: { before: [context => node => {
      const visit = (child: ts.Node): ts.VisitResult<ts.Node> => ts.isCallExpression(child) && child.expression.kind === ts.SyntaxKind.ImportKeyword
        ? ts.factory.updateCallExpression(child, ts.factory.createIdentifier("load"), child.typeArguments, child.arguments)
        : ts.visitEachChild(child, visit, context);
      return ts.visitNode(node, visit) as ts.SourceFile;
    }] },
  }).outputText;
  const load = async (path: string): Promise<any> => {
    if (path === "node:worker_threads") return { parentPort: mailbox };
    assert.equal(path, "./cancellable-query-worker.mjs");
    const stopHeartbeat = bootstrapHeartbeat(mailbox);
    // Actual heartbeat ownership starts before the production RPC import settles.
    await Promise.resolve();
    mailbox.on("message", message => {
      if (!["query", "cancel"].includes(message.type)) return;
      rpc.push(message);
      (mailbox as any).postMessage({ type: "reply", id: message.id,
        json: JSON.stringify({ status: "ready" }), observation: { status: "ready", reasons: [], observedAt: 1 } });
    });
    stopHeartbeat();
  };
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  const bootstrap = new AsyncFunction("load", output)(load);
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    const timedOut = assert.rejects(client.handle({ type: "runtime_subscribe", scope: {} }), /runtime-timeout: caller read deadline exceeded/);
    t.mock.timers.tick(400); await timedOut;
    assert.equal(executor.metrics().executor.callerTimeouts, 1);
    assert.equal(executor.observation().status, "rebuilding");
    t.mock.timers.tick(200); await bootstrap;
    assert.deepEqual(rpc.map(message => message.type), ["query", "cancel"], "expired work must reach the installed RPC exactly once and in order");
    assert.equal(executor.observation().status, "rebuilding", "late expired reply cannot verify source coverage");
    assert.equal(executor.metrics().executor.active, 0, "actual late acknowledgement releases the execution slot");
    const snapshot = JSON.parse((await client.handle({ type: "runtime_subscribe", scope: {} })).json);
    assert.equal(snapshot.status, "ready");
    assert.equal(executor.metrics().executor.callerTimeouts, 1);
    assert.equal(executor.metrics().executor.queueTimeouts, 0);
    assert.equal(executor.metrics().executor.restarts, 0);
    assert.equal(executor.metrics().executor.completed, 1, "expired replies do not count as completed reads");
  } finally { client.close(); await executor.close(); }
});
