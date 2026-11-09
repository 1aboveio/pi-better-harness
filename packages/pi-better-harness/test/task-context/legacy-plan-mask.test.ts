import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  DefaultResourceLoader,
  type Extension,
  type ExtensionContext,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";

import extension from "../../extensions/task-context/index.js";
import { installLegacyPlanMask } from "../../extensions/task-context/legacy-plan-mask.js";

const MASK_STATE = Symbol.for("pi-better-harness.legacy-plan-mask");
const EXTENSION_NAME = "pi-better-plan";

function tempDir(t: TestContext, label: string): string {
  const dir = mkdtempSync(join(tmpdir(), label));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A real installed-package layout: <root>/node_modules/<name>/package.json + entry file. */
function packageFixture(t: TestContext, name: string): { entry: string; files: string[] } {
  const root = tempDir(t, "legacy-plan-mask-");
  const dir = join(root, "node_modules", name);
  mkdirSync(join(dir, "src"), { recursive: true });
  const pkgFile = join(dir, "package.json");
  writeFileSync(pkgFile, JSON.stringify({ name, version: "0.9.1" }, null, 2));
  const entry = join(dir, "src", "index.ts");
  writeFileSync(entry, "export default function plugin() {}\n");
  return { entry, files: [pkgFile, entry] };
}

function runtime(): LoadExtensionsResult["runtime"] {
  return { flagValues: new Map(), pendingProviderRegistrations: [], pendingNativeProviderRegistrations: [] } as never;
}

function loadedResult(extensions: Extension[], shared = runtime()): LoadExtensionsResult {
  return { extensions, errors: [], runtime: shared };
}

/** The real class prototype (and therefore the real public getter), with a stub cached result. */
function loaderWith(result: LoadExtensionsResult): DefaultResourceLoader {
  const loader = Object.create(DefaultResourceLoader.prototype) as DefaultResourceLoader;
  Object.defineProperty(loader, "extensionsResult", { value: result, configurable: true, writable: true });
  return loader;
}

function record(handlers: Record<string, unknown[]>, resolvedPath: string, extra: Record<string, unknown> = {}): Extension {
  return {
    path: resolvedPath,
    resolvedPath,
    sourceInfo: { path: resolvedPath, source: "local", scope: "user", origin: "top-level" },
    handlers: new Map(Object.entries(handlers)),
    tools: new Map(handlers.session_start?.length ? [["get_todo", { definition: { parameters: handlers.session_start[0] } }]] : []),
    messageRenderers: new Map(),
    entryRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
    ...extra,
  } as unknown as Extension;
}

function activeMaskState(): unknown {
  return (DefaultResourceLoader.prototype as unknown as Record<symbol, unknown>)[MASK_STATE];
}

test("masks a separately installed pi-better-plan in either load order and preserves unrelated records", (t) => {
  for (const order of ["legacy-before-harness", "harness-before-legacy"] as const) {
    const legacy = packageFixture(t, "pi-better-plan");
    const harness = packageFixture(t, "pi-better-harness");
    const unrelated = packageFixture(t, "some-plan-plugin");
    const marker = () => undefined;
    const mask = installLegacyPlanMask(marker);
    try {
      const legacyRecord = record({ session_start: [], session_shutdown: [] }, legacy.entry);
      const harnessRecord = record({ session_start: [marker] }, harness.entry);
      const unrelatedRecord = record({ session_start: [() => undefined], tools: new Map([["plan", {}]]) }, unrelated.entry);
      const shared = runtime();
      const cached = loadedResult(order === "legacy-before-harness"
        ? [legacyRecord, harnessRecord, unrelatedRecord]
        : [harnessRecord, unrelatedRecord, legacyRecord], shared);
      const loader = loaderWith(cached);

      const filtered = loader.getExtensions();
      assert.deepEqual(filtered.extensions, [harnessRecord, unrelatedRecord], order);
      assert.equal(filtered.runtime, shared, "runtime instance is carried through");
      assert.equal(filtered.errors, cached.errors, "errors are carried through");
      assert.equal(cached.extensions.length, 3, "the loader's cached result keeps every loaded extension");
      assert.equal(cached.extensions.includes(legacyRecord), true);
      assert.equal(mask.notice, null);
      assert.notEqual(filtered, cached, "the filtered result is a clone");
      assert.deepEqual(loader.getExtensions().extensions, [harnessRecord, unrelatedRecord], "repeated reads stay filtered");
    } finally {
      mask.dispose();
    }
  }
  assert.equal(activeMaskState(), undefined, "disposal restores the public getter");
});

test("only loader results carrying this Harness instance are filtered", (t) => {
  const legacy = packageFixture(t, "pi-better-plan");
  const harness = packageFixture(t, "pi-better-harness");
  const marker = () => undefined;
  const mask = installLegacyPlanMask(marker);
  try {
    const legacyRecord = record({ session_start: [], session_shutdown: [] }, legacy.entry);
    // Another Harness-style plugin with its own session_start handler is not this instance.
    const otherRecord = record({ session_start: [() => undefined] }, harness.entry);
    const cached = loadedResult([legacyRecord, otherRecord]);
    const loader = loaderWith(cached);
    assert.equal(loader.getExtensions(), cached, "a foreign loader result is returned untouched");
    assert.deepEqual(loader.getExtensions().extensions, [legacyRecord, otherRecord]);
  } finally {
    mask.dispose();
  }
});

test("the match follows the nearest real package.json name, not a tool name or path substring", (t) => {
  const lookalike = packageFixture(t, "pi-better-plan-copy");
  const legacy = packageFixture(t, "pi-better-plan");
  const harness = packageFixture(t, "pi-better-harness");
  const marker = () => undefined;
  const mask = installLegacyPlanMask(marker);
  try {
    // Named "pi-better-plan" in a path, but its package.json says otherwise.
    const lookalikeRecord = record({ session_start: [], tools: new Map([["plan", { name: "plan" }]]) }, lookalike.entry);
    const alias = join(tempDir(t, "legacy-plan-alias-"), "linked.ts");
    symlinkSync(legacy.entry, alias);
    const legacyRecord = record({ session_start: [], tools: new Map([["update_todo", {}]]) }, alias);
    const nested = join(legacy.entry, "..", "nested");
    mkdirSync(nested);
    writeFileSync(join(nested, "package.json"), "{malformed");
    writeFileSync(join(nested, "index.ts"), "export default function otherPlugin() {}\n");
    const unverifiedRecord = record({}, join(nested, "index.ts"));
    const harnessRecord = record({ session_start: [marker] }, harness.entry);
    const loader = loaderWith(loadedResult([lookalikeRecord, legacyRecord, unverifiedRecord, harnessRecord]));
    assert.deepEqual(loader.getExtensions().extensions, [lookalikeRecord, unverifiedRecord, harnessRecord]);
  } finally {
    mask.dispose();
  }
});

test("a retired record's own session_shutdown handlers run exactly once and drain their listeners", async (t) => {
  const legacy = packageFixture(t, "pi-better-plan");
  const harness = packageFixture(t, "pi-better-harness");
  const marker = () => undefined;
  const mask = installLegacyPlanMask(marker);
  const bus = new EventEmitter();
  const onChanged = () => undefined;
  bus.on("pi-better-plan:changed", onChanged);
  let shutdowns = 0;
  try {
    const legacyRecord = record({
      session_start: [],
      session_shutdown: [() => { shutdowns += 1; bus.off("pi-better-plan:changed", onChanged); }],
    }, legacy.entry);
    const harnessRecord = record({ session_start: [marker] }, harness.entry);
    const loader = loaderWith(loadedResult([legacyRecord, harnessRecord]));

    assert.deepEqual(loader.getExtensions().extensions, [harnessRecord]);
    assert.deepEqual(loader.getExtensions().extensions, [harnessRecord]);
    assert.deepEqual(loader.getExtensions().extensions, [harnessRecord]);

    const ctx = { hasUI: false } as unknown as ExtensionContext;
    await mask.cleanup(ctx);
    assert.equal(shutdowns, 1);
    assert.equal(bus.listenerCount("pi-better-plan:changed"), 0, "the retired plugin's own listeners are gone");
    await mask.cleanup(ctx);
    assert.equal(shutdowns, 1, "cleanup drains its queue");
    loader.getExtensions();
    await mask.cleanup(ctx);
    assert.equal(shutdowns, 1, "repeated reads do not re-queue a claimed record");
  } finally {
    mask.dispose();
  }
});

test("each factory instance cleans up its own records once and disposes independently", async (t) => {
  const legacyA = packageFixture(t, "pi-better-plan");
  const legacyB = packageFixture(t, "pi-better-plan");
  const harness = packageFixture(t, "pi-better-harness");
  const markerA = () => undefined;
  const markerB = () => undefined;
  const maskA = installLegacyPlanMask(markerA);
  const maskB = installLegacyPlanMask(markerB);
  const calls: string[] = [];
  try {
    const legacyRecordA = record({ session_start: [], session_shutdown: [() => calls.push("a")] }, legacyA.entry);
    const legacyRecordB = record({ session_start: [], session_shutdown: [() => calls.push("b")] }, legacyB.entry);
    const harnessRecordA = record({ session_start: [markerA] }, harness.entry);
    const harnessRecordB = record({ session_start: [markerB] }, harness.entry);
    const loaderA = loaderWith(loadedResult([legacyRecordA, harnessRecordA]));
    const loaderB = loaderWith(loadedResult([legacyRecordB, harnessRecordB]));

    assert.deepEqual(loaderA.getExtensions().extensions, [harnessRecordA]);
    assert.deepEqual(loaderB.getExtensions().extensions, [harnessRecordB]);

    const ctx = { hasUI: false } as unknown as ExtensionContext;
    maskA.dispose();
    assert.deepEqual(calls, [], "disposal alone does not run a retired plugin's cleanup");
    await maskB.cleanup(ctx);
    assert.deepEqual(calls, ["b"]);
    await maskB.cleanup(ctx);
    assert.deepEqual(calls, ["b"]);

    // Disposing B restores the public getter; A's disposed provider no longer filters.
    maskB.dispose();
    assert.equal(activeMaskState(), undefined);
    assert.equal(loaderA.getExtensions().extensions.length, 2);
    assert.equal(DefaultResourceLoader.prototype.getExtensions.name, "getExtensions");
  } finally {
    maskA.dispose();
    maskB.dispose();
  }
});

test("disposing one factory instance leaves other installed instances masking", (t) => {
  const legacy = packageFixture(t, "pi-better-plan");
  const harness = packageFixture(t, "pi-better-harness");
  const markerA = () => undefined;
  const markerB = () => undefined;
  const maskA = installLegacyPlanMask(markerA);
  const maskB = installLegacyPlanMask(markerB);
  try {
    const legacyRecord = record({ session_start: [], session_shutdown: [] }, legacy.entry);
    const harnessRecordA = record({ session_start: [markerA] }, harness.entry);
    const harnessRecordB = record({ session_start: [markerB] }, harness.entry);
    maskA.dispose();
    const filtered = loaderWith(loadedResult([legacyRecord, harnessRecordB])).getExtensions();
    assert.deepEqual(filtered.extensions, [harnessRecordB]);
    const untouched = loadedResult([legacyRecord, harnessRecordA]);
    assert.equal(loaderWith(untouched).getExtensions(), untouched, "a disposed provider does not claim results");
    assert.equal(DefaultResourceLoader.prototype.getExtensions.name, "legacyPlanMaskedGetExtensions");
    maskB.dispose();
    assert.equal(activeMaskState(), undefined);
  } finally {
    maskA.dispose();
    maskB.dispose();
  }
});

test("a missing loader API or an unknown result shape reports a compatibility notice instead of claiming a mask", async (t) => {
  const proto = DefaultResourceLoader.prototype as unknown as { getExtensions?: unknown };
  const saved = proto.getExtensions;
  const notices: Array<[string, string | undefined]> = [];
  const ctx = {
    hasUI: true,
    ui: { notify: (message: string, type?: string) => notices.push([message, type]) },
  } as unknown as ExtensionContext;

  delete proto.getExtensions;
  try {
    const mask = installLegacyPlanMask(() => undefined);
    assert.match(mask.notice ?? "", /not applied/);
    assert.match(mask.notice ?? "", /left active/);
    await mask.cleanup(ctx);
    assert.equal(notices.length, 1);
    assert.equal(notices[0]![1], "warning");
    mask.dispose();
  } finally {
    proto.getExtensions = saved;
  }
  assert.equal(activeMaskState(), undefined, "an unsupported SDK is never patched");

  const mask = installLegacyPlanMask(() => undefined);
  try {
    const loader = Object.create(DefaultResourceLoader.prototype) as DefaultResourceLoader;
    const bogus = { extensions: "not-an-array" };
    Object.defineProperty(loader, "extensionsResult", { value: bogus, configurable: true, writable: true });
    assert.equal(loader.getExtensions(), bogus as never, "an unknown result is passed through untouched");
    assert.match(mask.notice ?? "", /unexpected result shape/);
    await mask.cleanup(ctx);
    await mask.cleanup(ctx);
    assert.equal(notices.length, 2, "the notice is reported once per instance");
    assert.equal(notices[1]![1], "warning");
  } finally {
    mask.dispose();
  }
});

test("masking never touches the retired package's files", async (t) => {
  const legacy = packageFixture(t, "pi-better-plan");
  const harness = packageFixture(t, "pi-better-harness");
  const before = legacy.files.map(file => ({
    file,
    content: readFileSync(file, "utf8"),
    mtimeMs: statSync(file).mtimeMs,
  }));
  const marker = () => undefined;
  const mask = installLegacyPlanMask(marker);
  try {
    const legacyRecord = record({ session_start: [], session_shutdown: [() => undefined] }, legacy.entry);
    const loader = loaderWith(loadedResult([legacyRecord, record({ session_start: [marker] }, harness.entry)]));
    loader.getExtensions();
    await mask.cleanup({ hasUI: false } as unknown as ExtensionContext);
  } finally {
    mask.dispose();
  }
  for (const entry of before) {
    assert.equal(readFileSync(entry.file, "utf8"), entry.content, `${entry.file} content is unchanged`);
    assert.equal(statSync(entry.file).mtimeMs, entry.mtimeMs, `${entry.file} is not rewritten`);
  }
});

test("the real task-context factory awaits the retired plugin's shutdown before installing its own widget", async (t) => {
  const legacy = packageFixture(t, "pi-better-plan");
  const harness = packageFixture(t, "pi-better-harness");
  const agentDir = tempDir(t, "legacy-plan-agent-");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // Outcome & Todo is enabled so the real handler installs its Todo widget on start.
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    piBetterHarness: { outcomeTodo: { version: 1, enabled: true } },
  }));

  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const tools = new Map();
  const events = new EventEmitter();
  const order: string[] = [];
  const widgetCalls: Array<{ key: string; content: unknown }> = [];
  const bus = new EventEmitter();
  let legacyListenerGone = false;
  bus.on("pi-better-plan:changed", () => undefined);
  const ctx = {
    cwd: agentDir,
    mode: "tui",
    hasUI: true,
    sessionManager: { getBranch: () => [] },
    ui: {
      setWidget(key: string, content: unknown) { widgetCalls.push({ key, content }); },
      setStatus() {},
      notify() {},
    },
  } as unknown as ExtensionContext;

  extension({
    events,
    registerTool(tool: { name: string }) { tools.set(tool.name, { definition: tool }); },
    registerCommand() {},
    on(name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); },
    appendEntry() {},
    getActiveTools: () => ["read"],
    setActiveTools() {},
  } as never);

  const sessionStart = handlers.get("session_start")!;
  events.on("harness-settings:register", () => order.push("harness-body"));
  try {
    const legacyRecord = record({
      session_start: [],
      session_shutdown: [(_event: unknown, shutdownCtx: ExtensionContext) => {
        order.push("legacy-shutdown");
        shutdownCtx.ui.setWidget(EXTENSION_NAME, undefined);
        bus.removeAllListeners("pi-better-plan:changed");
        legacyListenerGone = bus.listenerCount("pi-better-plan:changed") === 0;
      }],
    }, legacy.entry);
    const harnessRecord = record({ session_start: [sessionStart] }, harness.entry, { tools });
    const loader = loaderWith(loadedResult([legacyRecord, harnessRecord]));
    assert.deepEqual(loader.getExtensions().extensions, [harnessRecord], "the retired record is filtered out");

    await sessionStart({}, ctx);
    assert.deepEqual(order, ["legacy-shutdown", "harness-body", "harness-body"], "legacy cleanup runs before registering either display or hooks control");
    assert.deepEqual(widgetCalls.map(call => call.key), [EXTENSION_NAME, "background-work-list"]);
    assert.equal(widgetCalls[0]!.content, undefined, "the retired widget is cleared first");
    assert.equal(typeof widgetCalls[1]!.content, "function", "the Harness Todo widget is installed after");
    assert.equal(legacyListenerGone, true);
  } finally {
    await handlers.get("session_shutdown")!({}, ctx);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
  assert.equal(activeMaskState(), undefined, "session shutdown disposes the mask");
  assert.equal(DefaultResourceLoader.prototype.getExtensions.name, "getExtensions");
});
