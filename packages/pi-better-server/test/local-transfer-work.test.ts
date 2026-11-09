import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { observeLocalTransferWork } from "../src/remote-client/local-work.ts";

test("transfer preflight observes owned background work, async checks, failures and shutdown", async () => {
  const events = createEventBus();
  let shutdown!: () => void;
  const pi = { events, on: (name: string, callback: () => void) => { if (name === "session_shutdown") shutdown = callback; } } as unknown as ExtensionAPI;
  const tracker = observeLocalTransferWork(pi);
  const ctx = { cwd: "/work", sessionManager: { getSessionId: () => "source" } } as unknown as ExtensionContext;
  let notify!: () => void;
  let active = true;
  let fail = false;
  let removeCount = 0;
  let observedSession: string | undefined;
  events.emit("pi-better-goal:register-provider", {
    id: "background-tasks", getActivity: async (context: ExtensionContext) => {
      observedSession = context.sessionManager.getSessionId();
      if (fail) throw new Error("unavailable");
      return { items: [{ active }] };
    },
    onActivityChanged: (callback: () => void) => { notify = callback; return () => { removeCount++; }; },
  });
  await assert.rejects(tracker.check(ctx), /background work/);
  assert.equal(observedSession, "source");
  assert.equal(tracker.busy(), true);
  active = false;
  notify();
  assert.equal(tracker.busy(), true, "pending activity observation protects the snapshot window");
  await tracker.check(ctx);
  assert.equal(tracker.busy(), false);
  fail = true;
  await assert.rejects(tracker.check(ctx), /background work/);
  assert.equal(tracker.busy(), true, "failed observation cannot establish that work finished");
  shutdown();
  assert.equal(removeCount, 1);
  await assert.rejects(tracker.check(ctx), /background work/);
});

test("a provider registering during a transfer dialog is observed before approval starts a move", async () => {
  const events = createEventBus();
  const pi = { events, on() {} } as unknown as ExtensionAPI;
  const tracker = observeLocalTransferWork(pi);
  const ctx = {} as ExtensionContext;
  await tracker.check(ctx);
  assert.equal(tracker.busy(), false);
  events.emit("pi-better-goal:register-provider", { id: "subagents", getActivity: () => ({ items: [{ active: true }] }) });
  assert.equal(tracker.busy(), true);
  await assert.rejects(tracker.check(ctx), /background work/);
});