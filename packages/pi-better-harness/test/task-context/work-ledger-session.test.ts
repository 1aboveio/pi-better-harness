import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import extension, { ledgerArgumentCompletions } from "../../extensions/task-context/index.js";
import { openWorkLedgerStore, type WorkLedger } from "../../extensions/task-context/work-ledger.js";
import {
  WORK_LEDGER_ASSOCIATION_ENTRY,
  WORK_LEDGER_REMINDER_MESSAGE,
  formatWorkLedgerReminder,
  restoreWorkLedgerAssociation,
  workLedgerAssociationEntry,
} from "../../extensions/task-context/work-ledger-session.js";

interface Fixture {
  root: string;
  cwd: string;
  agentDir: string;
}

function fixture(t: TestContext): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ledger-session-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, cwd, agentDir };
}

function clock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
}

function createLedger(f: Fixture, items = [
  { id: "api", title: "Ship API", status: "in_progress" as const, nextStep: "Implement handler" },
  { id: "docs", title: "Ship docs" },
]): WorkLedger {
  return openWorkLedgerStore({ cwd: f.cwd, agentDir: f.agentDir, now: clock() }).create({
    outcome: "Deliver checkout",
    boundaries: ["No production writes"],
    items,
  });
}

interface SettingControl {
  id: string;
  get(): string;
  change(value: string, ctx: ExtensionContext): Promise<void>;
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: any;
}

interface SessionState {
  branch: any[];
  context: any[];
}

function harness(t: TestContext, f: Fixture, options: {
  preferences?: { enabled: boolean; display: boolean; ledger?: boolean };
  branch?: any[];
  context?: any[];
  hasUI?: boolean;
} = {}) {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.agentDir;
  if (options.preferences) {
    writeFileSync(join(f.agentDir, "settings.json"), JSON.stringify({
      quietStartup: true,
      piBetterHarness: { outcomeTodo: { version: 1, ...options.preferences } },
    }));
  }

  const session: SessionState = {
    branch: options.branch ?? [],
    context: options.context ?? [...(options.branch ?? [])],
  };
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, (event: any, ctx?: ExtensionContext) => unknown>();
  const events = new EventEmitter();
  const notices: Array<{ text: string; level: string }> = [];
  const sent: Array<{ message: any; options: any }> = [];
  const widgets = new Map<string, any>();
  let settings: SettingControl | undefined;
  const settingControls = new Map<string, SettingControl>();
  let active = ["read"];
  let userMessages = 0;
  events.on("harness-settings:register", (control: SettingControl) => {
    if (control?.id) settingControls.set(control.id, control);
    if (control?.id === "outcome-todo") settings = control;
  });
  const append = (entry: any): void => {
    session.branch.push(entry);
    session.context.push(entry);
  };
  const ctx: any = {
    cwd: f.cwd,
    mode: options.hasUI ? "tui" : "print",
    hasUI: options.hasUI === true,
    isIdle: () => true,
    sessionManager: {
      getBranch: () => session.branch,
      buildContextEntries: () => session.context,
      getSessionId: () => "ledger-session-fixture",
    },
    ui: {
      notify: (text: string, level = "info") => notices.push({ text, level }),
      setWidget: (key: string, content: any) => widgets.set(key, content),
      setStatus: () => undefined,
      custom: async (factory: any) => {
        const component = factory({ requestRender() {} }, { fg: (_color: string, value: string) => value }, {}, () => {});
        notices.push({ text: component.render(100).join("\n"), level: "full" });
      },
    },
  };
  const pi: any = {
    events,
    appendEntry(customType: string, data: unknown) { append({ type: "custom", customType, data }); },
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    on(name: string, handler: (event: any, context?: ExtensionContext) => unknown) { handlers.set(name, handler); },
    getActiveTools: () => active,
    setActiveTools: (next: string[]) => { active = next; },
    sendMessage(message: any, sendOptions: any) {
      sent.push({ message, options: sendOptions });
      append({ type: "custom_message", ...message });
    },
    sendUserMessage() { userMessages += 1; },
  };
  const start = async (reason = "startup") => {
    await handlers.get("session_start")?.({ reason }, ctx);
  };
  const shutdown = async () => {
    await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
  };
  const reload = async (reason = "resume") => {
    await shutdown();
    handlers.clear();
    tools.clear();
    commands.clear();
    extension(pi);
    await start(reason);
  };
  extension(pi);
  t.after(async () => {
    await shutdown();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });

  const command = async (text: string) => commands.get("ledger")?.handler(text, ctx);
  const todoCommand = async (text = "") => commands.get("todo")?.handler(text, ctx);
  const get = async (): Promise<ToolResult> => tools.get("get_todo")!.execute("get", {}, undefined, undefined, ctx) as Promise<ToolResult>;
  const update = async (input: any): Promise<ToolResult> => tools.get("update_todo")!.execute("update", input, undefined, undefined, ctx) as Promise<ToolResult>;
  const mutateLedger = async (ledger: any): Promise<ToolResult> =>
    tools.get("update_todo")!.execute("ledger", { ledger }, undefined, undefined, ctx) as Promise<ToolResult>;
  const queryLedger = async (ledger: any): Promise<ToolResult> =>
    tools.get("get_todo")!.execute("ledger-query", { ledger }, undefined, undefined, ctx) as Promise<ToolResult>;
  const enable = async () => {
    if (settings?.get() !== "On") await settings!.change("On", ctx);
  };
  const enableLedger = async () => {
    const control = settingControls.get("outcome-todo-ledger");
    if (control?.get() !== "On") await control!.change("On", ctx);
  };
  return {
    f, session, tools, commands, handlers, events, notices, sent, widgets, ctx, pi,
    settings: () => settings,
    control: (id: string) => settingControls.get(id),
    active: () => active,
    userMessages: () => userMessages,
    start, shutdown, reload, command, todoCommand, get, update, mutateLedger, queryLedger, enable, enableLedger,
    append,
    render: (width = 100) => {
      const factory = widgets.get("background-work-list");
      if (!factory) return [];
      const component = factory({ requestRender() {} }, { fg: (_color: string, value: string) => value });
      return component.render(width) as string[];
    },
  };
}

