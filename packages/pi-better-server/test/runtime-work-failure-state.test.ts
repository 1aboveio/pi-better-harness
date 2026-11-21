import test from "node:test";
import assert from "node:assert/strict";
import { runtimeWorkFailureState } from "./support/runtime-work-failure-state.ts";

test("runtime-work failure state observes the blocked phase only on cancellation", () => {
  const controller = new AbortController(), diagnostics: string[] = [], cleanup: Array<() => void> = [];
  let inspections = 0;
  const phase = runtimeWorkFailureState({ signal: controller.signal, diagnostic: (value: string) => diagnostics.push(value),
    after: (fn: () => void) => { cleanup.push(fn); } } as any, "history", () => {
    inspections++; return { pending: true, repairEntries: 128 };
  });
  phase("reconcile:first-import");
  assert.equal(inspections, 0);
  assert.deepEqual(diagnostics, []);
  controller.abort(new Error("controlled blocked await"));
  const state = JSON.parse(diagnostics[0]!);
  assert.equal(state.phase, "reconcile:first-import");
  assert.deepEqual(state.state, { pending: true, repairEntries: 128 });
  assert.equal(inspections, 1);
  controller.abort();
  assert.equal(diagnostics.length, 1);
  cleanup.forEach(fn => fn());
});

test("runtime-work failure state removes completed observers and bounds failure output", () => {
  const controller = new AbortController(), diagnostics: string[] = [];
  let cleanup = () => {};
  runtimeWorkFailureState({ signal: controller.signal, diagnostic: (value: string) => diagnostics.push(value),
    after: (fn: () => void) => { cleanup = fn; } } as any, "navigator", () => '"\n'.repeat(20000));
  controller.abort();
  assert.equal(JSON.parse(diagnostics[0]!).truncated, true);
  assert.ok(diagnostics[0]!.length <= 8192);
  cleanup();
  const completed = new AbortController();
  runtimeWorkFailureState({ signal: completed.signal, diagnostic: (value: string) => diagnostics.push(value),
    after: (fn: () => void) => { cleanup = fn; } } as any, "completed", () => assert.fail("completed fixture must not be inspected"));
  cleanup(); completed.abort();
  assert.equal(diagnostics.length, 1);
});
