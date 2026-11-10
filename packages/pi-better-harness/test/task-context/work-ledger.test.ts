import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Worker } from "node:worker_threads";

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import extension from "../../extensions/task-context/index.js";
import {
  openWorkLedgerStore, workLedgerTotals, WorkLedgerRevisionConflictError,
} from "../../extensions/task-context/work-ledger.js";

const MODULE_URL = new URL("../../extensions/task-context/work-ledger.ts", import.meta.url).href;
const WORKER_URL = new URL("./work-ledger-worker.mjs", import.meta.url);

interface Fixture {
  root: string;
  cwd: string;
  agentDir: string;
}

function fixture(t: TestContext): Fixture {
  const root = mkdtempSync(join(tmpdir(), "work-ledger-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(cwd, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, cwd, agentDir };
}

function clock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
}

test("a created ledger is project-scoped and readable after reopening the store", (t) => {
  const f = fixture(t);
  const store = openWorkLedgerStore({ cwd: f.cwd, agentDir: f.agentDir, now: clock() });
  const created = store.create({
    outcome: "Deliver checkout",
    boundaries: ["No production writes"],
    items: [
      {
        id: "api",
        title: "Ship API",
        completion: ["Contract tests pass"],
        progress: "Contract drafted",
        nextStep: "Implement handler",
      },
      { id: "docs", title: "Ship docs" },
    ],
  });

  assert.match(created.id, /^ledger_[a-z0-9]+_[a-f0-9]+$/);
  assert.equal(created.revision, 1);
  assert.equal(created.status, "active");
  assert.deepEqual(created.boundaries, ["No production writes"]);
  assert.deepEqual(created.items[0]!.completion, ["Contract tests pass"]);
  assert.equal(created.items[0]!.progress, "Contract drafted");
  assert.equal(created.items[0]!.nextStep, "Implement handler");

  const reopened = openWorkLedgerStore({ cwd: f.cwd, agentDir: f.agentDir });
  assert.deepEqual(reopened.read(created.id), created);
  assert.deepEqual(reopened.list().map((ledger) => ledger.id), [created.id]);
  assert.deepEqual(reopened.list()[0]!.totals, {
    total: 2, open: 2, pending: 2, inProgress: 0, blocked: 0, completed: 0, cancelled: 0,
  });
  assert.equal(existsSync(join(f.agentDir, "work-ledgers")), true, "ledgers persist in the Pi agent directory");
  assert.deepEqual(readdirSync(f.cwd), [], "a ledger must not write into the project working tree");

  const otherCwd = join(f.root, "other-project");
  mkdirSync(otherCwd, { recursive: true });
  const other = openWorkLedgerStore({ cwd: otherCwd, agentDir: f.agentDir });
  assert.deepEqual(other.list(), [], "another project must not discover this ledger");
  assert.throws(() => other.read(created.id), /not found/);
});

test("a partial item update preserves untouched items, completed evidence, totals, and history", (t) => {
  const f = fixture(t);
  const store = openWorkLedgerStore({ cwd: f.cwd, agentDir: f.agentDir, now: clock() });
  const created = store.create({
    outcome: "Deliver checkout",
    boundaries: ["No production writes"],
    items: [
      {
        id: "api",
        title: "Ship API",
        status: "completed",
        completion: ["Contract tests pass"],
        evidence: ["Contract tests passed"],
      },
      {
        id: "worker",
        title: "Ship worker",
        status: "blocked",
        blocker: "Queue permissions missing",
        recovery: "Queue permissions granted",
      },
      { id: "join", title: "Integrate", completion: ["End-to-end path passes"] },
    ],
  });
  const before = structuredClone(created);

  const updated = store.update({
    ledgerId: created.id,
    revision: 1,
    event: "item-progress",
    changes: [{ id: "join", status: "in_progress", progress: "Wiring retries", nextStep: "Run end-to-end test" }],
  });

  assert.equal(updated.revision, 2);
  assert.equal(updated.outcome, before.outcome);
  assert.deepEqual(updated.boundaries, before.boundaries);
  assert.deepEqual(updated.items[0], before.items[0], "the completed item and its evidence stay unchanged");
  assert.deepEqual(updated.items[1], before.items[1], "the blocked item and its recovery condition stay unchanged");
  assert.equal(updated.items[2]!.status, "in_progress");
  assert.equal(updated.items[2]!.progress, "Wiring retries");
  assert.equal(updated.items[2]!.nextStep, "Run end-to-end test");
  assert.equal(updated.history.length, 2);
  assert.deepEqual(updated.history[1], {
    revision: 2,
    at: updated.updatedAt,
    event: "item-progress",
    ledgerFields: [],
    items: [{
      id: "join", fields: ["status", "progress", "nextStep"], fromStatus: "pending", toStatus: "in_progress",
    }],
    totals: { total: 3, open: 2, pending: 0, inProgress: 1, blocked: 1, completed: 1, cancelled: 0 },
  });

  const revised = store.update({
    ledgerId: created.id,
    revision: 2,
    event: "scope-change",
    outcome: "Deliver checkout and refunds",
    boundaries: ["No production writes", "No schema migrations"],
  });
  assert.equal(revised.outcome, "Deliver checkout and refunds");
  assert.deepEqual(revised.boundaries, ["No production writes", "No schema migrations"]);
  assert.deepEqual(revised.items, updated.items, "outcome and boundary edits must not reset any item");
  assert.deepEqual(revised.history[2]!.ledgerFields, ["outcome", "boundaries"]);
  assert.deepEqual(revised.history[2]!.totals, updated.history[1]!.totals, "an outcome edit must not change totals");

  const completed = store.update({
    ledgerId: created.id,
    revision: 3,
    changes: [{ id: "join", status: "completed", evidence: ["End-to-end test passed"] }],
  });
  assert.deepEqual(completed.items[0], before.items[0]);
  assert.deepEqual(completed.items[2]!.evidence, ["End-to-end test passed"]);
  assert.equal(completed.history.length, 4);
  assert.deepEqual(workLedgerTotals(completed), {
    total: 3, open: 1, pending: 0, inProgress: 0, blocked: 1, completed: 2, cancelled: 0,
  });

  const resumed = store.update({
    ledgerId: created.id,
    revision: 4,
    changes: [{ id: "worker", status: "in_progress", blocker: null, recovery: null, progress: "Queue permissions granted" }],
  });
  assert.equal(resumed.items[1]!.status, "in_progress");
  assert.equal(resumed.items[1]!.blocker, null);
  assert.equal(resumed.items[1]!.recovery, null);
  assert.deepEqual(resumed.items[0], before.items[0]);
  assert.deepEqual(resumed.items[2], completed.items[2]);
  assert.deepEqual(workLedgerTotals(resumed), {
    total: 3, open: 1, pending: 0, inProgress: 1, blocked: 0, completed: 2, cancelled: 0,
  });
});

test("a stale revision is refused atomically and leaves newer progress unchanged", (t) => {
  const f = fixture(t);
  const store = openWorkLedgerStore({ cwd: f.cwd, agentDir: f.agentDir, now: clock() });
  const created = store.create({
    outcome: "Deliver checkout",
    items: [{ id: "api", title: "Ship API" }, { id: "docs", title: "Ship docs" }],
  });
  const current = store.update({
    ledgerId: created.id,
    revision: 1,
    changes: [{ id: "api", progress: "Newer progress" }],
  });
  const snapshot = structuredClone(current);

  assert.throws(
    () => store.update({
      ledgerId: created.id,
      revision: 1,
      changes: [{ id: "docs", progress: "Stale progress" }],
    }),
    (error: unknown) => error instanceof WorkLedgerRevisionConflictError &&
      error.code === "work-ledger-revision-conflict" &&
      error.expected === 1 && error.actual === 2,
  );
  assert.deepEqual(store.read(created.id), snapshot, "a refused stale update must not change the stored ledger");
  assert.equal(snapshot.history.length, 2);

  assert.throws(
    () => store.update({ ledgerId: created.id, revision: 2, changes: [{ id: "missing", progress: "x" }] }),
    /Unknown work item/,
  );
  assert.throws(
    () => store.update({ ledgerId: created.id, revision: 2, changes: [{ id: "docs", status: "completed" }] }),
    /cannot be completed without evidence/,
  );
  assert.throws(
    () => store.update({
      ledgerId: created.id,
      revision: 2,
      changes: [{ id: "docs", status: "blocked", blocker: "Waiting for review" }],
    }),
    /record both blocker and recovery/,
  );
  assert.deepEqual(store.read(created.id), snapshot, "invalid updates must not change the stored ledger");
});

test("adding and cancelling items keeps stable records and requires an explicit outcome completion", (t) => {
  const f = fixture(t);
  const store = openWorkLedgerStore({ cwd: f.cwd, agentDir: f.agentDir, now: clock() });
  const created = store.create({
    outcome: "Deliver checkout",
    items: [{
      id: "deliver",
      title: "Deliver checkout",
      status: "completed",
      completion: ["Release is live"],
      evidence: ["Release 1.2.0 deployed"],
    }],
  });

  const added = store.update({
    ledgerId: created.id,
    revision: 1,
    event: "scope-change",
    addItems: [{ id: "follow-up", title: "Add refund audit" }],
  });
  assert.equal(added.revision, 2);
  assert.equal(added.items[1]!.id, "follow-up");
  assert.deepEqual(added.items[0], created.items[0], "an added item must not reset the completed record");
  assert.deepEqual(added.history[1]!.items, [{ id: "follow-up", fields: ["created"], added: true }]);
  assert.deepEqual(added.history[1]!.totals, {
    total: 2, open: 1, pending: 1, inProgress: 0, blocked: 0, completed: 1, cancelled: 0,
  });
  assert.throws(
    () => store.update({ ledgerId: created.id, revision: 2, status: "completed" }),
    /items remain open/,
  );

  const cancelled = store.update({
    ledgerId: created.id,
    revision: 2,
    changes: [{ id: "follow-up", status: "cancelled" }],
  });
  assert.equal(cancelled.items[0]!.status, "completed");
  assert.equal(cancelled.items[1]!.status, "cancelled");
  assert.deepEqual(cancelled.history[2]!.items[0], {
    id: "follow-up", fields: ["status"], fromStatus: "pending", toStatus: "cancelled",
  });
  assert.deepEqual(cancelled.history[2]!.totals, {
    total: 2, open: 0, pending: 0, inProgress: 0, blocked: 0, completed: 1, cancelled: 1,
  });
  assert.deepEqual(workLedgerTotals(cancelled), {
    total: 2, open: 0, pending: 0, inProgress: 0, blocked: 0, completed: 1, cancelled: 1,
  });

  const completed = store.update({ ledgerId: created.id, revision: 3, status: "completed", event: "outcome-completed" });
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.items[0], created.items[0], "the completed record and evidence survive outcome completion");
  assert.equal(completed.history.length, 4);
  assert.equal(completed.history[3]!.ledgerFields[0], "status");
});