test("session association is a deliberate reference with latest-wins restore semantics", () => {
  assert.equal(restoreWorkLedgerAssociation([]), null);
  assert.equal(restoreWorkLedgerAssociation([
    { type: "custom", customType: WORK_LEDGER_ASSOCIATION_ENTRY, data: workLedgerAssociationEntry("ledger_a_01") },
  ]), "ledger_a_01");
  assert.equal(restoreWorkLedgerAssociation([
    { type: "custom", customType: WORK_LEDGER_ASSOCIATION_ENTRY, data: workLedgerAssociationEntry("ledger_a_01") },
    { type: "custom", customType: WORK_LEDGER_ASSOCIATION_ENTRY, data: workLedgerAssociationEntry(null) },
  ]), null);
  assert.equal(restoreWorkLedgerAssociation([
    { type: "custom", customType: WORK_LEDGER_ASSOCIATION_ENTRY, data: workLedgerAssociationEntry("ledger_a_01") },
    { type: "custom", customType: WORK_LEDGER_ASSOCIATION_ENTRY, data: workLedgerAssociationEntry("ledger_b_02") },
  ]), "ledger_b_02");
  assert.equal(restoreWorkLedgerAssociation([
    { type: "custom", customType: WORK_LEDGER_ASSOCIATION_ENTRY, data: workLedgerAssociationEntry("ledger_a_01") },
    { type: "custom", customType: WORK_LEDGER_ASSOCIATION_ENTRY, data: { version: 2, kind: "attach", ledgerId: "ledger_b_02" } },
    { type: "custom", customType: WORK_LEDGER_ASSOCIATION_ENTRY, data: { version: 1, kind: "attach", ledgerId: "not-a-ledger" } },
    { type: "custom", customType: WORK_LEDGER_ASSOCIATION_ENTRY, data: { version: 1, kind: "unknown" } },
  ]), "ledger_a_01");
  assert.throws(() => workLedgerAssociationEntry("not-a-ledger"), /valid ledger id/);
  assert.deepEqual(ledgerArgumentCompletions("sw")?.map((entry) => entry.value), ["switch "]);
});

