import assert from "node:assert/strict";
import { execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DaemonClient } from "../src/client.ts";
import { detachSession, returnSession } from "../src/detach/detach.ts";
import { LocalSink } from "../src/detach/local-sink.ts";
import { LocalSource } from "../src/detach/local-source.ts";
import { localBlockedReason, readLocalRecord, writeLocalRecord } from "../src/detach/local-state.ts";
import { MoveError, moveSession, type MoveEndpoint } from "../src/move/orchestrate.ts";
import { gate, makeEnv, spawnDaemon, waitFor, type Env } from "./helpers.ts";

interface Host { env: Env; client: DaemonClient; child: ChildProcess; socketPath: string }
async function host(t: TestContext, extension?: string, extraVars: Record<string, string> = {}): Promise<Host> {
  const env = makeEnv();
  Object.assign(env.vars, extraVars);
  if (extension) writeFileSync(join(env.agentDir, "extensions", "transfer-fixture.ts"), extension);
  const { child, socketPath } = await spawnDaemon(env);
  t.after(async () => {
    client.close();
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      child.kill("SIGKILL");
      await closed;
    }
  });
  const client = await DaemonClient.connect(socketPath);
  return { env, client, child, socketPath };
}

function local(t: TestContext) {
  const env = makeEnv();
  const previous = new Map(Object.keys(env.vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env.vars);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const manager = SessionManager.create(env.cwd, join(env.agentDir, "sessions", "seed"));
  manager.appendModelChange("fake", "fake-1");
  manager.appendMessage({ role: "user", content: "shared history", timestamp: 0 });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "original reply" }], api: "fake-api" as never,
    provider: "fake", model: "fake-1", stopReason: "stop", timestamp: 0,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const sessionFile = manager.getSessionFile()!;
  const info = { sessionId: manager.getSessionId(), cwd: env.cwd, sessionFile, model: "fake/fake-1" };
  writeFileSync(join(env.cwd, "source-only.txt"), "do not transfer workspace files");
  writeFileSync(join(env.cwd, ".env"), "PRIVATE_TOKEN=stays-here");
  return { env, manager, info, sessionFile, stateDir: join(env.root, "state") };
}

function tree(cwd: string): Record<string, string> {
  return Object.fromEntries(readdirSync(cwd).sort().map((name) => [name, readFileSync(join(cwd, name), "utf8")]));
}
function populate(cwd: string) {
  writeFileSync(join(cwd, "keep.txt"), "destination work");
  writeFileSync(join(cwd, ".env"), "DESTINATION_TOKEN=untouched");
  return tree(cwd);
}
async function rows(client: DaemonClient) {
  return (await client.call({ type: "list_sessions" })).data.sessions as Array<{ sessionId: string; sessionFile: string; ownership?: string; live: boolean; status: string; needsInput: unknown[] }>;
}
async function row(client: DaemonClient, sessionId: string) {
  return (await rows(client)).find((entry) => entry.sessionId === sessionId)!;
}
async function messages(client: DaemonClient, sessionId: string) {
  return JSON.stringify((await client.call({ type: "get_messages", sessionId })).data.messages);
}
async function prompt(client: DaemonClient, sessionId: string, text: string) {
  await client.call({ type: "prompt", sessionId, message: text });
  await waitFor(`reply to ${text}`, async () => (await messages(client, sessionId)).includes(`echo:${text}`));
  await waitFor("idle", async () => !(await client.call({ type: "get_state", sessionId })).data.isStreaming);
}
async function session(h: Host) {
  const id = (await h.client.call({ type: "create_session", cwd: h.env.cwd, model: { provider: "fake", modelId: "fake-1" } })).sessionId!;
  await prompt(h.client, id, "shared history");
  return id;
}
const choices = { includeWorkspace: false, compression: "gzip" as const };

function loseAck(client: DaemonClient, abortReachable: boolean): MoveEndpoint {
  return { server: client.server, call: async (command) => {
    if (command.type === "move_abort" && !abortReachable) throw new Error("target unreachable");
    const response = await client.call(command);
    if (command.type === "move_commit") throw new Error("commit reply lost");
    return response;
  } };
}

