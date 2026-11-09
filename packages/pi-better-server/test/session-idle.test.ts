import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { HostedSession } from "../src/hosted-session.ts";
import { SessionRegistry } from "../src/registry.ts";
import { gate, llmCalls, makeEnv, waitFor } from "./helpers.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(sessionIdleMs: number | null = 100, background = false) {
  const env = makeEnv();
  Object.assign(process.env, env.vars);
  mkdirSync(env.serverDir, { recursive: true });
  if (background) writeFileSync(join(env.agentDir, "extensions", "idle-activity.ts"), `
    export default function (pi) {
      const owned = new Map();
      const listeners = new Set();
      pi.on("input", async (event, ctx) => {
        if (event.text !== "preflight-dialog") return;
        await ctx.ui.confirm("Approval", "Continue?");
        return { action: "continue" };
      });
      pi.on("user_bash", async (event, ctx) => {
        if (event.command !== "approval-bash") return;
        await ctx.ui.confirm("Bash approval", "Continue?");
        return { result: { output: "must not record after expiry", exitCode: 0, cancelled: false, truncated: false } };
      });
      pi.events.emit("pi-better-goal:register-provider", {
        id: "background-tasks",
        getActivity(ctx) {
          return { items: owned.get(ctx.sessionManager.getSessionId()) ? [{ active: true }] : [] };
        },
        onActivityChanged(notify) { listeners.add(notify); return () => listeners.delete(notify); }
      });
      pi.registerCommand("background", {
        description: "Control the external activity fixture",
        handler: async (args, ctx) => {
          owned.set(ctx.sessionManager.getSessionId(), args === "start");
          for (const notify of listeners) notify();
        }
      });
    }
  `);
  let clock = 0;
  const logs: string[] = [];
  const options = { serverDir: env.serverDir, sessionIdleMs: sessionIdleMs ?? undefined, now: () => clock, log: (message: string) => logs.push(message) };
  const registry = new SessionRegistry(options);
  cleanups.push(() => registry.shutdown());
  const creating = registry.create({ type: "create_session", cwd: env.cwd, model: { provider: "fake", modelId: "fake-1" } });
  assert.equal(registry.hasPendingOperations, true);
  const { sessionId } = await creating;
  await Promise.resolve();
  assert.equal(registry.hasPendingOperations, false);
  return { env, registry, sessionId, host: registry.get(sessionId)!, logs, options, at: (time: number) => { clock = time; } };
}

async function settled(host: HostedSession) {
  await host.session.waitForIdle();
  await waitFor("hosted work to settle", () => !host.executionActive);
}