test("explicit attach restores the same durable record on resume while a fresh session stays unassociated", async (t) => {
  const f = fixture(t);
  const ledger = createLedger(f);
  const first = harness(t, f);
  await first.enable();
  await first.enableLedger();
  await first.command(`attach ${ledger.id}`);
  const restored = await first.get();
  assert.equal(restored.details.ledger.id, ledger.id);
  assert.equal(restored.details.ledger.revision, 1);
  assert.equal(restored.details.ledger.totals.open, 2);
  assert.match(restored.content[0]!.text, /Associated work ledger/);
  assert.equal(first.session.branch.filter((entry) => entry.customType === WORK_LEDGER_ASSOCIATION_ENTRY).length, 1);
  assert.ok(!JSON.stringify(first.session.branch).includes("\"items\""), "the session stores only a ledger reference, not a copy");
  assert.equal(openWorkLedgerStore({ cwd: f.cwd, agentDir: f.agentDir }).list().length, 1);

  first.session.context = first.session.context.filter((entry) =>
    !(entry.type === "custom_message" && entry.customType === WORK_LEDGER_REMINDER_MESSAGE));
  const sentBeforeResume = first.sent.length;
  await first.reload("resume");
  assert.equal(first.sent.length, sentBeforeResume + 1, "resume republishes a bounded reminder from the durable record");
  assert.equal(first.sent.at(-1)!.options.triggerTurn, false);
  const resumed = await first.get();
  assert.equal(resumed.details.ledger.id, ledger.id);
  assert.equal(resumed.details.ledger.revision, 1);
  assert.equal(first.session.branch.filter((entry) => entry.customType === WORK_LEDGER_ASSOCIATION_ENTRY).length, 1,
    "resume must not append another association or copy the ledger");
  assert.equal(openWorkLedgerStore({ cwd: f.cwd, agentDir: f.agentDir }).read(ledger.id).revision, 1);

  const fresh = harness(t, f, { preferences: { enabled: true, display: true, ledger: true } });
  await fresh.start("new");
  assert.equal((await fresh.get()).details.ledger, null, "a new session must not adopt a project ledger automatically");
  assert.deepEqual(fresh.session.branch, [], "a new session stays unassociated and writes nothing");
  assert.equal(fresh.sent.length, 0, "discovery must not inject old work");
  await fresh.command("list");
  assert.match(fresh.notices.at(-1)!.text, new RegExp(ledger.id));
  const discovered = await fresh.queryLedger({ action: "list" });
  assert.deepEqual(discovered.details.ledgerQuery.ledgers.map((item: { id: string }) => item.id), [ledger.id],
    "get_todo ledger list discovers the project record without associating it");
  await fresh.command(`attach ${ledger.id}`);
  assert.equal((await fresh.get()).details.ledger.id, ledger.id);
  const updated = await fresh.mutateLedger({
    action: "update",
    ledgerId: ledger.id,
    revision: 1,
    event: "continued",
    changes: [{ id: "api", progress: "Continued in the selected session" }],
  });
  assert.equal(updated.details.ledger.revision, 2);
  const stored = openWorkLedgerStore({ cwd: f.cwd, agentDir: f.agentDir });
  assert.equal(stored.list().length, 1, "continuing must not create a second ledger");
  assert.equal(stored.read(ledger.id).history.length, 2, "the selected record keeps its identity and history");
});

