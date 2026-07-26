import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import test from "node:test";

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import extension from "../src/index.js";

interface SessionEntry {
  type: "custom";
  customType: string;
  data: unknown;
}

interface CommandDefinition {
  handler(args: string, ctx: ExtensionContext): Promise<void> | void;
}

interface WidgetRecord {
  content: unknown;
  options?: { placement?: string };
}

test("only the slash command creates a goal and installs an observability-safe widget", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const entries: SessionEntry[] = [];
  const commands = new Map<string, CommandDefinition>();
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const widgets = new Map<string, WidgetRecord>();

  const ctx = {
    hasUI: true,
    isIdle: () => true,
    sessionManager: { getBranch: () => entries },
    ui: {
      confirm: async () => true,
      notify: () => undefined,
      setStatus: () => undefined,
      setWidget(key: string, content: unknown, options?: { placement?: string }) {
        widgets.set(key, { content, ...(options ? { options } : {}) });
      },
    },
  } as unknown as ExtensionContext;

  const pi = {
    events: new EventEmitter(),
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    sendMessage: () => undefined,
    registerCommand(name: string, command: CommandDefinition) {
      commands.set(name, command);
    },
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: (event: unknown, context: ExtensionContext) => unknown) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;

  extension(pi);

  assert.equal(tools.has("create_goal"), false);
  assert.equal(tools.has("get_goal"), true);
  assert.equal(tools.has("update_goal"), true);

  const sessionStart = handlers.get("session_start");
  assert.ok(sessionStart);
  await sessionStart({ reason: "startup" }, ctx);

  const widget = widgets.get("pi-better-goal");
  assert.equal(widget?.options?.placement, "belowEditor");
  assert.equal(typeof widget?.content, "function");

  const goalCommand = commands.get("goal");
  assert.ok(goalCommand);
  await goalCommand.handler("Ship slash-only goals", ctx);

  const getGoal = tools.get("get_goal");
  assert.ok(getGoal);
  const result = await getGoal.execute("test", {}, undefined, undefined, ctx);
  assert.equal((result.details as { goal: { objective: string } }).goal.objective, "Ship slash-only goals");

  const factory = widget?.content as (
    tui: { requestRender(): void },
    theme: { fg(color: string, text: string): string },
  ) => { render(width: number): string[]; dispose?(): void };
  const component = factory(
    { requestRender: () => undefined },
    { fg: (_color, text) => text },
  );
  const [line] = component.render(80);
  assert.match(line ?? "", /Goal \[active\]: Ship slash-only goals/);
  assert.match(line ?? "", /active \d+:\d{2} \| elapsed \d+:\d{2}$/);
  component.dispose?.();

  const shutdown = handlers.get("session_shutdown");
  assert.ok(shutdown);
  await shutdown({}, ctx);
});