function silentBash(host: HostedSession, env: ReturnType<typeof makeEnv>, name: string) {
  const started = join(env.gateDir, `${name}.started`);
  const released = join(env.gateDir, `${name}.release`);
  const script = `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(started)}, ""); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(released)})) clearInterval(timer); }, 10);`;
  return {
    command: host.handle({ type: "bash", command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}` }),
    hold: gate(env, name),
  };
}

function silentProvider(host: HostedSession) {
  let started = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  host.session.agent.streamFunction = (model) => {
    const stream = createAssistantMessageEventStream();
    started = true;
    void gate.then(() => {
      const message = {
        role: "assistant", content: [{ type: "text", text: "finished silent request" }],
        api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: 0,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      stream.push({ type: "start", partial: message as never });
      stream.push({ type: "done", reason: "stop", message: message as never });
    });
    return stream;
  };
  return { started: () => started, release };
}

function parallelTools(host: HostedSession, bothWaiting: boolean) {
  let first = true;
  host.session.agent.toolExecution = "parallel";
  host.session.agent.streamFunction = (model) => {
    const stream = createAssistantMessageEventStream();
    const tools = first;
    first = false;
    const message = {
      role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 0,
      content: tools ? [
        { type: "toolCall", id: "question-1", name: "ask", arguments: { question: "First approval?" } },
        { type: "toolCall", id: "parallel-2", name: bothWaiting ? "ask" : "gate", arguments: bothWaiting ? { question: "Second approval?" } : { name: "parallel" } },
      ] : [{ type: "text", text: "done" }],
      stopReason: tools ? "toolUse" : "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message as never });
      stream.push({ type: "done", reason: tools ? "toolUse" : "stop", message: message as never });
    });
    return stream;
  };
}

async function externalBackgroundChange(host: HostedSession, args: string) {
  const runner = host.session.extensionRunner;
  await runner.getCommand("background")!.handler(args, runner.createCommandContext());
  await host.refreshActivity();
}

describe("session idle expiry", () => {
  it("defaults to 24 hours and refuses stale runtime dispatch even when attached", async () => {
    const f = await setup(null);
    assert.equal(f.host.acquireControl("attached-client"), true);
    f.at(86_399_999);
    assert.deepEqual(await f.registry.expireIdle(), []);
    f.at(86_400_000);
    assert.deepEqual(await f.registry.expireIdle(), [f.sessionId]);
    assert.equal(f.registry.entry(f.sessionId)?.status, "closed");
    assert.equal(f.registry.activeCount, 0);
    assert.equal((await f.host.handle({ type: "prompt", message: "must not execute" })).success, false);
    assert.equal(llmCalls(f.env).length, 0);
    assert.deepEqual(await f.registry.expireIdle(), []);
  });

  it("zero disables expiry", async () => {
    const f = await setup(0);
    f.at(10 ** 12);
    assert.deepEqual(await f.registry.expireIdle(), []);
    assert.equal(f.registry.activeCount, 1);
  });

  it("polls, subscriptions, controller heartbeats and both rename paths do not refresh activity", async () => {
    const f = await setup();
    const original = f.registry.entry(f.sessionId)!.lastActivityAt;
    f.at(90);
    assert.equal((await f.host.handle({ type: "get_state" })).success, true);
    await f.host.clientSnapshot();
    f.host.subscribe(undefined, () => undefined).unsubscribe();
    f.host.acquireControl("client");
    f.host.acquireControl("client");
    await f.registry.rename(f.sessionId, "registry rename");
    await f.host.handle({ type: "set_session_name", name: "rpc rename" });
    assert.equal(f.registry.entry(f.sessionId)?.lastActivityAt, original);
    assert.equal(f.registry.entry(f.sessionId)?.updatedAt, new Date(90).toISOString());
    f.at(100);
    assert.deepEqual(await f.registry.expireIdle(), [f.sessionId]);
  });

  it("explicit open and a user prompt reset the idle window", async () => {
    const f = await setup();
    f.at(90);
    await f.registry.open(f.sessionId);
    f.at(100);
    assert.deepEqual(await f.registry.expireIdle(), []);
    f.at(180);
    assert.equal((await f.host.handle({ type: "prompt", message: "hello" })).success, true);
    await settled(f.host);
    f.at(279);
    assert.deepEqual(await f.registry.expireIdle(), []);
    f.at(280);
    assert.deepEqual(await f.registry.expireIdle(), [f.sessionId]);
  });

  for (const phase of ["preflight", "tool"] as const) {
    it(`protects a long silent ${phase} and starts a full window only after settlement`, async () => {
      const f = await setup();
      const hold = gate(f.env, phase);
      const command = f.host.handle({ type: "prompt", message: `${phase === "preflight" ? "hold" : "tool"} ${phase}` });
      await waitFor(`${phase} to start`, hold.started);
      if (phase === "preflight") assert.equal(f.host.isStreaming, false);
      f.at(10_000);
      assert.deepEqual(await f.registry.expireIdle(), []);
      hold.release();
      assert.equal((await command).success, true);
      await settled(f.host);
      assert.equal(f.registry.entry(f.sessionId)?.lastActivityAt, new Date(10_000).toISOString());
      f.at(10_099);
      assert.deepEqual(await f.registry.expireIdle(), []);
      f.at(10_100);
      assert.deepEqual(await f.registry.expireIdle(), [f.sessionId]);
    });
  }

  for (const phase of ["model", "compaction"] as const) {
    it(`protects silent ${phase} requests and gives settlement a full idle window`, async () => {
      const f = await setup();
      if (phase === "compaction") {
        await f.host.handle({ type: "prompt", message: "first message" });
        await settled(f.host);
        await f.host.handle({ type: "prompt", message: "second message" });
        await settled(f.host);
        f.host.session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 0 } });
      }
      const provider = silentProvider(f.host);
      const command = phase === "model"
        ? f.host.handle({ type: "prompt", message: "silent request" })
        : f.host.handle({ type: "compact" });
      await waitFor(`silent ${phase} request`, provider.started);
      if (phase === "compaction") assert.equal(f.host.session.isCompacting, true);
      f.at(10_000);
      assert.deepEqual(await f.registry.expireIdle(), []);
      provider.release();
      assert.equal((await command).success, true);
      await settled(f.host);
      f.at(10_099);
      assert.deepEqual(await f.registry.expireIdle(), []);
      f.at(10_100);
      assert.deepEqual(await f.registry.expireIdle(), [f.sessionId]);
    });
  }

  it("protects silent standalone bash until it settles", async () => {
    const f = await setup();
    const bash = silentBash(f.host, f.env, "bash");
    await waitFor("standalone bash", bash.hold.started);
    f.at(10_000);
    assert.deepEqual(await f.registry.expireIdle(), []);
    bash.hold.release();
    assert.equal((await bash.command).success, true);
    assert.equal(f.host.executionActive, false);
    f.at(10_100);
    assert.deepEqual(await f.registry.expireIdle(), [f.sessionId]);
  });

  it("a model dialog does not hide an independently running bash command", async () => {
    const f = await setup();
    await f.host.handle({ type: "prompt", message: "ask Model approval?" });
    await waitFor("model dialog", () => f.host.needsInput[0]);
    const bash = silentBash(f.host, f.env, "concurrent-bash");
    await waitFor("concurrent bash", bash.hold.started);
    f.at(10_000);
    assert.deepEqual(await f.registry.expireIdle(), []);
    bash.hold.release();
    assert.equal((await bash.command).success, true);
    assert.equal(f.host.executionActive, false);
    f.at(10_099);
    assert.deepEqual(await f.registry.expireIdle(), []);
    f.at(10_100);
    assert.deepEqual(await f.registry.expireIdle(), [f.sessionId]);
  });

  it("a bash approval does not hide an independently running model request", async () => {
    const f = await setup(100, true);
    const provider = silentProvider(f.host);
    await f.host.handle({ type: "prompt", message: "silent model" });
    await waitFor("silent model", provider.started);
    const bash = f.host.handle({ type: "bash", command: "approval-bash" });
    await waitFor("bash dialog", () => f.host.needsInput[0]);
    f.at(10_000);
    assert.deepEqual(await f.registry.expireIdle(), []);
    provider.release();
    await settled(f.host);
    f.at(10_099);
    assert.deepEqual(await f.registry.expireIdle(), []);
    f.at(10_100);
    assert.deepEqual(await f.registry.expireIdle(), [f.sessionId]);
    assert.equal((await bash).success, false);
  });

  it("a tool dialog cannot hide a parallel silent tool; inactivity starts when that tool finishes", async () => {
    const f = await setup();
    parallelTools(f.host, false);
    await f.host.handle({ type: "prompt", message: "parallel tools" });
    await waitFor("parallel tool and dialog", () => gate(f.env, "parallel").started() && f.host.needsInput.length === 1);
    f.at(10_000);
    assert.deepEqual(await f.registry.expireIdle(), []);
    gate(f.env, "parallel").release();
    await waitFor("parallel work to yield to input", () => !f.host.executionActive);
    f.at(10_099);
    assert.deepEqual(await f.registry.expireIdle(), []);
    f.at(10_100);
    assert.deepEqual(await f.registry.expireIdle(), [f.sessionId]);
  });

  it("multiple parallel tools all waiting for input are idle and their approvals expire", async () => {
    const f = await setup();
    parallelTools(f.host, true);
    await f.host.handle({ type: "prompt", message: "parallel approvals" });
    await waitFor("both tool dialogs", () => f.host.needsInput.length === 2);
    const ids = f.host.needsInput.map((dialog) => dialog.id);
    assert.equal(f.host.executionActive, false);
    f.at(100);
    assert.deepEqual(await f.registry.expireIdle(), [f.sessionId]);
    for (const id of ids) assert.equal(f.host.answerDialog(id, { value: "stale" }), false);
  });

  it("manual close still aborts a busy turn and leaves reopenable history", async () => {
    const f = await setup();
    await f.host.handle({ type: "prompt", message: "tool manual-close" });
    await waitFor("busy turn", gate(f.env, "manual-close").started);
    await f.registry.close(f.sessionId);
    assert.equal(f.registry.entry(f.sessionId)?.status, "closed");
    assert.equal(f.registry.get(f.sessionId), undefined);
    assert.equal(gate(f.env, "manual-close").finished(), true);
    await f.registry.open(f.sessionId);
    assert.ok(f.registry.get(f.sessionId)!.session.messages.some((message) => JSON.stringify(message).includes("manual-close")));
  });

  it("treats waiting input as idle, cancels it, denies stale answers and reopens history without replay", async () => {
    const f = await setup();
    await f.host.handle({ type: "prompt", message: "ask Approval?" });
    const dialog = await waitFor("pending input", () => f.host.needsInput[0]);
    assert.equal(f.host.turnActive, true);
    assert.equal(f.host.executionActive, false);
    f.at(100);
    assert.deepEqual(await f.registry.expireIdle(), [f.sessionId]);
    const callsAfterClose = llmCalls(f.env).length;
    assert.equal(f.host.answerDialog(dialog.id, { value: "stale approval" }), false);
    assert.deepEqual(f.host.needsInput, []);
    assert.equal((await f.host.handle({ type: "bash", command: "echo stale" })).success, false);
    await f.registry.open(f.sessionId);
    const reopened = f.registry.get(f.sessionId)!;
    assert.notEqual(reopened.generation, f.host.generation);
    assert.deepEqual(reopened.needsInput, []);
    assert.ok(reopened.session.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("Approval?")));
    assert.equal(llmCalls(f.env).length, callsAfterClose);
    assert.equal(reopened.answerDialog(dialog.id, { value: "stale approval" }), false);
  });

  it("cancels preflight approval without allowing the resumed preflight to start a model run", async () => {
    const f = await setup(100, true);
    const prompt = f.host.handle({ type: "prompt", message: "preflight-dialog" });
    const dialog = await waitFor("preflight approval", () => f.host.needsInput[0]);
    assert.equal(f.host.isStreaming, false);
    assert.equal(f.host.turnActive, true);
    f.at(100);
    assert.deepEqual(await f.registry.expireIdle(), [f.sessionId]);
    assert.equal((await prompt).success, false);
    assert.equal(f.host.answerDialog(dialog.id, { confirmed: true }), false);
    assert.equal(llmCalls(f.env).length, 0);
    await f.registry.open(f.sessionId);
    assert.equal(llmCalls(f.env).length, 0);
  });

  it("does not dispatch or record a user bash continuation after its approval expires", async () => {
    const f = await setup(100, true);
    const bash = f.host.handle({ type: "bash", command: "approval-bash" });
    const dialog = await waitFor("bash approval", () => f.host.needsInput[0]);
    f.at(100);
    assert.deepEqual(await f.registry.expireIdle(), [f.sessionId]);
    assert.equal((await bash).success, false);
    assert.equal(f.host.answerDialog(dialog.id, { confirmed: true }), false);
    await f.registry.open(f.sessionId);
    assert.equal(f.registry.get(f.sessionId)!.session.messages.some((message) => message.role === "bashExecution"), false);
  });

  it("counts downtime from persisted activity, not the last metadata write or resume time", async () => {
    const f = await setup();
    await f.host.handle({ type: "prompt", message: "retained history" });
    await settled(f.host);
    f.at(90);
    await f.registry.rename(f.sessionId, "metadata only");
    await f.registry.shutdown();
    f.at(100);
    const restarted = new SessionRegistry(f.options);
    cleanups.push(() => restarted.shutdown());
    await restarted.resumeAll();
    assert.equal(restarted.activeCount, 1);
    assert.deepEqual(await restarted.expireIdle(), [f.sessionId]);
    await restarted.open(f.sessionId);
    assert.ok(restarted.get(f.sessionId)!.session.messages.some((message) => JSON.stringify(message).includes("retained history")));
  });

  it("reconciles interrupted busy state with a new window without replaying tools", async () => {
    const f = await setup();
    const hold = gate(f.env, "interrupted");
    await f.host.handle({ type: "prompt", message: "tool interrupted" });
    await waitFor("tool to start", hold.started);
    assert.equal(f.registry.entry(f.sessionId)?.activityBusy, true);
    await f.registry.shutdown();
    const calls = llmCalls(f.env).length;
    f.at(20_000);
    const restarted = new SessionRegistry(f.options);
    cleanups.push(() => restarted.shutdown());
    await restarted.resumeAll();
    assert.equal(restarted.get(f.sessionId)!.executionActive, false);
    assert.equal(llmCalls(f.env).length, calls);
    assert.deepEqual(await restarted.expireIdle(), []);
    f.at(20_100);
    assert.deepEqual(await restarted.expireIdle(), [f.sessionId]);
  });

  it("keeps unresolved resume errors active instead of expiring potentially recoverable work", async () => {
    const f = await setup();
    await f.host.handle({ type: "prompt", message: "history" });
    await settled(f.host);
    const path = f.registry.entry(f.sessionId)!.sessionFile;
    await f.registry.shutdown();
    writeFileSync(path, "not a session\n");
    f.at(1000);
    const restarted = new SessionRegistry(f.options);
    cleanups.push(() => restarted.shutdown());
    await restarted.resumeAll();
    assert.ok(restarted.resumeError(f.sessionId));
    assert.equal(restarted.activeCount, 1);
    assert.deepEqual(await restarted.expireIdle(), []);
  });

  it("an admitted prompt wins an expiry observation and an explicit reopen follows a completed expiry", async () => {
    const f = await setup();
    f.at(100);
    const expiring = f.registry.expireIdle();
    const prompt = f.host.handle({ type: "prompt", message: "hold race" });
    await waitFor("preflight race gate", gate(f.env, "race").started);
    assert.deepEqual(await expiring, []);
    gate(f.env, "race").release();
    await prompt;
    await settled(f.host);
    f.at(200);
    const expiry = f.registry.expireIdle();
    const reopening = f.registry.open(f.sessionId);
    assert.equal(f.registry.hasPendingOperations, true);
    assert.deepEqual(await expiry, [f.sessionId]);
    await reopening;
    assert.equal(f.registry.entry(f.sessionId)?.status, "running");
    assert.notEqual(f.registry.get(f.sessionId)!.generation, f.host.generation);
    assert.equal((await f.host.handle({ type: "prompt", message: "stale" })).success, false);
  });

  it("protects silent background-provider work only in its owning session and refreshes on settlement notifications", async () => {
    const f = await setup(100, true);
    const second = await f.registry.create({ type: "create_session", cwd: f.env.cwd });
    await externalBackgroundChange(f.host, "start");
    assert.equal(f.host.executionActive, true);
    f.at(10_000);
    assert.deepEqual(await f.registry.expireIdle(), [second.sessionId]);
    await externalBackgroundChange(f.host, "stop");
    assert.equal(f.host.executionActive, false);
    assert.equal(f.registry.entry(f.sessionId)?.lastActivityAt, new Date(10_000).toISOString());
    f.at(10_099);
    assert.deepEqual(await f.registry.expireIdle(), []);
    f.at(10_100);
    assert.deepEqual(await f.registry.expireIdle(), [f.sessionId]);
  });
});
