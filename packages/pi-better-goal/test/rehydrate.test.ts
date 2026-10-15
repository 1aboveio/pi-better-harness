import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import extension from "./extension-fixture.js";
import { findRehydrateScript, rehydrateFallbackMessage, workflowRehydrateMessage, WORKFLOW_REHYDRATE_MESSAGE_TYPE } from "../src/rehydrate.js";
import { WORKFLOW_ENTRY_TYPE, type WorkflowOwner } from "../src/workflow.js";

function skillFixture(t: TestContext): { dir: string; owner: WorkflowOwner } {
  const dir = mkdtempSync(join(tmpdir(), "pi-rehydrate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "SKILL.md");
  writeFileSync(path, "---\nname: fixture\nmetadata:\n  workflow-role: coordinator\n---\n# Fixture\n");
  return { dir, owner: { name: "fixture", path, role: "coordinator", planOwner: "workflow" } };
}

function writeScript(path: string, body: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  return path;
}

test("the scripts/ rehydrate script takes precedence over the skill-root one", (t) => {
  const { dir, owner } = skillFixture(t);
  assert.equal(findRehydrateScript(owner), undefined);
  const root = writeScript(join(dir, "rehydrate.mjs"), "");
  assert.equal(findRehydrateScript(owner), root);
  const nested = writeScript(join(dir, "scripts", "rehydrate.mjs"), "");
  assert.equal(findRehydrateScript(owner), nested);
});

test("a rehydrate script receives the session cwd and its trimmed stdout is the message", async (t) => {
  const { dir, owner } = skillFixture(t);
  writeScript(join(dir, "scripts", "rehydrate.mjs"),
    "const i = process.argv.indexOf('--cwd');\n" +
    "process.stderr.write('ignored diagnostics');\n" +
    "process.stdout.write(`\\n  Resume run in ${process.argv[i + 1]}.\\nRead the skill.  \\n\\n`);\n");
  assert.equal(await workflowRehydrateMessage(owner, dir), `Resume run in ${dir}.\nRead the skill.`);
});

test("a skill-root rehydrate script runs when scripts/ has none", async (t) => {
  const { dir, owner } = skillFixture(t);
  writeScript(join(dir, "rehydrate.mjs"), "console.log('root script');\n");
  assert.equal(await workflowRehydrateMessage(owner, dir), "root script");
});

test("empty script output injects nothing", async (t) => {
  const { dir, owner } = skillFixture(t);
  writeScript(join(dir, "scripts", "rehydrate.mjs"), "process.stdout.write('  \\n');\n");
  assert.equal(await workflowRehydrateMessage(owner, dir), null);
});

test("a skill without a rehydrate script gets the read-your-skill message", async (t) => {
  const { dir, owner } = skillFixture(t);
  const expected = `Your context was just compacted while you coordinate the fixture workflow. Before your next step, read ${owner.path} in full, with no line limit.`;
  assert.equal(rehydrateFallbackMessage(owner), expected);
  assert.equal(await workflowRehydrateMessage(owner, dir), expected);
});

test("a failing, timed-out, or unrunnable script falls back to the read-your-skill message", async (t) => {
  const { dir, owner } = skillFixture(t);
  const script = join(dir, "scripts", "rehydrate.mjs");
  writeScript(script, "console.log('partial'); process.exit(3);\n");
  assert.equal(await workflowRehydrateMessage(owner, dir), rehydrateFallbackMessage(owner));
  writeScript(script, "throw new Error('boom');\n");
  assert.equal(await workflowRehydrateMessage(owner, dir), rehydrateFallbackMessage(owner));
  writeScript(script, "console.log('late'); setTimeout(() => {}, 60_000);\n");
  assert.equal(await workflowRehydrateMessage(owner, dir, { timeoutMs: 200 }), rehydrateFallbackMessage(owner));
  writeScript(script, "console.log('unreachable');\n");
  assert.equal(await workflowRehydrateMessage(owner, join(dir, "missing-cwd")), rehydrateFallbackMessage(owner));
});

function harness(t: TestContext, owner: WorkflowOwner | null) {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const entries: Array<{ type: string; customType?: string; data?: unknown }> = owner
    ? [{ type: "custom", customType: WORKFLOW_ENTRY_TYPE, data: { version: 1, kind: "set", owner } }]
    : [];
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const sent: Array<{ message: any; options: unknown }> = [];
  const cwd = owner ? join(owner.path, "..") : tmpdir();
  const ctx = {
    hasUI: false,
    isIdle: () => true,
    cwd,
    sessionManager: { getBranch: () => entries, getSessionId: () => "session-rehydrate" },
    ui: { notify() {}, setStatus() {}, setWidget() {} },
  } as unknown as ExtensionContext;
  const pi = {
    events: new EventEmitter(),
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    sendMessage(message: unknown, options?: unknown) {
      sent.push({ message, options });
    },
    registerCommand() {},
    registerTool() {},
    registerShortcut() {},
    on(event: string, handler: (event: unknown, context: ExtensionContext) => unknown) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  extension(pi);
  const compact = (event: Record<string, unknown> = {}) =>
    handlers.get("session_compact")?.({ type: "session_compact", reason: "threshold", willRetry: false, fromExtension: false, ...event }, ctx);
  t.after(() => handlers.get("session_shutdown")?.({}, ctx));
  return { handlers, sent, ctx, compact };
}

test("compaction without a bound workflow injects nothing", async (t) => {
  const h = harness(t, null);
  await h.compact();
  assert.deepEqual(h.sent, []);
});

test("compaction re-injects the coordinator skill without starting a turn when the agent is idle", async (t) => {
  const { owner } = skillFixture(t);
  const h = harness(t, owner);
  await h.compact({ reason: "manual" });
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]!.message.customType, WORKFLOW_REHYDRATE_MESSAGE_TYPE);
  assert.equal(h.sent[0]!.message.content, rehydrateFallbackMessage(owner));
  assert.deepEqual(h.sent[0]!.options, { triggerTurn: false });
});

test("compaction inside a running agent loop or before an overflow retry steers the next model call", async (t) => {
  const { dir, owner } = skillFixture(t);
  writeScript(join(dir, "scripts", "rehydrate.mjs"), "console.log('run state');\n");
  const h = harness(t, owner);
  await h.handlers.get("agent_start")?.({}, h.ctx);
  await h.compact();
  await h.handlers.get("agent_end")?.({ messages: [] }, h.ctx);
  await h.compact({ reason: "overflow", willRetry: true });
  await h.compact();
  assert.deepEqual(h.sent.map((item) => [item.message.content, item.options]), [
    ["run state", { deliverAs: "steer" }],
    ["run state", { deliverAs: "steer" }],
    ["run state", { triggerTurn: false }],
  ]);
});

test("a rehydrate script that prints nothing suppresses the compaction message", async (t) => {
  const { dir, owner } = skillFixture(t);
  writeScript(join(dir, "rehydrate.mjs"), "");
  const h = harness(t, owner);
  await h.compact();
  assert.deepEqual(h.sent, []);
});
