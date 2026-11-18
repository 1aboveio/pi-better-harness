import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ts from "typescript";
const { instrumentHostedCreation, load } = await import(String("../scripts/measure-full-runtime/recovery-trace-loader.mjs"));
const { recordHostedCreationPhase } = await import(String("../scripts/measure-full-runtime/recovery-trace.mjs"));

test("actual registry start retains the awaited creation stage without advancing a held SDK boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "hosted-creation-phase-"));
  const previous = process.env.PI_FULL_RUNTIME_CREATION_REPORT;
  const output = join(root, "creation.json");
  process.env.PI_FULL_RUNTIME_CREATION_REPORT = output;
  const gate = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  };
  const resources = gate(), sdk = gate(), ui = gate();
  const target = new URL("../src/registry.ts", import.meta.url);
  const original = readFileSync(target, "utf8");
  const source = instrumentHostedCreation(original);
  const tree = ts.createSourceFile("registry.ts", source, ts.ScriptTarget.Latest, true);
  let start: ts.MethodDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isMethodDeclaration(node) && node.name.getText(tree) === "start") start = node;
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(start);
  // Only external waits are held; execute the registry's actual start method.
  const code = ts.transpileModule(`class Control { ${start.getText(tree)} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  class Activity { resetRuntime() {} dispose() {} }
  class Loader { async reload() { await resources.promise; } }
  class Hosted { executionActive = false; async bindUi() { await ui.promise; } }
  const session = { sessionFile: "fixture-session" };
  const execute = new Function("SessionActivity", "SettingsManager", "DefaultResourceLoader", "getAgentDir", "createAgentSession",
    "EventLog", "join", "HostedSession", "recordHostedCreationPhase", `${code}; return Control.prototype.start;`)(
    Activity, { create: () => ({}) }, Loader, () => root, async () => { await sdk.promise; return { session }; },
    class {}, join, Hosted, recordHostedCreationPhase);
  const owner = { options: { serverDir: root }, log() {}, maintenance: { registerManager() {} }, live: new Map(),
    async restoreSavedModel() {}, persist() {} };
  let settled = false;
  const pending = execute.call(owner, { sessionId: "controlled", cwd: root }, {});
  void pending.then(() => { settled = true; }, () => { settled = true; });
  const phase = () => JSON.parse(readFileSync(output, "utf8")).phase;
  try {
    assert.equal(phase(), "resource-loader-reload");
    assert.equal(settled, false);
    resources.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(phase(), "sdk-create-agent-session");
    assert.equal(settled, false);
    sdk.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(phase(), "hosted-bind-ui");
    assert.equal(settled, false);
    ui.resolve(); await pending;
    assert.equal(owner.live.size, 1);
    assert.ok(Buffer.byteLength(readFileSync(output)) < 256);
    const transformed = await load(target.href, {}, () => assert.fail("owned registry should be observed"));
    assert.equal(transformed.shortCircuit, true);
    assert.throws(() => instrumentHostedCreation(original.replace("await runtime.bindUi();", "await runtime.other();")), /anchor changed/);
  } finally {
    resources.resolve(); sdk.resolve(); ui.resolve(); await pending.catch(() => {});
    if (previous === undefined) delete process.env.PI_FULL_RUNTIME_CREATION_REPORT;
    else process.env.PI_FULL_RUNTIME_CREATION_REPORT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
