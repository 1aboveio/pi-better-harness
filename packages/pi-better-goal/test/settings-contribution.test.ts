import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand, Theme } from "@earendil-works/pi-coding-agent";
import extension from "./extension-fixture.js";
import { goalPreferencesPath, readGoalPreferences } from "../src/preferences.js";

type Control = { id: string; label: string; values: string[]; get(): string; change(value: string, ctx: ExtensionCommandContext): Promise<void> };
const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text,
  bold: (text: string) => text, inverse: (text: string) => text } as Theme;

test("Harness exposes only automatic Goal start and shares the standalone command preference, and stops replying after shutdown", async () => {
  const unrelated = { theme: "light", piBetterHarness: { callbacks: { mode: "immediate" } } };
  const rawSettings = JSON.stringify(unrelated);
  writeFileSync(goalPreferencesPath(), rawSettings);
  const events = createEventBus();
  const registrations: Control[] = [];
  events.on("harness-settings:register", (data) => registrations.push(data as Control));
  const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  const handlers = new Map<string, Function>();
  const entries: unknown[] = [];
  const messages: unknown[] = [];
  const pi = {
    events,
    registerCommand(name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) { commands.set(name, command); },
    registerTool() {}, registerShortcut() {},
    on(name: string, handler: Function) {
      const previous = handlers.get(name);
      handlers.set(name, async (...args: unknown[]) => { await previous?.(...args); return handler(...args); });
    },
    appendEntry(...args: unknown[]) { entries.push(args); },
    sendMessage(...args: unknown[]) { messages.push(args); },
    sendUserMessage() { assert.fail("settings must not send user messages"); },
  } as unknown as ExtensionAPI;
  extension(pi);
  assert.deepEqual(registrations.filter(item => item.id !== "navigator-sticky").map(item => item.id), ["goal-auto-start"]);
  const later: Control[] = [];
  events.on("harness-settings:register", (data) => later.push(data as Control));
  events.emit("harness-settings:request", undefined);
  events.emit("harness-settings:request", undefined);
  const control = registrations.find(item => item.id === "goal-auto-start")!;
  assert.deepEqual(later.filter(item => item.id === "goal-auto-start"), [control, control]);

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
  await commands.get("goal")!.handler("settings", ctx);
  assert.equal(pages.length, 1);
  assert.equal(closed, 1);
  assert.equal(readFileSync(goalPreferencesPath(), "utf8"), rawSettings, "opening does not persist defaults or modify other settings");
  assert.deepEqual(entries, []);
  assert.deepEqual(messages, []);

  toggle = true;
  await commands.get("goal")!.handler("settings", ctx);
  assert.equal(readGoalPreferences().autoContinue, false);
  toggle = false;
  await commands.get("goal")!.handler("settings", ctx);
  assert.match(pages.at(-1)!, /Automatic continuation\s+off/i);
  await commands.get("goal")!.handler("settings auto-continue on", ctx);
  await commands.get("goal")!.handler("settings", ctx);
  assert.match(pages.at(-1)!, /Automatic continuation\s+on/i);
  assert.equal(readGoalPreferences().autoContinue, true);
  assert.deepEqual(JSON.parse(readFileSync(goalPreferencesPath(), "utf8")), {
    ...unrelated,
    piBetterHarness: { ...unrelated.piBetterHarness, goal: {
      version: 1, autoContinue: true, conversationalResume: true, pauseOnEscape: true, autoStartFromOutcome: false,
    } },
  });
  assert.deepEqual(entries, []);
  assert.deepEqual(messages, []);

  assert.equal(control.label, "Auto-start Goals");
  assert.deepEqual(control.values, ["Off", "On"]);
  assert.equal(control.get(), "Off");
  await control.change("On", ctx);
  assert.equal(readGoalPreferences().autoStartFromOutcome, true);
  await commands.get("goal")!.handler("settings", ctx);
  assert.match(pages.at(-1)!, /Auto-start Goals\s+On/);
  await commands.get("goal")!.handler("settings auto-start-from-outcome off", ctx);
  assert.equal(control.get(), "Off", "the Harness control and Goal command share the live preference");
  await assert.rejects(control.change("invalid", ctx), /Invalid Auto-start Goals mode/);
  assert.equal(control.get(), "Off");
  assert.deepEqual(entries, []);
  assert.deepEqual(messages, []);

  ctx.mode = "rpc";
  const opened = pages.length;
  await commands.get("goal")!.handler("settings", ctx);
  assert.equal(pages.length, opened);
  assert.match(notices.at(-1)!, /auto/i);
  await handlers.get("session_shutdown")!({}, ctx);
  const count = registrations.length;
  events.emit("harness-settings:request", undefined);
  assert.equal(registrations.length, count);
});