describe("session transfer safety", { concurrency: false }, () => {
  it("pushes and pulls a session-only gzip handoff through populated non-git directories without changing files", async (t) => {
    const l = local(t);
    const h = await host(t, undefined, { PI_REMOTE_MIN_FREE_BYTES: String(2 ** 60) });
    const before = populate(h.env.cwd);
    const originalFiles = tree(l.env.cwd);
    const originalTranscript = readFileSync(l.sessionFile, "utf8");
    const connect = () => DaemonClient.connect(h.socketPath);
    const pushed = await detachSession({ session: l.info, stateDir: l.stateDir, host: "host", connect, isBusy: () => false, ...choices, copy: false, toCwd: h.env.cwd });
    assert.equal(pushed.sessionId, l.info.sessionId);
    assert.equal(pushed.sourceId, l.info.sessionId);
    assert.equal(pushed.destinationId, pushed.sessionId);
    assert.equal(pushed.sourceUnfenced, false);
    assert.equal(pushed.worktreeFiles, 0);
    assert.deepEqual(tree(h.env.cwd), before);
    assert.deepEqual(tree(l.env.cwd), originalFiles);
    assert.equal(readLocalRecord(l.stateDir, l.info.sessionId)?.state, "moved");
    assert.match(localBlockedReason(l.stateDir, l.info.sessionId)!, /moved/);
    assert.equal(SessionManager.open(pushed.sessionFile!).getCwd(), h.env.cwd);
    await prompt(h.client, pushed.sessionId, "remote continuation");
    const pulled = await returnSession({ ref: pushed.sessionId, connect, stateDir: l.stateDir, ...choices, copy: false, toCwd: l.env.cwd });
    assert.equal(pulled.sessionId, pushed.sessionId);
    assert.equal(pulled.sourceId, pushed.sessionId);
    assert.equal(pulled.sourceUnfenced, false);
    assert.notEqual(pulled.sessionFile, l.sessionFile, "return never overwrites the original transcript");
    assert.equal(readFileSync(l.sessionFile, "utf8"), originalTranscript);
    assert.equal(SessionManager.open(pulled.sessionFile!).getCwd(), l.env.cwd);
    assert.match(readFileSync(pulled.sessionFile!, "utf8"), /remote continuation/);
    assert.equal((await row(h.client, pushed.sessionId)).ownership, "moved");
    assert.equal(readLocalRecord(l.stateDir, pushed.sessionId)?.state, "owned");
    assert.deepEqual(tree(h.env.cwd), before);
    assert.deepEqual(tree(l.env.cwd), originalFiles);
  });

  it("copies in both directions with new logical ids, unchanged history entries, and independently writable sources", async (t) => {
    const l = local(t);
    const h = await host(t);
    const files = populate(h.env.cwd);
    const lines = readFileSync(l.sessionFile, "utf8").split("\n");
    writeFileSync(l.sessionFile, `${JSON.stringify({ ...JSON.parse(lines[0]!), parentSession: "/source-only/parent.jsonl", parentSessionFile: "/source-only/legacy.jsonl" })}\n${lines.slice(1).join("\n")}`);
    const connect = () => DaemonClient.connect(h.socketPath);
    const pushed = await detachSession({ session: l.info, stateDir: l.stateDir, host: "host", connect, isBusy: () => false, ...choices, copy: true, toCwd: h.env.cwd });
    assert.notEqual(pushed.sessionId, l.info.sessionId);
    assert.equal(pushed.destinationId, pushed.sessionId);
    assert.equal(pushed.sourceUnfenced, true);
    assert.equal(readLocalRecord(l.stateDir, l.info.sessionId)?.state, "owned");
    const remoteLines = readFileSync(pushed.sessionFile!, "utf8").split("\n");
    const header = JSON.parse(remoteLines[0]!);
    assert.equal(header.id, pushed.sessionId);
    assert.equal(header.cwd, h.env.cwd);
    assert.equal(header.parentSession, undefined);
    assert.equal(header.parentSessionFile, undefined);
    assert.deepEqual(remoteLines.slice(1, lines.length - 1), lines.slice(1, -1), "copy changes no original conversation entry or parent id");
    l.manager.appendMessage({ role: "user", content: "local source branch", timestamp: 0 });
    await prompt(h.client, pushed.sessionId, "remote branch");
    assert.doesNotMatch(await messages(h.client, pushed.sessionId), /local source branch/);
    assert.doesNotMatch(readFileSync(l.sessionFile, "utf8"), /remote branch/);
    const pulled = await returnSession({ ref: pushed.sessionId, connect, stateDir: l.stateDir, ...choices, copy: true, toCwd: l.env.cwd });
    assert.notEqual(pulled.sessionId, pushed.sessionId);
    assert.notEqual(pulled.sessionId, l.info.sessionId);
    assert.equal(pulled.sourceId, pushed.sessionId);
    assert.equal(pulled.sourceUnfenced, true);
    assert.equal((await row(h.client, pushed.sessionId)).ownership, undefined);
    assert.equal(SessionManager.open(pulled.sessionFile!).getSessionId(), pulled.sessionId);
    assert.match(readFileSync(pulled.sessionFile!, "utf8"), /remote branch/);
    await prompt(h.client, pushed.sessionId, "after pull copy");
    assert.doesNotMatch(readFileSync(pulled.sessionFile!, "utf8"), /after pull copy/);
    assert.deepEqual(tree(h.env.cwd), files);
  });

  it("pulls a never-prompted session as a resumable transcript with the destination logical id", async (t) => {
    const l = local(t);
    const h = await host(t);
    const id = (await h.client.call({ type: "create_session", cwd: h.env.cwd, model: { provider: "fake", modelId: "fake-1" } })).sessionId!;
    const before = tree(l.env.cwd);
    const connect = () => DaemonClient.connect(h.socketPath);
    for (const copy of [true, false]) {
      const result = await returnSession({ ref: id, connect, stateDir: l.stateDir, ...choices, copy, toCwd: l.env.cwd });
      assert.ok(result.sessionFile, "even an empty session has an exact resume file");
      const manager = SessionManager.open(result.sessionFile);
      assert.equal(manager.getSessionId(), result.sessionId);
      assert.equal(manager.getCwd(), l.env.cwd);
      assert.equal(result.sourceId, id);
      assert.equal(result.sourceUnfenced, copy);
      if (copy) assert.notEqual(result.sessionId, id);
      else assert.equal(result.sessionId, id);
      assert.deepEqual(tree(l.env.cwd), before);
    }
    assert.equal((await row(h.client, id)).ownership, "moved");
  });

  it("refuses old capabilities and missing or invalid session-only destinations before fencing, while retaining provider auth checks", async (t) => {
    const l = local(t);
    const h = await host(t);
    const base = { session: l.info, stateDir: l.stateDir, host: "host", isBusy: () => false, ...choices, copy: false };
    const connect = () => DaemonClient.connect(h.socketPath);
    for (const toCwd of [undefined, "relative", join(h.env.root, "missing")]) {
      await assert.rejects(detachSession({ ...base, connect, ...(toCwd ? { toCwd } : {}) }), /existing.*(directory|absolute)|must be an existing directory/);
      assert.equal(readLocalRecord(l.stateDir, l.info.sessionId), undefined);
    }
    await assert.rejects(detachSession({ ...base, toCwd: h.env.cwd, connect: async () => {
      const client = await connect();
      client.server!.capabilities = ["session-transfer-v1"];
      return client;
    } }), /compressed-bundle-v1/);
    await assert.rejects(detachSession({ ...base, toCwd: h.env.cwd, connect, session: { ...l.info, model: "anthropic/missing" } }), /provider-auth/);
    assert.equal(readLocalRecord(l.stateDir, l.info.sessionId), undefined);
    assert.deepEqual(await rows(h.client), []);
  });

  it("rolls back corrupt session-only transfers and preserves the populated destination", async (t) => {
    const a = await host(t);
    const b = await host(t);
    const id = await session(a);
    const files = populate(b.env.cwd);
    await assert.rejects(moveSession(a.client, b.client, { sessionId: id, ...choices, toCwd: b.env.cwd, faults: { corruptChunk: 0 } }), (error: unknown) => error instanceof MoveError && error.sourceUnfenced && /checksum mismatch/.test(error.message));
    assert.deepEqual(tree(b.env.cwd), files);
    assert.deepEqual(await rows(b.client), []);
    await prompt(a.client, id, "after corruption");
    const moved = await moveSession(a.client, b.client, { sessionId: id, ...choices, toCwd: b.env.cwd });
    assert.equal(moved.sessionId, id);
    assert.equal((await row(a.client, id)).ownership, "moved");
    assert.equal((await a.client.request({ type: "prompt", sessionId: id, message: "forbidden writer" })).success, false);
    assert.match(await messages(b.client, id), /after corruption/);
    assert.deepEqual(tree(b.env.cwd), files);
  });

  it("rejects a mismatched copy transcript header after verification without deleting destination files", async (t) => {
    const l = local(t);
    const h = await host(t);
    const files = populate(h.env.cwd);
    const lines = readFileSync(l.sessionFile, "utf8").split("\n");
    writeFileSync(l.sessionFile, `${JSON.stringify({ ...JSON.parse(lines[0]!), id: "not-the-bundled-session" })}\n${lines.slice(1).join("\n")}`);
    await assert.rejects(detachSession({ session: l.info, stateDir: l.stateDir, host: "host", connect: () => DaemonClient.connect(h.socketPath), isBusy: () => false, ...choices, copy: true, toCwd: h.env.cwd }), (error: unknown) => error instanceof MoveError && error.sourceUnfenced && /Transcript header/.test(error.message));
    assert.deepEqual(tree(h.env.cwd), files);
    assert.deepEqual(await rows(h.client), []);
    assert.equal(readLocalRecord(l.stateDir, l.info.sessionId)?.state, "owned");
  });

  it("rejects same-id imports for both open and closed sessions, and accepts a legitimate tombstone return without deleting old history", async (t) => {
    const a = await host(t);
    const b = await host(t);
    const id = await session(a);
    const original = await row(a.client, id);
    const oldContent = readFileSync(original.sessionFile, "utf8");
    for (const closed of [false, true]) {
      if (closed) await a.client.call({ type: "close_session", sessionId: id });
      await assert.rejects(a.client.call({ type: "move_begin", moveId: `collision-${closed}`, sessionId: id, size: 0, sha256: "0".repeat(64) }), /already exists/);
      assert.equal(readFileSync(original.sessionFile, "utf8"), oldContent);
    }
    await a.client.call({ type: "open_session", sessionId: id });
    await moveSession(a.client, b.client, { sessionId: id, ...choices, toCwd: b.env.cwd });
    await prompt(b.client, id, "away history");
    const priorImport = (await row(b.client, id)).sessionFile;
    const priorImportContent = readFileSync(priorImport, "utf8");
    const returned = await moveSession(b.client, a.client, { sessionId: id, ...choices, toCwd: a.env.cwd });
    assert.notEqual(returned.sessionFile, original.sessionFile);
    assert.equal(readFileSync(original.sessionFile, "utf8"), oldContent);
    assert.match(await messages(a.client, id), /away history/);
    assert.equal((await row(b.client, id)).ownership, "moved");
    await prompt(a.client, id, "home history");
    const again = await moveSession(a.client, b.client, { sessionId: id, ...choices, toCwd: b.env.cwd });
    assert.notEqual(again.sessionFile, priorImport);
    assert.equal(readFileSync(priorImport, "utf8"), priorImportContent, "a later import preserves the previous imported transcript");
    assert.match(await messages(b.client, id), /home history/);
  });

  it("holds the source snapshot fence through transfer, then resumes the original after a successful daemon copy", async (t) => {
    const a = await host(t);
    const b = await host(t);
    const id = await session(a);
    const before = await messages(a.client, id);
    let checkedFence = false;
    const target: MoveEndpoint = { server: b.client.server, call: async (command) => {
      if (command.type === "move_begin") {
        const refused = await a.client.request({ type: "prompt", sessionId: id, message: "write during snapshot" });
        assert.equal(refused.success, false);
        assert.match(refused.error!, /fenced/);
        checkedFence = true;
      }
      return b.client.call(command);
    } };
    const result = await moveSession(a.client, target, { sessionId: id, ...choices, copy: true, toCwd: b.env.cwd });
    assert.equal(checkedFence, true);
    assert.notEqual(result.sessionId, id);
    assert.equal(result.sourceUnfenced, true);
    assert.equal(await messages(b.client, result.sessionId), before);
    assert.equal((await row(a.client, id)).ownership, undefined);
    await prompt(a.client, id, "original continued");
    await prompt(b.client, result.sessionId, "copy continued");
    assert.doesNotMatch(await messages(b.client, result.sessionId), /original continued/);
    assert.doesNotMatch(await messages(a.client, id), /copy continued/);
  });

  for (const abortReachable of [false, true]) {
    it(`unfences a copy source after a lost commit reply with target outcome ${abortReachable ? "committed" : "unknown"}`, async (t) => {
      const a = await host(t);
      const b = await host(t);
      const id = await session(a);
      let failure: MoveError | undefined;
      await assert.rejects(moveSession(a.client, loseAck(b.client, abortReachable), { sessionId: id, ...choices, copy: true, toCwd: b.env.cwd }), (error: unknown) => {
        if (!(error instanceof MoveError)) return false;
        failure = error;
        return error.sourceUnfenced && /Partial copy/.test(error.message);
      });
      assert.equal(failure!.sourceId, id);
      assert.equal(failure!.targetOutcome, abortReachable ? "committed" : "unknown");
      assert.notEqual(failure!.destinationId, id);
      assert.equal((await row(a.client, id)).ownership, undefined);
      assert.equal((await row(b.client, failure!.destinationId!)).live, true);
      await prompt(a.client, id, "source after partial copy");
      await prompt(b.client, failure!.destinationId!, "copy after partial copy");
      assert.doesNotMatch(await messages(a.client, id), /copy after partial copy/);
    });
  }

  it("keeps a handoff source fenced when the target acknowledgement and outcome cannot be read", async (t) => {
    const a = await host(t);
    const b = await host(t);
    const id = await session(a);
    await assert.rejects(moveSession(a.client, loseAck(b.client, false), { sessionId: id, ...choices, toCwd: b.env.cwd }), (error: unknown) => error instanceof MoveError && !error.sourceUnfenced && /stays fenced/.test(error.message));
    assert.equal((await row(a.client, id)).ownership, "fenced");
    assert.equal((await a.client.request({ type: "prompt", sessionId: id, message: "no second writer" })).success, false);
    assert.equal((await row(b.client, id)).live, true);
  });

  it("recovers a lost handoff acknowledgement by retrying commit before retiring the source", async (t) => {
    const a = await host(t);
    const b = await host(t);
    const id = await session(a);
    let lost = false;
    const flaky: MoveEndpoint = { call: async (command) => {
      const result = await b.client.call(command);
      if (command.type === "move_commit" && !lost) { lost = true; throw new Error("first reply lost"); }
      return result;
    } };
    const result = await moveSession(a.client, flaky, { sessionId: id, ...choices, toCwd: b.env.cwd });
    assert.equal(result.sessionId, id);
    assert.equal((await row(a.client, id)).ownership, "moved");
    assert.equal((await rows(b.client)).length, 1);
    await prompt(b.client, id, "after recovered ack");
  });

  it("an abort racing target startup waits for the commit result instead of reporting a false rollback", async (t) => {
    const startup = `import { existsSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      export default function(pi) {
        pi.on("session_start", async () => {
          const root = process.env.PI_FAKE_GATE_DIR;
          writeFileSync(join(root, "import-startup.started"), "");
          const deadline = Date.now() + 15000;
          while (!existsSync(join(root, "import-startup.release"))) {
            if (Date.now() > deadline) throw new Error("import gate timed out");
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        });
      }`;
    const a = await host(t);
    const b = await host(t, startup);
    const id = await session(a);
    let abortResult: { committed: boolean } | undefined;
    const target: MoveEndpoint = { call: async (command) => {
      if (command.type !== "move_commit") return b.client.call(command);
      const committing = b.client.call(command);
      await waitFor("target startup awaiting gate", () => gate(b.env, "import-startup").started());
      const aborting = b.client.call({ type: "move_abort", moveId: command.moveId, sessionId: id });
      // Same connection: the later response proves the server dispatched the abort before release.
      await b.client.call({ type: "list_sessions" });
      gate(b.env, "import-startup").release();
      abortResult = (await aborting).data;
      return committing;
    } };
    const result = await moveSession(a.client, target, { sessionId: id, ...choices, toCwd: b.env.cwd });
    assert.equal(abortResult?.committed, true);
    assert.equal(result.sessionId, id);
    assert.equal((await row(a.client, id)).ownership, "moved");
    await prompt(b.client, id, "after racing abort");
  });

  it("a moved tombstone rejects an unrelated source rather than replacing its saved history", async (t) => {
    const a = await host(t);
    const b = await host(t);
    const id = await session(a);
    const first = await moveSession(a.client, b.client, { sessionId: id, ...choices, toCwd: b.env.cwd });
    const saved = readFileSync(first.sessionFile!, "utf8");
    await moveSession(b.client, a.client, { sessionId: id, ...choices, toCwd: a.env.cwd });
    const original = (await row(a.client, id)).sessionFile;
    const stranger = new LocalSource({ session: { sessionId: id, sessionFile: original, cwd: a.env.cwd }, stateDir: join(a.env.root, "stranger"), isBusy: () => false });
    await assert.rejects(moveSession(stranger, b.client, { sessionId: id, ...choices, toCwd: b.env.cwd }), (error: unknown) => error instanceof MoveError && error.sourceUnfenced && /known owner at a newer epoch/.test(error.message));
    assert.equal(readFileSync(first.sessionFile!, "utf8"), saved);
    assert.equal((await row(b.client, id)).ownership, "moved");
    assert.equal((await row(b.client, id)).sessionFile, first.sessionFile);
  });

  it("does not delete a populated full-workspace destination when materialization refuses it", async (t) => {
    const l = local(t);
    execFileSync("git", ["init", "-q"], { cwd: l.env.cwd });
    execFileSync("git", ["add", "source-only.txt"], { cwd: l.env.cwd });
    execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "base"], { cwd: l.env.cwd });
    const h = await host(t);
    const before = populate(h.env.cwd);
    await assert.rejects(detachSession({ session: l.info, stateDir: l.stateDir, host: "host", connect: () => DaemonClient.connect(h.socketPath), isBusy: () => false, toCwd: h.env.cwd, includeWorkspace: true, compression: "gzip", copy: false }), /not empty/);
    assert.deepEqual(tree(h.env.cwd), before);
    assert.equal(readLocalRecord(l.stateDir, l.info.sessionId)?.state, "owned");
    const result = await detachSession({ session: l.info, stateDir: l.stateDir, host: "host", connect: () => DaemonClient.connect(h.socketPath), isBusy: () => false, includeWorkspace: true, compression: "gzip", copy: false });
    assert.equal(readFileSync(join(result.cwd, "source-only.txt"), "utf8"), "do not transfer workspace files");
    assert.equal(existsSync(join(result.cwd, ".env")), false);
  });

  it("refuses restoring a local owned or fenced id and leaves an existing transcript untouched", async (t) => {
    const l = local(t);
    const before = readFileSync(l.sessionFile, "utf8");
    const sink = new LocalSink({ stateDir: l.stateDir, cwd: l.env.cwd });
    for (const state of ["owned", "fenced"] as const) {
      writeLocalRecord(l.stateDir, { sessionId: l.info.sessionId, state, epoch: 1, cwd: l.env.cwd });
      await assert.rejects(sink.call({ type: "move_begin", moveId: `local-${state}`, sessionId: l.info.sessionId, size: 0, sha256: "0".repeat(64), includeWorkspace: false }), /refusing a second writer/);
    }
    assert.equal(readFileSync(l.sessionFile, "utf8"), before);
  });

  it("refuses snapshot fences during prompt preflight, bash, background work, and unresolved dialogs", async (t) => {
    const background = `export default function(pi) {
      let active = false;
      const listeners = new Set();
      pi.events.emit("pi-better-goal:register-provider", {
        id: "background-tasks", scope: "session",
        getActivity() { return { items: active ? [{ active: true }] : [] }; },
        onActivityChanged(notify) { listeners.add(notify); return () => listeners.delete(notify); }
      });
      pi.registerCommand("transfer-background", {
        description: "Set test background activity",
        handler: async (args) => { active = args === "start"; for (const notify of listeners) notify(); }
      });
    }`;
    const a = await host(t, background);
    const b = await host(t);
    const id = await session(a);
    const refuse = async (pattern: RegExp) => {
      await assert.rejects(moveSession(a.client, b.client, { sessionId: id, ...choices, copy: true, waitMs: 0, toCwd: b.env.cwd }), pattern);
      assert.equal((await row(a.client, id)).ownership, undefined, "a busy source is never fenced");
      assert.deepEqual(await rows(b.client), []);
    };
    const preflight = a.client.call({ type: "prompt", sessionId: id, message: "hold transfer-preflight" });
    await waitFor("preflight held", () => gate(a.env, "transfer-preflight").started());
    await refuse(/mid-turn/);
    gate(a.env, "transfer-preflight").release();
    await preflight;
    const script = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(join(a.env.gateDir, "transfer-bash.started"))}, ''); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(join(a.env.gateDir, "transfer-bash.release"))})) clearInterval(timer); }, 10);`;
    const bash = a.client.call({ type: "bash", sessionId: id, command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}` });
    await waitFor("bash running", () => gate(a.env, "transfer-bash").started());
    await refuse(/mid-turn/);
    gate(a.env, "transfer-bash").release();
    await bash;
    await a.client.call({ type: "prompt", sessionId: id, message: "/transfer-background start" });
    await refuse(/mid-turn/);
    await a.client.call({ type: "prompt", sessionId: id, message: "/transfer-background stop" });
    await a.client.call({ type: "prompt", sessionId: id, message: "ask unresolved transfer approval" });
    await waitFor("approval dialog", async () => (await row(a.client, id)).needsInput.length > 0);
    await refuse(/pending input or approval/);
  });

  it("a local transcript filename collision fails without overwriting or deleting the existing file", async (t) => {
    const l = local(t);
    const destination = join(l.env.root, "destination");
    mkdirSync(destination);
    const files = populate(destination);
    const now = new Date("2026-01-02T03:04:05.000Z");
    t.mock.timers.enable({ apis: ["Date"], now: now.getTime() });
    const collision = SessionManager.create(destination, undefined, { id: l.info.sessionId }).getSessionFile()!;
    const sentinel = '{"type":"session","id":"unrelated-writer"}\n';
    writeFileSync(collision, sentinel);
    const source = new LocalSource({ session: l.info, stateDir: l.stateDir, isBusy: () => false });
    const sink = new LocalSink({ stateDir: join(l.env.root, "sink-state"), cwd: destination });
    await assert.rejects(moveSession(source, sink, { sessionId: l.info.sessionId, ...choices, toCwd: destination }), (error: unknown) => error instanceof MoveError && error.sourceUnfenced && /EEXIST/.test(error.message));
    assert.equal(readFileSync(collision, "utf8"), sentinel);
    assert.deepEqual(tree(destination), files);
    assert.equal(readLocalRecord(l.stateDir, l.info.sessionId)?.state, "owned");
  });

  it("only the snapshot's fencing move may unfence a local copy source", async (t) => {
    const l = local(t);
    const source = new LocalSource({ session: l.info, stateDir: l.stateDir, isBusy: () => false });
    await source.call({ type: "move_fence", sessionId: l.info.sessionId, moveId: "snapshot-owner" });
    await assert.rejects(source.call({ type: "move_unfence", sessionId: l.info.sessionId, moveId: "wrong-snapshot" }), /another move/);
    assert.equal(readLocalRecord(l.stateDir, l.info.sessionId)?.state, "fenced");
    await source.call({ type: "move_unfence", sessionId: l.info.sessionId, moveId: "snapshot-owner" });
    assert.equal(readLocalRecord(l.stateDir, l.info.sessionId)?.state, "owned");
  });
});