test("compaction rebuilds bounded reminders from durable state and context removes stale ledger instructions", async (t) => {
  const f = fixture(t);
  const items = [
    { id: "done", title: "Completed slice", status: "completed" as const, evidence: ["Tests passed"] },
    ...Array.from({ length: 12 }, (_, index) => ({
      id: `open_${index + 1}`,
      title: `Open item ${index + 1}`,
      status: index === 0 ? "in_progress" as const : "pending" as const,
      nextStep: `Next action ${index + 1}`,
    })),
  ];
  const ledger = createLedger(f, items);
  const h = harness(t, f, { preferences: { enabled: true, display: true, ledger: true } });
  await h.start();
  await h.command(`attach ${ledger.id}`);
  const firstReminder = h.sent.at(-1)!;
  assert.equal(firstReminder.message.customType, WORK_LEDGER_REMINDER_MESSAGE);
  assert.equal(firstReminder.options.triggerTurn, false);
  assert.match(firstReminder.message.content, /rebuild|rebuilt from durable state/);
  assert.match(firstReminder.message.content, /Open item 1/);
  assert.doesNotMatch(firstReminder.message.content, /Open item 12/);
  assert.match(firstReminder.message.content, /more open item/);
  assert.ok(firstReminder.message.content.length <= 1_600);
  assert.match(firstReminder.message.content, /does not authorize work/);
  assert.match(firstReminder.message.content, /resume a paused Goal/);

  const store = openWorkLedgerStore({ cwd: f.cwd, agentDir: f.agentDir });
  store.update({
    ledgerId: ledger.id,
    revision: 1,
    event: "newer-progress",
    changes: [{ id: "open_1", progress: "Handler merged" }],
  });
  // Simulate compaction: the branch keeps history, but the active context no
  // longer contains the reminder or the old outcome message.
  h.session.context = [{ type: "compaction", summary: "Conversation summary only" }];
  await h.handlers.get("session_compact")!({ reason: "threshold", willRetry: false }, h.ctx);
  const compacted = h.sent.at(-1)!;
  assert.equal(compacted.message.details.ledgerId, ledger.id);
  assert.notEqual(compacted.message.content, firstReminder.message.content);
  assert.match(compacted.message.content, /rev 2/);
  assert.ok(h.sent.filter((entry) => entry.message.customType === WORK_LEDGER_REMINDER_MESSAGE).length >= 2);

  const old = { role: "custom", customType: WORK_LEDGER_REMINDER_MESSAGE, content: "old", details: { ledgerId: "ledger_old_00" } };
  const current = { role: "custom", customType: WORK_LEDGER_REMINDER_MESSAGE, content: "current", details: { ledgerId: ledger.id } };
  const other = { role: "custom", customType: WORK_LEDGER_REMINDER_MESSAGE, content: "other", details: { ledgerId: "ledger_other_00" } };
  const user = { role: "user", content: "Keep working" };
  const filtered = h.handlers.get("context")!({ messages: [old, other, current, user] }, h.ctx) as { messages: any[] };
  assert.deepEqual(filtered.messages, [current, user], "only the current ledger reminder survives");
  await h.command("detach");
  const detached = h.handlers.get("context")!({ messages: [old, current, user] }, h.ctx) as { messages: any[] };
  assert.deepEqual(detached.messages, [user], "detach removes every stale ledger instruction");

  await h.update({ outcome: { objective: "Deliver checkout" }, todo: [{ step: "Ship", status: "in_progress" }] });
  const outcomeMessage = await h.handlers.get("before_agent_start")!({}, h.ctx) as { message: any };
  assert.match(outcomeMessage.message.content, /Outcome \(active\)/);
  h.append({ type: "custom_message", ...outcomeMessage.message });
  assert.equal(await h.handlers.get("before_agent_start")!({}, h.ctx), undefined);
  h.session.context = [{ type: "compaction", summary: "Conversation summary only" }];
  const afterCompaction = await h.handlers.get("before_agent_start")!({}, h.ctx) as { message: any };
  assert.match(afterCompaction.message.content, /Outcome \(active\)/,
    "the durable outcome is reconstructed after compaction instead of trusting the summary");
});

