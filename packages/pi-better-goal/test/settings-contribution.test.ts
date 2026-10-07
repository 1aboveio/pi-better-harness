import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand, Theme } from "@earendil-works/pi-coding-agent";
import extension from "./extension-fixture.js";
import { goalPreferencesPath, readGoalPreferences } from "../src/preferences.js";

type Contribution = { id: string; label: string; command: string; open(ctx: ExtensionCommandContext): Promise<void> };
const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text,
  bold: (text: string) => text, inverse: (text: string) => text } as Theme;

test("goal settings discovery uses the standalone opener and shared preferences, and stops replying after shutdown", async () => {
  const unrelated = { theme: "light", piBetterHarness: { callbacks: { mode: "immediate" } } };
  const rawSettings = JSON.stringify(unrelated);
  writeFileSync(goalPreferencesPath(), rawSettings);
  const events = createEventBus();
  const registrations: Contribution[] = [];
  events.on("harness-settings:register", (data) => registrations.push(data as Contribution));
  const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  const handlers = new Map<string, Function>();
  const entries: unknown[] = [];
  const messages: unknown[] = [];
  const pi = {
    events,
    registerCommand(name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) { commands.set(name, command); },
    registerTool() {}, registerShortcut() {},
    on(name: string, handler: Function) { handlers.set(name, handler); },
    appendEntry(...args: unknown[]) { entries.push(args); },
    sendMessage(...args: unknown[]) { messages.push(args); },
    sendUserMessage() { assert.fail("settings must not send user messages"); },
  } as unknown as ExtensionAPI;
  extension(pi);
  assert.equal(registrations.length, 1);
  const contribution = registrations[0]!;
  assert.equal(contribution.id, "goal");
  assert.equal(contribution.label, "Goal");
  assert.equal(contribution.command, "/goal settings");
  const later: Contribution[] = [];
  events.on("harness-settings:register", (data) => later.push(data as Contribution));
  events.emit("harness-settings:request", undefined);
  events.emit("harness-settings:request", undefined);
  assert.deepEqual(later, [contribution, contribution]);

  const pages: string[] = [];
  let toggle = false;
  let closed = 0;
  const notices: string[] = [];
  const ctx = {
    mode: "tui", hasUI: true, isIdle: () => true,
    sessionManager: { getBranch: () => [] },
    ui: {
      notify(message: string) { notices.push(message); }, setStatus() {}, setWidget() {},
      async custom(factory: Function) {
        const page = factory({ requestRender() {} }, theme, {}, () => { closed++; });
        pages.push(page.render(80).join("\n"));
        if (toggle) {
          page.handleInput(" ");
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        page.handleInput("\x1b");
      },
    },
  } as unknown as ExtensionCommandContext;
  await contribution.open(ctx);
  await commands.get("goal")!.handler("settings", ctx);
  assert.equal(pages.length, 2);
  assert.equal(pages[0], pages[1]);
  assert.equal(closed, 2);
  assert.equal(readFileSync(goalPreferencesPath(), "utf8"), rawSettings, "opening does not persist defaults or modify other settings");
  assert.deepEqual(entries, []);
  assert.deepEqual(messages, []);

  toggle = true;
  await contribution.open(ctx);
  assert.equal(readGoalPreferences().autoContinue, false);
  toggle = false;
  await commands.get("goal")!.handler("settings", ctx);
  assert.match(pages.at(-1)!, /Automatic continuation\s+off/i);
  await commands.get("goal")!.handler("settings auto-continue on", ctx);
  await contribution.open(ctx);
  assert.match(pages.at(-1)!, /Automatic continuation\s+on/i);
  assert.equal(readGoalPreferences().autoContinue, true);
  assert.deepEqual(JSON.parse(readFileSync(goalPreferencesPath(), "utf8")), {
    ...unrelated,
    piBetterHarness: { ...unrelated.piBetterHarness, goal: {
      version: 1, autoContinue: true, conversationalResume: true, pauseOnEscape: true,
    } },
  });
  assert.deepEqual(entries, []);
  assert.deepEqual(messages, []);

  ctx.mode = "rpc";
  const opened = pages.length;
  await contribution.open(ctx);
  await commands.get("goal")!.handler("settings", ctx);
  assert.equal(pages.length, opened);
  assert.equal(notices.at(-1), notices.at(-2), "RPC retains the command's textual settings fallback");
  await handlers.get("session_shutdown")!({}, ctx);
  const count = registrations.length;
  events.emit("harness-settings:request", undefined);
  assert.equal(registrations.length, count);
});