test("competing writers cannot both accept the same revision", { timeout: 20_000 }, async (t) => {
  const f = fixture(t);
  const store = openWorkLedgerStore({ cwd: f.cwd, agentDir: f.agentDir, now: clock() });
  const created = store.create({
    outcome: "Deliver checkout",
    items: [{ id: "api", title: "Ship API" }, { id: "docs", title: "Ship docs" }],
  });
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const workers: Worker[] = [];

  const spawn = (id: string, progress: string) => {
    let ready!: () => void;
    const isReady = new Promise<void>((resolve) => { ready = resolve; });
    let finish!: (value: Record<string, unknown>) => void;
    const isDone = new Promise<Record<string, unknown>>((resolve) => { finish = resolve; });
    const worker = new Worker(WORKER_URL, {
      workerData: {
        moduleUrl: MODULE_URL,
        options: { cwd: f.cwd, agentDir: f.agentDir },
        update: {
          ledgerId: created.id,
          revision: 1,
          changes: [{ id, progress }],
        },
        gate: gate.buffer,
      },
      execArgv: ["--import", "tsx"],
    });
    workers.push(worker);
    worker.on("message", (message: Record<string, unknown>) => {
      if (message?.type === "ready") ready();
      else if (message?.type === "done") finish(message);
    });
    worker.on("error", (error) => {
      ready();
      finish({ type: "done", ok: false, message: error.message });
    });
    worker.on("exit", (code) => {
      if (code !== 0) {
        ready();
        finish({ type: "done", ok: false, message: `worker exited with ${code}` });
      }
    });
    return { isReady, isDone };
  };

  t.after(() => { for (const worker of workers) void worker.terminate(); });
  const first = spawn("api", "First writer");
  const second = spawn("docs", "Second writer");
  await Promise.all([first.isReady, second.isReady]);
  Atomics.store(gate, 0, 1);
  Atomics.notify(gate, 0);
  const results = await Promise.all([first.isDone, second.isDone]);

  const accepted = results.filter((result) => result.ok === true);
  const refused = results.filter((result) => result.ok === false);
  assert.equal(accepted.length, 1, "exactly one competing writer may accept revision 1");
  assert.equal(refused.length, 1);
  assert.equal(refused[0]!.code, "work-ledger-revision-conflict");

  const final = store.read(created.id);
  assert.equal(final.revision, 2);
  assert.equal(final.history.length, 2, "the refused writer must not add a revision or history entry");
  assert.equal(workLedgerTotals(final).total, 2);
});

