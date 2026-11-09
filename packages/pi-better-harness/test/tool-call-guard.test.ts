import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import toolCallGuardExtension, { installToolCallGuard } from "../extensions/tool-call-guard/index.ts";
import { blockReason, detectForegroundWait, SLEEP_THRESHOLD_SECONDS } from "../extensions/tool-call-guard/waits.ts";

test("foreground waits on external state are recognised", () => {
  for (const command of [
    "gh pr checks 661 --watch",
    "gh run view 42376450798 --watch",
    "gh run watch",
    "node scripts/watch-checks.mjs --pr 661 --until merged",
    "node scripts/watch-github-run.mjs --repo a/b --run 123",
    "gh pr merge 661 --until merged",
    "watch -n 5 gh pr checks",
    "tail -f /tmp/deploy.log",
    "docker logs -f api",
    "kubectl get pods --watch",
    "until curl -fsS http://localhost:3000/health; do sleep 1; done",
    "while ! pg_isready; do sleep 2; done",
  ]) {
    assert.ok(detectForegroundWait(command), `expected a wait: ${command}`);
  }
});

test("work that merely takes a long time stays in the foreground", () => {
  for (const command of [
    "npm test",
    "npm run build",
    "npx tsc --noEmit",
    "git push -u origin HEAD",
    "gh pr checks 661",
    "tail -40 /tmp/deploy.log",
    "docker logs api | head -50",
    "sleep 3",
    "rg --files | head -20",
    "git log --until=2026-11-01 --oneline -5",
    "git log --format=%B --until 2026-11-01",
  ]) {
    assert.equal(detectForegroundWait(command), undefined, `expected to allow: ${command}`);
  }
});

test("a sleep only counts once it is longer than the threshold", () => {
  assert.equal(detectForegroundWait("sleep 3"), undefined);
  assert.equal(detectForegroundWait("sleep 4")?.waitsOn, "4 seconds of wall clock");
  assert.ok(detectForegroundWait("cd /tmp && sleep 30"));
  assert.ok(detectForegroundWait("sudo sleep 60"));
});

test("the block reason names the wait and the replacement call", () => {
  const match = detectForegroundWait("gh pr checks 661 --watch");
  assert.ok(match);
  const reason = blockReason(match);
  assert.match(reason, /waits on a pull request's checks/);
  assert.match(reason, /bg_task_spawn/);
  assert.match(reason, /wait_for_operations/);
  assert.match(reason, /Tool call guard to Off/);
});

interface Registered { handler: (event: unknown) => unknown }

function harness(): { pi: ExtensionAPI; handlers: Map<string, Registered["handler"]> } {
  const handlers = new Map<string, Registered["handler"]>();
  const pi = {
    on(event: string, handler: Registered["handler"]) { handlers.set(event, handler); },
    events: { on() { return () => {}; }, emit() {} },
  } as unknown as ExtensionAPI;
  return { pi, handlers };
}

test("an enabled guard blocks a waiting command and executes nothing", () => {
  const { pi, handlers } = harness();
  const blocked: string[] = [];
  installToolCallGuard(pi, () => true, (match) => blocked.push(match.waitsOn));
  const handler = handlers.get("tool_call")!;
  const result = handler({ toolName: "bash", input: { command: "gh pr checks 661 --watch" } });
  assert.deepEqual((result as { block: boolean }).block, true);
  assert.match((result as { reason: string }).reason, /bg_task_spawn/);
  assert.deepEqual(blocked, ["a pull request's checks"]);
});

test("the guard leaves ordinary commands and other tools alone", () => {
  const { pi, handlers } = harness();
  installToolCallGuard(pi, () => true);
  const handler = handlers.get("tool_call")!;
  assert.equal(handler({ toolName: "bash", input: { command: "npm test" } }), undefined);
  assert.equal(handler({ toolName: "read", input: { path: "package.json" } }), undefined);
  assert.equal(handler({ toolName: "bash", input: {} }), undefined);
  // Older hosts pass `args`; the guard reads either field.
  assert.ok(handler({ toolName: "bash", args: { command: "tail -f log" } }));
});

test("disabling the guard stops every block without unloading the extension", () => {
  const { pi, handlers } = harness();
  let enabled = true;
  installToolCallGuard(pi, () => enabled);
  const handler = handlers.get("tool_call")!;
  assert.ok(handler({ toolName: "bash", input: { command: "tail -f log" } }));
  enabled = false;
  assert.equal(handler({ toolName: "bash", input: { command: "tail -f log" } }), undefined);
});

test("the extension registers a Tool call guard control and blocks by default", () => {
  const handlers = new Map<string, Registered["handler"]>();
  const registered: { id?: string; label?: string; values?: string[] }[] = [];
  const pi = {
    on(event: string, handler: Registered["handler"]) { handlers.set(event, handler); },
    events: {
      on() { return () => {}; },
      emit(event: string, payload: unknown) { if (event === "harness-settings:register") registered.push(payload as never); },
    },
  } as unknown as ExtensionAPI;
  toolCallGuardExtension(pi);
  const control = registered.find((entry) => entry.id === "tool-call-guard");
  assert.ok(control, "the control is registered");
  assert.equal(control!.label, "Tool call guard");
  assert.deepEqual(control!.values, ["On", "Off"]);
  const blocked = handlers.get("tool_call")!({ toolName: "bash", input: { command: "kubectl get pods -w" } });
  assert.deepEqual((blocked as { block: boolean }).block, true, "guarding is the default");
});

test("the sleep threshold is stated in one place", () => {
  assert.equal(SLEEP_THRESHOLD_SECONDS, 3);
});
