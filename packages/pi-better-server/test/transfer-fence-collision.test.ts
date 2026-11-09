import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DaemonClient } from "../src/client.ts";
import { LocalSink } from "../src/detach/local-sink.ts";
import { LocalSource } from "../src/detach/local-source.ts";
import { localDaemonId, readLocalRecord, writeLocalRecord } from "../src/detach/local-state.ts";
import { moveSession, type MoveEndpoint } from "../src/move/orchestrate.ts";
import { gate, makeEnv, spawnDaemon, waitFor } from "./helpers.ts";

function appendHistory(manager: SessionManager, text: string) {
  manager.appendMessage({ role: "user", content: text, timestamp: 0 });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: `reply:${text}` }],
    api: "fake-api" as never, provider: "fake", model: "fake-1", stopReason: "stop", timestamp: 0,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
}

function fixture(t: TestContext) {
  const env = makeEnv();
  const keys = [...Object.keys(env.vars), "PI_CODING_AGENT_SESSION_DIR"];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, env.vars);
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const destination = join(env.root, "workspace-b");
  mkdirSync(destination);
  writeFileSync(join(destination, "keep.txt"), "destination work");
  writeFileSync(join(destination, ".env"), "PRIVATE=untouched");
  const stateDir = join(env.root, "sink-state");
  const remoteDir = join(env.root, "remote-storage");
  const remote = SessionManager.create(join(env.root, "remote-workspace"), remoteDir);
  appendHistory(remote, "remote history");
  const source = () => new LocalSource({ session: { sessionId: remote.getSessionId(), cwd: remote.getCwd(), sessionFile: remote.getSessionFile()! },
    stateDir: join(env.root, "source-state"), isBusy: () => false });
  const sink = (options: Partial<ConstructorParameters<typeof LocalSink>[0]> = {}) => new LocalSink({ stateDir, cwd: destination, ...options });
  const transfer = (target: MoveEndpoint, copy = false) => moveSession(source(), target, {
    sessionId: remote.getSessionId(), includeWorkspace: false, compression: "gzip", toCwd: destination, copy,
  });
  const workspace = () => Object.fromEntries(readdirSync(destination).sort().map((name) => [name, readFileSync(join(destination, name), "utf8")]));
  return { env, destination, stateDir, remote, sink, transfer, workspace };
}

function digest(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

// @covers move_fence through the real daemon, HostedSession and SessionActivity.
it("refuses a snapshot while a notified async activity check is pending, then active, and permits settled idle", async (t) => {
  const env = makeEnv();
  writeFileSync(join(env.agentDir, "extensions", "async-activity.ts"), `
    import { existsSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    export default function(pi) {
      let active = false;
      let hold = false;
      const listeners = new Set();
      const file = name => join(process.env.PI_FAKE_GATE_DIR, name);
      pi.events.emit("pi-better-goal:register-provider", {
        id: "async-transfer-work", scope: "session",
        async getActivity() {
          if (hold) {
            writeFileSync(file("activity-check.started"), "");
            const deadline = Date.now() + 15000;
            while (!existsSync(file("activity-check.release"))) {
              if (Date.now() > deadline) throw new Error("activity gate timed out");
              await new Promise(resolve => setTimeout(resolve, 10));
            }
            hold = false;
            writeFileSync(file("activity-check.finished"), "");
          }
          return { items: active ? [{ active: true }] : [] };
        },
        onActivityChanged(notify) { listeners.add(notify); return () => listeners.delete(notify); }
      });
      pi.registerCommand("activity", { description: "Set fixture activity", handler: async args => {
        active = args === "start";
        hold = active;
        for (const notify of listeners) notify();
      } });
    }
  `);
  const { child, socketPath } = await spawnDaemon(env);
  const client = await DaemonClient.connect(socketPath);
  t.after(async () => {
    client.close();
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.kill("SIGKILL");
      await closed;
    }
  });
  const id = (await client.call({ type: "create_session", cwd: env.cwd })).sessionId!;
  const row = async () => ((await client.call({ type: "list_sessions" })).data.sessions as Array<{ sessionId: string; live: boolean; ownership?: string }>).find((entry) => entry.sessionId === id)!;
  await client.call({ type: "prompt", sessionId: id, message: "/activity start" });
  await waitFor("provider check pending over cached idle", () => gate(env, "activity-check").started());
  const refuse = async (moveId: string) => {
    await assert.rejects(client.call({ type: "move_fence", sessionId: id, moveId, waitMs: 0 }), /mid-turn/);
    assert.equal((await row()).ownership, undefined, "refusal must not fence the source");
    assert.equal((await row()).live, true, "refusal must not release the live runtime");
  };
  await refuse("pending-check");
  gate(env, "activity-check").release();
  await waitFor("provider reports active", () => gate(env, "activity-check").finished());
  await refuse("active-check");
  await client.call({ type: "prompt", sessionId: id, message: "/activity stop" });
  await client.call({ type: "move_fence", sessionId: id, moveId: "idle-check", waitMs: 0 });
  assert.equal((await row()).ownership, "fenced");
  assert.equal((await row()).live, false);
  await client.call({ type: "move_unfence", sessionId: id, moveId: "idle-check" });
  assert.equal((await row()).live, true);
});