test("switch, detach, and branch navigation restore the right reference and hide stale work", async (t) => {
  const f = fixture(t);
  const first = createLedger(f);
  const second = openWorkLedgerStore({ cwd: f.cwd, agentDir: f.agentDir, now: clock() }).create({
    outcome: "Deliver refunds",
    items: [{ id: "refund", title: "Ship refunds", status: "pending", nextStep: "Start refund work" }],
  });
  const h = harness(t, f, { preferences: { enabled: true, display: true, ledger: true } });
  await h.start();
  await h.command(`attach ${first.id}`);
  assert.equal((await h.get()).details.ledger.id, first.id);
  await h.command(`switch ${second.id}`);
  assert.equal((await h.get()).details.ledger.id, second.id);
  assert.match(h.sent.at(-1)!.message.content, new RegExp(second.id));
  assert.doesNotMatch(h.sent.at(-1)!.message.content, new RegExp(first.id));
  const context = h.handlers.get("context")!({ messages: [
    { role: "custom", customType: WORK_LEDGER_REMINDER_MESSAGE, content: "first", details: { ledgerId: first.id } },
    { role: "custom", customType: WORK_LEDGER_REMINDER_MESSAGE, content: "second", details: { ledgerId: second.id } },
  ] }, h.ctx) as { messages: any[] };
  assert.deepEqual(context.messages.map((message) => message.content), ["second"]);
  await h.command("detach");
  assert.equal((await h.get()).details.ledger, null);
  assert.deepEqual(h.handlers.get("context")!({ messages: [
    { role: "custom", customType: WORK_LEDGER_REMINDER_MESSAGE, content: "second", details: { ledgerId: second.id } },
    { role: "user", content: "continue" },
  ] }, h.ctx), { messages: [{ role: "user", content: "continue" }] }, "no stale ledger message remains after detach");

  const attachOnly = [{ type: "custom", customType: WORK_LEDGER_ASSOCIATION_ENTRY, data: workLedgerAssociationEntry(first.id) }];
  h.session.branch = attachOnly;
  h.session.context = [...attachOnly];
  await h.handlers.get("session_tree")!({}, h.ctx);
  assert.equal((await h.get()).details.ledger.id, first.id, "branch navigation restores that branch's association");
  const detachedBranch = [...attachOnly, { type: "custom", customType: WORK_LEDGER_ASSOCIATION_ENTRY, data: workLedgerAssociationEntry(null) }];
  h.session.branch = detachedBranch;
  h.session.context = [...detachedBranch];
  await h.handlers.get("session_tree")!({}, h.ctx);
  assert.equal((await h.get()).details.ledger, null);
});

test("completion reconciliation refuses the overall Outcome while high-level items remain open", async (t) => {
  const f = fixture(t);
  const ledger = createLedger(f);
  const h = harness(t, f, { preferences: { enabled: true, display: true, ledger: true } });
  await h.start();
  await h.command(`attach ${ledger.id}`);
  await h.update({
    outcome: { objective: "Deliver checkout", doneWhen: ["Checkout works"] },
    todo: [{ step: "Run checkout path", status: "completed" }],
  });
  const before = structuredClone(h.session.branch);
  await assert.rejects(
    h.update({ outcome: { objective: "Deliver checkout", status: "complete" } }),
    /still has 2 open high-level item/,
  );
  assert.deepEqual(h.session.branch, before, "a refused completion writes no Outcome entry");
  assert.equal((await h.get()).details.outcome.status, "active");
  assert.equal(openWorkLedgerStore({ cwd: f.cwd, agentDir: f.agentDir }).read(ledger.id).status, "active",
    "completing the Todo does not complete the high-level ledger");

  const store = openWorkLedgerStore({ cwd: f.cwd, agentDir: f.agentDir });
  store.update({
    ledgerId: ledger.id,
    revision: 1,
    changes: [{ id: "api", status: "completed", evidence: ["Focused API test passed"] }],
  });
  await assert.rejects(
    h.update({ outcome: { objective: "Deliver checkout", status: "complete" } }),
    /still has 1 open high-level item/,
  );
  store.update({
    ledgerId: ledger.id,
    revision: 2,
    changes: [{ id: "docs", status: "cancelled" }],
  });
  await h.update({ outcome: { objective: "Deliver checkout", status: "complete" } });
  assert.equal((await h.get()).details.outcome.status, "complete");
  const stored = store.read(ledger.id);
  assert.equal(stored.status, "active", "closing items does not silently complete the overall ledger");
  assert.equal(stored.items[0]!.status, "completed");
  assert.deepEqual(stored.items[0]!.evidence, ["Focused API test passed"]);

  await h.update({ outcome: { objective: "Investigate refunds" }, newTask: true });
  assert.equal((await h.get()).details.ledger, null, "starting unrelated work detaches the old ledger reference");
  assert.ok(h.session.branch.some((entry) => entry.customType === WORK_LEDGER_ASSOCIATION_ENTRY &&
    (entry.data as any).kind === "detach"));
});