interface SettingControl {
  id: string;
  get(): string;
  change(value: string, ctx: ExtensionContext): Promise<void>;
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: any;
}

async function extensionFixture(t: TestContext) {
  const f = fixture(t);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });

  const entries: Array<{ type: string; customType?: string; data?: unknown }> = [];
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const events = new EventEmitter();
  let activeTools = ["read"];
  let setting: SettingControl | undefined;
  events.on("harness-settings:register", (control: SettingControl) => {
    if (control?.id === "outcome-todo") setting = control;
  });
  const ctx = {
    cwd: f.cwd,
    mode: "print",
    hasUI: false,
    sessionManager: { getBranch: () => entries },
    ui: { setWidget: () => undefined, setStatus: () => undefined, notify: () => undefined },
  } as unknown as ExtensionContext;
  const pi = {
    events,
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    registerCommand() {},
    on(event: string, handler: (event: any, context: ExtensionContext) => unknown) { handlers.set(event, handler); },
    getActiveTools: () => activeTools,
    setActiveTools: (next: string[]) => { activeTools = next; },
  } as unknown as ExtensionAPI;

  extension(pi);
  const start = async () => handlers.get("session_start")?.({ reason: "startup" }, ctx);
  const reload = async () => {
    await handlers.get("session_shutdown")?.({ reason: "reload" }, ctx);
    handlers.clear();
    tools.clear();
    extension(pi);
    await start();
  };
  await start();
  return {
    ...f,
    entries,
    tools,
    events,
    ctx,
    start,
    reload,
    setting: () => setting,
    active: () => activeTools,
  };
}