describe("local transcript collisions across storage scopes", { concurrency: false }, () => {
  for (const storage of ["default", "environment", "settings", "caller-directory", "caller-file"] as const) {
    it(`rejects an ordinary same-id transcript in ${storage} storage before writing, but allows a new-id copy`, async (t) => {
      const f = fixture(t);
      const customDir = join(f.env.root, "custom-storage");
      if (storage === "environment") process.env.PI_CODING_AGENT_SESSION_DIR = customDir;
      if (storage === "settings") writeFileSync(join(f.env.agentDir, "settings.json"), JSON.stringify({ sessionDir: customDir }));
      const ordinary = SessionManager.create(f.env.cwd, storage === "default" ? undefined : customDir, { id: f.remote.getSessionId() });
      appendHistory(ordinary, "independent local history");
      const file = ordinary.getSessionFile()!;
      const before = digest(file);
      const files = f.workspace();
      const target = f.sink(storage === "caller-directory" ? { sessionDirs: [customDir] }
        : storage === "caller-file" ? { sessionFiles: [file] } : {});
      await assert.rejects(f.transfer(target), /local transcript.*second writer/);
      assert.equal(digest(file), before);
      assert.deepEqual(f.workspace(), files);
      assert.equal(existsSync(f.stateDir), false, "collision is rejected before inbound staging or ownership writes");
      const copied = await f.transfer(target, true);
      assert.notEqual(copied.sessionId, ordinary.getSessionId());
      assert.equal(SessionManager.open(copied.sessionFile!).getSessionId(), copied.sessionId);
      assert.equal(digest(file), before);
      appendHistory(ordinary, "ordinary writer continues");
      assert.doesNotMatch(readFileSync(copied.sessionFile!, "utf8"), /ordinary writer continues/);
      assert.deepEqual(f.workspace(), files);
    });
  }

  it("rechecks storage at commit when an ordinary writer appears after move_begin", async (t) => {
    const f = fixture(t);
    const target = f.sink();
    let ordinary: SessionManager | undefined;
    let before: string | undefined;
    const files = f.workspace();
    const racing: MoveEndpoint = { call: async (command) => {
      const result = await target.call(command);
      if (command.type === "move_begin") {
        ordinary = SessionManager.create(f.env.cwd, undefined, { id: f.remote.getSessionId() });
        appendHistory(ordinary, "late local writer");
        before = digest(ordinary.getSessionFile()!);
      }
      return result;
    } };
    await assert.rejects(f.transfer(racing), /local transcript.*second writer/);
    assert.equal(digest(ordinary!.getSessionFile()!), before);
    assert.deepEqual(f.workspace(), files);
    assert.equal(readLocalRecord(f.stateDir, f.remote.getSessionId()), undefined);
  });

  it("accepts known moved history at a newer epoch without exempting unrelated same-id history", async (t) => {
    const f = fixture(t);
    const ordinary = SessionManager.create(f.env.cwd, undefined, { id: f.remote.getSessionId() });
    appendHistory(ordinary, "known local history");
    const file = ordinary.getSessionFile()!;
    const before = digest(file);
    copyFileSync(file, f.remote.getSessionFile()!);
    const continuation = SessionManager.open(f.remote.getSessionFile()!);
    appendHistory(continuation, "remote continuation");
    writeLocalRecord(f.stateDir, { sessionId: ordinary.getSessionId(), state: "moved", epoch: -1, cwd: f.env.cwd, movedTo: localDaemonId() });
    const otherCwd = join(f.env.root, "workspace-c");
    const unrelated = SessionManager.create(otherCwd, undefined, { id: ordinary.getSessionId() });
    appendHistory(unrelated, "unregistered duplicate");
    const duplicate = unrelated.getSessionFile()!;
    const duplicateBefore = digest(duplicate);
    const files = f.workspace();
    await assert.rejects(f.transfer(f.sink()), /local transcript.*second writer/);
    assert.equal(digest(file), before);
    assert.equal(digest(duplicate), duplicateBefore);
    assert.equal(readLocalRecord(f.stateDir, ordinary.getSessionId())?.state, "moved");
    assert.deepEqual(f.workspace(), files);

    // The unrelated transcript is outside known storage for the successful return.
    const { renameSync } = await import("node:fs");
    renameSync(duplicate, join(f.env.root, "unregistered-away.jsonl"));
    const returned = await f.transfer(f.sink());
    assert.equal(returned.sessionId, ordinary.getSessionId());
    assert.notEqual(returned.sessionFile, file);
    assert.equal(digest(file), before);
    assert.match(readFileSync(returned.sessionFile!, "utf8"), /remote continuation/);
    assert.equal(readLocalRecord(f.stateDir, ordinary.getSessionId())?.state, "owned");
    assert.deepEqual(f.workspace(), files);
  });
});
