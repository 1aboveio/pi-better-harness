import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import extension from "../src/index.js";
import { commandInvocation, leadingCommand, resolveGoalCommand } from "../src/command-binding.js";
import { currentGoalSnapshot } from "../src/goal-state.js";

test("leading commands resolve by source, rejecting missing and recursive commands", () => {
  const pi = { getCommands: () => [
    { name: "skill:write", source: "skill", sourceInfo: { path: "/skills/write/SKILL.md" } },
    { name: "publish", source: "extension", sourceInfo: { path: "/ext/publish.ts" } },
  ] } as unknown as ExtensionAPI;
  assert.equal(leadingCommand("write a report"), null);
  assert.deepEqual(resolveGoalCommand(pi, "/skill:write report"), {
    name: "skill:write", source: "skill", path: "/skills/write/SKILL.md", args: "report",
  });
  assert.equal(commandInvocation(resolveGoalCommand(pi, "/publish report")!), "/publish report");
  assert.throws(() => resolveGoalCommand(pi, "/missing report"), /Unknown command/);
  assert.throws(() => resolveGoalCommand(pi, "/goal /publish report"), /recursively/);
});

test("extension commands dispatch once, then resume as goal supervision", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const entries: Array<{ type: string; customType: string; data: unknown }> = [];
  const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> | void }>();
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const sent: string[] = [];
  const followups: string[] = [];
  const ctx = {
    hasUI: false, isIdle: () => true,
    sessionManager: { getBranch: () => entries, getSessionId: () => "binding-test" },
    ui: { notify() {}, setStatus() {}, setWidget() {} },
  } as unknown as ExtensionContext;
  const pi = {
    events: new EventEmitter(),
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
    getCommands: () => [{ name: "publish", source: "extension", sourceInfo: { path: "/ext/publish.ts" } }],
    sendUserMessage(content: string) { sent.push(content); },
    sendMessage(message: { content: string }) { followups.push(message.content); },
    registerCommand(name: string, command: { handler(args: string, ctx: ExtensionContext): Promise<void> | void }) { commands.set(name, command); },
    registerTool() {},
    on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown) { handlers.set(event, handler); },
  } as unknown as ExtensionAPI;
  extension(pi);
  await handlers.get("session_start")?.({ reason: "startup" }, ctx);
  await commands.get("goal")?.handler("/publish report", ctx);
  assert.deepEqual(sent, ["/publish report"]);
  assert.equal(currentGoalSnapshot(ctx)?.command?.source, "extension");
  t.mock.timers.tick(30_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(followups.at(-1) ?? "", /Goal: \/publish report/);
  assert.equal(sent.length, 1);
  await commands.get("goal")?.handler("pause", ctx);
  await commands.get("goal")?.handler("resume", ctx);
  assert.equal(sent.length, 1);
  assert.match(followups.at(-1) ?? "", /Goal: \/publish report/);
  await handlers.get("session_shutdown")?.({}, ctx);
});