test("the registered work_ledger tool preserves items and history across reload without adopting session work", async (t) => {
  const f = await extensionFixture(t);
  assert.deepEqual(f.active(), ["read"], "the project work ledger stays inactive while hooks are off");
  const disabledTool = f.tools.get("work_ledger");
  assert.ok(disabledTool);
  await assert.rejects(
    disabledTool.execute("create-disabled", { action: "create", outcome: "Should not persist" }, undefined, undefined, f.ctx),
    /hooks are off/,
  );

  await f.setting()!.change("On", f.ctx);
  assert.deepEqual(f.active(), ["read", "update_todo", "get_todo", "work_ledger"]);
  const updateTodo = f.tools.get("update_todo")!;
  const getTodo = f.tools.get("get_todo")!;
  const ledgerTool = f.tools.get("work_ledger")!;

  await updateTodo.execute("generic-task", {
    outcome: { objective: "Session task", doneWhen: ["Session check passes"] },
    todo: [{ id: "session-step", step: "Session step", status: "in_progress" }],
  }, undefined, undefined, f.ctx);
  const genericTask = structuredClone((await getTodo.execute("generic-read", {}, undefined, undefined, f.ctx)).details);
  const taskEntries = f.entries.length;

  const created = await ledgerTool.execute("create-ledger", {
    action: "create",
    outcome: "Deliver checkout",
    boundaries: ["No production writes"],
    items: [
      {
        id: "api",
        title: "Ship API",
        completion: ["Contract tests pass"],
        progress: "Contract drafted",
        nextStep: "Implement handler",
      },
      { id: "docs", title: "Ship docs", completion: ["Docs published"] },
    ],
  }, undefined, undefined, f.ctx) as ToolResult;
  assert.equal(f.entries.length, taskEntries, "work_ledger must not write session custom entries");
  const ledgerId = created.details.ledger.id as string;
  assert.equal(created.details.ledger.revision, 1);
  const untouched = structuredClone(created.details.ledger.items[1]);

  const read = await ledgerTool.execute("read-ledger", {
    action: "read", ledgerId,
  }, undefined, undefined, f.ctx) as ToolResult;
  assert.deepEqual(read.details.ledger, created.details.ledger);

  const updated = await ledgerTool.execute("update-ledger", {
    action: "update",
    ledgerId,
    revision: 1,
    event: "item-progress",
    changes: [{ id: "api", status: "completed", progress: "Handler merged", evidence: ["Focused tests passed"] }],
  }, undefined, undefined, f.ctx) as ToolResult;
  assert.equal(updated.details.ledger.revision, 2);
  assert.deepEqual(updated.details.ledger.items[1], untouched, "an unrelated item is preserved");
  assert.deepEqual(updated.details.ledger.items[0].evidence, ["Focused tests passed"]);
  assert.equal(updated.details.ledger.history.length, 2);
  assert.equal(updated.details.ledger.items.length, 2);

  const genericAfter = (await getTodo.execute("generic-after", {}, undefined, undefined, f.ctx)).details;
  assert.deepEqual(genericAfter, genericTask, "ledger updates must not change generic outcome/todo state");
  await assert.rejects(
    ledgerTool.execute("stale-ledger", {
      action: "update",
      ledgerId,
      revision: 1,
      changes: [{ id: "docs", progress: "Stale progress" }],
    }, undefined, undefined, f.ctx),
    /revision mismatch/,
  );

  await f.reload();
  const restoredTool = f.tools.get("work_ledger")!;
  const restored = await restoredTool.execute("read-after-reload", {
    action: "read", ledgerId,
  }, undefined, undefined, f.ctx) as ToolResult;
  assert.deepEqual(restored.details.ledger, updated.details.ledger, "reload restores the same durable ledger");
  const listed = await restoredTool.execute("list-after-reload", {
    action: "list",
  }, undefined, undefined, f.ctx) as ToolResult;
  assert.deepEqual(listed.details.ledgers.map((ledger: { id: string }) => ledger.id), [ledgerId]);
  const genericRestored = (await f.tools.get("get_todo")!.execute("generic-restored", {}, undefined, undefined, f.ctx)).details;
  assert.deepEqual(genericRestored, genericTask, "reload must not associate the ledger with the session");
  assert.equal(f.entries.length, taskEntries, "reload must not persist or adopt ledger work as session entries");
});