test("association does not start work, change a paused Goal, or alter hooks/display preferences", async (t) => {
  const f = fixture(t);
  const ledger = createLedger(f);
  writeFileSync(join(f.agentDir, "settings.json"), JSON.stringify({
    quietStartup: true,
    piBetterHarness: { outcomeTodo: { version: 1, enabled: false, display: true } },
  }));
  const goalEntry = {
    type: "custom", customType: "pi-better-goal",
    data: { version: 1, kind: "set", goal: { goalId: "goal-paused", objective: "Original trigger", status: "paused" } },
  };
  const h = harness(t, f, { branch: [goalEntry] });
  await h.start("resume");
  await h.enableLedger();
  const preferencesBefore = readFileSync(join(f.agentDir, "settings.json"), "utf8");
  await h.command(`attach ${ledger.id}`);
  assert.match(h.notices.at(-1)!.text, new RegExp(ledger.id));
  assert.equal(h.sent.length, 0, "hooks off must not inject ledger context");
  assert.equal(h.userMessages(), 0, "association never starts an agent turn");
  assert.equal(readFileSync(join(f.agentDir, "settings.json"), "utf8"), preferencesBefore,
    "association must not rewrite independent hooks/display preferences");
  const update = await h.handlers.get("before_agent_start")!({}, h.ctx);
  assert.equal(update, undefined, "hooks off also suppresses the outcome reminder");

  await h.enable();
  assert.equal(h.sent.length, 1, "enabling hooks publishes the current ledger reference once");
  assert.equal(h.sent[0]!.options.triggerTurn, false);
  assert.equal(h.userMessages(), 0);
  assert.equal(h.settings()!.get(), "On");
  assert.ok(h.session.branch.some((entry) => entry.customType === "pi-better-goal"), "Goal entries are untouched");
  const pausedOutcome = h.handlers.get("before_agent_start")!({}, h.ctx) as { message: { content: string } };
  assert.match(pausedOutcome.message.content, /Outcome \(paused\)/, "a paused Goal keeps its lifecycle state");
});

test("update_todo ledger attach and detach are explicit actions and get_todo list marks the session reference", async (t) => {
  const f = fixture(t);
  const ledger = createLedger(f);
  const h = harness(t, f, { preferences: { enabled: true, display: true, ledger: true } });
  await h.start();
  await h.mutateLedger({ action: "create", outcome: "Other project work" });
  const listedBefore = await h.queryLedger({ action: "list" });
  assert.doesNotMatch(listedBefore.content[0]!.text, /ledger_.*\[associated/);
  await h.mutateLedger({ action: "attach", ledgerId: ledger.id });
  assert.ok(h.session.branch.some((entry) => entry.customType === WORK_LEDGER_ASSOCIATION_ENTRY &&
    (entry.data as any).ledgerId === ledger.id));
  assert.equal((await h.get()).details.ledger.id, ledger.id);
  const listedAfter = await h.queryLedger({ action: "list" });
  assert.equal(listedAfter.details.ledgerQuery.associatedLedgerId, ledger.id);
  assert.match(listedAfter.content[0]!.text, new RegExp(`${ledger.id}.*\\[associated with this session\\]`));
  await assert.rejects(
    h.mutateLedger({ action: "attach", ledgerId: "ledger_missing_00" }),
    /not found/,
  );
  await assert.rejects(
    h.mutateLedger({ action: "attach", ledgerId: ledger.id, revision: 1 }),
    /takes ledgerId only/,
  );
  await h.mutateLedger({ action: "detach" });
  assert.equal((await h.get()).details.ledger, null);
  assert.equal((await h.queryLedger({ action: "list" })).details.ledgerQuery.associatedLedgerId, null);
  assert.match((await h.queryLedger({ action: "list" })).content[0]!.text, new RegExp(ledger.id));
});

test("an associated ledger stays additive to the workflow's canonical plan", async (t) => {
  const f = fixture(t);
  const planPath = join(f.cwd, ".resolve-issues", "rush", "run-1", "task-plan.json");
  mkdirSync(join(f.cwd, ".resolve-issues", "rush", "run-1"), { recursive: true });
  writeFileSync(planPath, JSON.stringify({
    planRevision: 1,
    runId: "run-1",
    issues: [{ id: "1", title: "Ship workflow slice", stage: "implement", status: "in-flight", delivery: "building" }],
    fleet: { implement: { status: "in-flight" } },
  }));
  const workflowEntries = [
    { type: "custom", customType: "pi-better-workflow", data: { version: 1, kind: "set", owner: { name: "fixture", planOwner: "workflow" } } },
    { type: "custom", customType: "pi-better-workflow-plan", data: { version: 1, kind: "set", owner: "fixture", path: planPath, runId: "run-1" } },
  ];
  const h = harness(t, f, { branch: workflowEntries, preferences: { enabled: true, display: true, ledger: true } });
  await h.start("resume");
  const ledger = createLedger(f);
  const planBefore = readFileSync(planPath, "utf8");
  const workflowBefore = h.session.branch.filter((entry) => entry.customType?.startsWith("pi-better-workflow")).length;
  await h.command(`attach ${ledger.id}`);
  const todo = await h.get();
  assert.equal(todo.details.workflowOwner, "fixture");
  assert.equal(todo.details.hasPlan, true);
  assert.equal(todo.details.ledger.id, ledger.id);
  assert.match(todo.content[0]!.text, /fixture · rev 1/);
  assert.match(todo.content[0]!.text, /Ship workflow slice/);
  assert.match(todo.content[0]!.text, /implement · in-flight · building/,
    "workflow stage, status, and delivery still come from workflow-plan.ts");
  assert.match(todo.content[0]!.text, new RegExp(ledger.id));
  await h.todoCommand();
  const fullView = h.notices.at(-1)!.text;
  assert.match(fullView, /implement · in-flight · building/, "the full view keeps the same workflow stage projection");
  assert.match(fullView, new RegExp(ledger.id), "the full view shows workflow rows with ledger context");
  assert.equal(readFileSync(planPath, "utf8"), planBefore, "association must not rewrite the canonical workflow plan");
  assert.equal(h.session.branch.filter((entry) => entry.customType?.startsWith("pi-better-workflow")).length, workflowBefore,
    "association adds no workflow binding or ownership entry");
  await assert.rejects(
    h.update({ todo: [{ step: "Replace workflow", status: "in_progress" }] }),
    /fixture owns the task plan/,
  );
  const store = openWorkLedgerStore({ cwd: f.cwd, agentDir: f.agentDir });
  store.update({ ledgerId: ledger.id, revision: 1, changes: [{ id: "api", progress: "Ledger-only progress" }] });
  assert.equal(readFileSync(planPath, "utf8"), planBefore, "ledger progress remains separate from the execution plan");
  assert.match((await h.get()).content[0]!.text, /Deliver checkout/);
});

test("ordinary Todo rows gain no engineering stage model", async (t) => {
  const f = fixture(t);
  const h = harness(t, f, { preferences: { enabled: true, display: true, ledger: false } });
  await h.start();
  await h.update({ todo: [{ id: "write", step: "Write the note", status: "in_progress" }] });
  const todo = await h.get();
  assert.deepEqual(Object.keys(todo.details.plan.steps[0]).sort(), ["id", "status", "step"],
    "a generic item keeps identity, label, and status without an engineering stage");
  assert.doesNotMatch(todo.content[0]!.text, /\b(?:stage|delivery)\b/i);
});

test("association survives independent display and hooks controls", async (t) => {
  const f = fixture(t);
  const ledger = createLedger(f);
  const h = harness(t, f, { hasUI: true, preferences: { enabled: false, display: true } });
  await h.start();
  assert.equal(h.control("outcome-todo-ledger")!.get(), "Off", "long-term ledger defaults off");
  await h.enableLedger();
  await h.command(`attach ${ledger.id}`);
  assert.equal(h.sent.length, 0, "hooks off does not inject a reminder");
  assert.match(h.render().join("\n"), /ledger 0\/2 complete · 2 open/);
  await h.control("outcome-todo-display")!.change("Off", h.ctx);
  assert.deepEqual(h.render(), [], "display off hides the existing Todo surface");
  await h.command("show");
  assert.match(h.notices.at(-1)!.text, new RegExp(ledger.id), "the association remains inspectable while hidden");
  await h.control("outcome-todo-display")!.change("On", h.ctx);
  assert.match(h.render().join("\n"), /ledger 0\/2 complete/);
  assert.equal(h.sent.length, 0, "toggling display does not enable hooks");
  await h.enable();
  assert.equal(h.sent.length, 1, "hooks on injects the durable reminder");
  await h.control("outcome-todo-display")!.change("Off", h.ctx);
  assert.deepEqual(h.render(), []);
  assert.equal((await h.get()).details.ledger.id, ledger.id, "display off does not clear the association");
  await h.control("outcome-todo")!.change("Off", h.ctx);
  await h.control("outcome-todo-display")!.change("On", h.ctx);
  assert.match(h.render().join("\n"), /ledger 0\/2 complete/, "display can remain on while hooks are off");
  assert.deepEqual(h.handlers.get("context")!({ messages: [
    { role: "custom", customType: WORK_LEDGER_REMINDER_MESSAGE, content: "old", details: { ledgerId: ledger.id } },
    { role: "user", content: "continue" },
  ] }, h.ctx), { messages: [{ role: "user", content: "continue" }] },
  "hooks off removes ledger reminders from the next model request without changing display");
});

test("the ledger toggle stops and restores integration without deleting data or changing association", async (t) => {
  const f = fixture(t);
  const ledger = createLedger(f);
  const h = harness(t, f, { preferences: { enabled: true, display: true, ledger: false } });
  await h.start();
  assert.equal(h.control("outcome-todo-ledger")!.get(), "Off");
  assert.equal((await h.get()).details.ledger, undefined, "off omits the ledger view");
  await assert.rejects(
    h.mutateLedger({ action: "attach", ledgerId: ledger.id }),
    /Long-term work ledger is off/,
  );
  await h.enableLedger();
  assert.equal((await h.get()).details.ledger, null, "enabling the setting never adopts an existing project ledger");
  await h.command(`attach ${ledger.id}`);
  assert.equal((await h.get()).details.ledger.id, ledger.id);
  assert.equal(h.sent.length, 1, "enabling and selecting publishes a reminder");
  const beforeOff = h.sent.length;
  await h.control("outcome-todo-ledger")!.change("Off", h.ctx);
  assert.equal(JSON.parse(readFileSync(join(f.agentDir, "settings.json"), "utf8"))
    .piBetterHarness.outcomeTodo.ledger, false, "the toggle persists through the existing settings framework");
  assert.equal((await h.get()).details.ledger, undefined, "off removes the ledger view");
  assert.deepEqual(h.handlers.get("context")!({ messages: [
    { role: "custom", customType: WORK_LEDGER_REMINDER_MESSAGE, content: "old", details: { ledgerId: ledger.id } },
    { role: "user", content: "continue" },
  ] }, h.ctx), { messages: [{ role: "user", content: "continue" }] }, "off removes ledger hints from the request");
  await assert.rejects(
    h.mutateLedger({ action: "update", ledgerId: ledger.id, revision: 1, changes: [{ id: "api", progress: "ignored" }] }),
    /Long-term work ledger is off/,
  );
  assert.equal(h.sent.length, beforeOff, "off publishes no new reminder");
  const store = openWorkLedgerStore({ cwd: f.cwd, agentDir: f.agentDir });
  store.update({
    ledgerId: ledger.id,
    revision: 1,
    event: "external-progress",
    changes: [{ id: "api", progress: "Progress made while integration was off" }],
  });
  assert.equal(store.read(ledger.id).revision, 2, "off never deletes or changes stored data");
  await h.enableLedger();
  assert.equal((await h.get()).details.ledger.id, ledger.id, "re-enabling restores the same session association");
  assert.equal(h.sent.length, beforeOff + 1, "re-enabling restores the recovery hint");
  assert.match(h.sent.at(-1)!.message.content, /rev 2/, "the restored hint is rebuilt from the current durable revision");
  assert.equal(h.settings()!.get(), "On", "the ledger toggle does not change hooks");
});

test("durable reminders stay bounded and carry no execution authorization", (t) => {
  const f = fixture(t);
  const ledger = createLedger(f, Array.from({ length: 20 }, (_, index) => ({
    id: `item_${index + 1}`,
    title: `Item ${index + 1} ${"long title ".repeat(20)}`,
    status: "blocked" as const,
    blocker: `Blocker ${index + 1} ${"detail ".repeat(20)}`,
    recovery: "Recovery",
  })));
  const formatted = formatWorkLedgerReminder(ledger, 700);
  assert.ok(formatted.length <= 700);
  assert.match(formatted, new RegExp(`^Durable work ledger ${ledger.id} rev 1`));
  assert.match(formatted, /more open item/);
  assert.match(formatted, /does not authorize work/);
  assert.doesNotMatch(formatted, /Item 19/);
});
