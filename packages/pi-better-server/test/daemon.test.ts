import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { startDaemon, type Daemon } from "../src/index.ts";
import { Client, gate, llmCalls, makeEnv, spawnDaemon, waitFor, type Env } from "./helpers.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function inProcess(env: Env): Promise<{ daemon: Daemon; client: () => Promise<Client> }> {
  Object.assign(process.env, env.vars);
  const daemon = await startDaemon({ serverDir: env.serverDir });
  cleanups.push(() => daemon.stop());
  return {
    daemon,
    client: async () => {
      const client = await Client.connect(daemon.socketPath);
      cleanups.push(() => client.close());
      return client;
    },
  };
}

async function createSession(client: Client, env: Env, extra: Record<string, unknown> = {}): Promise<string> {
  const response = await client.request({ type: "create_session", cwd: env.cwd, model: { provider: "fake", modelId: "fake-1" }, ...extra });
  assert.equal(response.success, true, JSON.stringify(response));
  return response.sessionId;
}

async function isIdle(client: Client, sessionId: string): Promise<boolean> {
  const state = await client.request({ type: "get_state", sessionId });
  return state.success && !state.data.isStreaming;
}

async function assistantTexts(client: Client, sessionId: string): Promise<string[]> {
  const { data } = await client.request({ type: "get_messages", sessionId });
  return data.messages
    .filter((m: any) => m.role === "assistant")
    .flatMap((m: any) => m.content.filter((c: any) => c.type === "text").map((c: any) => c.text));
}

describe("socket reachability", () => {
  it("serves only a 0700 directory's unix socket and opens no TCP port", async () => {
    const env = makeEnv();
    const { child, socketPath } = await spawnDaemon(env);
    cleanups.push(() => void child.kill("SIGKILL"));
    assert.equal(statSync(env.serverDir).mode & 0o777, 0o700);
    assert.equal(statSync(socketPath).mode & 0o777, 0o600);
    // lsof exits 1 when the process has no network files at all, which is the pass condition.
    let out = "";
    try {
      out = execFileSync("lsof", ["-nP", "-a", "-p", String(child.pid), "-i"], { encoding: "utf8" }).trim();
    } catch (error) {
      assert.equal((error as { status?: number }).status, 1, String(error));
    }
    assert.equal(out, "", `daemon has network sockets:\n${out}`);
    const client = await Client.connect(socketPath);
    cleanups.push(() => client.close());
    const listed = await client.request({ type: "list_sessions" });
    assert.deepEqual(listed.data.sessions, []);
  });

  it("tightens a pre-existing group-readable server directory to 0700", async () => {
    const env = makeEnv();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(env.serverDir, { mode: 0o755 });
    const { chmodSync } = await import("node:fs");
    chmodSync(env.serverDir, 0o755);
    await inProcess(env);
    assert.equal(statSync(env.serverDir).mode & 0o777, 0o700);
  });
});

describe("hosting", () => {
  it("keeps three real sessions running after every client disconnects", async () => {
    const env = makeEnv();
    const { client } = await inProcess(env);
    const first = await client();
    const ids: string[] = [];
    for (const name of ["g1", "g2", "g3"]) {
      const id = await createSession(first, env, { name: `session-${name}` });
      ids.push(id);
      const prompted = await first.request({ type: "prompt", sessionId: id, message: `tool ${name}` });
      assert.equal(prompted.success, true, JSON.stringify(prompted));
    }
    await waitFor("all gates started", () => ["g1", "g2", "g3"].every((n) => gate(env, n).started()));
    first.close();

    for (const name of ["g1", "g2", "g3"]) gate(env, name).release();
    const second = await client();
    for (const id of ids) await waitFor(`${id} idle`, async () => (await isIdle(second, id)) && (await assistantTexts(second, id)).length === 1);
    const listed = await second.request({ type: "list_sessions" });
    assert.equal(listed.data.sessions.length, 3);
    assert.ok(listed.data.sessions.every((s: any) => s.status === "running" && s.live));
    for (const [i, id] of ids.entries()) {
      assert.deepEqual((await assistantTexts(second, id)).at(-1), `tool-done:gate:g${i + 1}`);
    }
  });

  it("pushes session events to the connection that created the session", async () => {
    const env = makeEnv();
    const { client } = await inProcess(env);
    const c = await client();
    const id = await createSession(c, env);
    await c.request({ type: "prompt", sessionId: id, message: "hi" });
    await waitFor("agent_end event", () => c.events.some((e) => e.sessionId === id && e.event.type === "agent_end"));
  });

  it("frames strictly on LF so U+2028 inside a message survives", async () => {
    const env = makeEnv();
    const { client } = await inProcess(env);
    const c = await client();
    const id = await createSession(c, env);
    const message = "a b c";
    await c.request({ type: "prompt", sessionId: id, message });
    await waitFor("echo", async () => (await assistantTexts(c, id)).includes(`echo:${message}`));
  });

  it("answers bad input with errors and keeps the connection usable", async () => {
    const env = makeEnv();
    const { client } = await inProcess(env);
    const c = await client();
    const unknown = await c.request({ type: "get_state", sessionId: "nope" });
    assert.equal(unknown.success, false);
    const missing = await c.request({ type: "get_state" });
    assert.equal(missing.success, false);
    const forked = await c.request({ type: "fork", sessionId: await createSession(c, env), entryId: "x" });
    assert.equal(forked.success, false);
    assert.match(forked.error, /not supported/);
    c.sendRaw("{not json\n");
    await waitFor("parse failure", async () => true);
    assert.equal((await c.request({ type: "list_sessions" })).success, true);
  });

  it("close_session stops resumption; open_session brings it back", async () => {
    const env = makeEnv();
    const first = await inProcess(env);
    const c1 = await first.client();
    const id = await createSession(c1, env);
    await c1.request({ type: "prompt", sessionId: id, message: "keep" });
    await waitFor("reply", async () => (await assistantTexts(c1, id)).includes("echo:keep"));
    await c1.request({ type: "close_session", sessionId: id });
    assert.equal((await c1.request({ type: "get_state", sessionId: id })).success, false);
    await first.daemon.stop();

    const second = await inProcess(env);
    const c2 = await second.client();
    const [summary] = (await c2.request({ type: "list_sessions" })).data.sessions;
    assert.equal(summary.status, "closed");
    assert.equal(summary.live, false);
    const opened = await c2.request({ type: "open_session", sessionId: id });
    assert.equal(opened.success, true, JSON.stringify(opened));
    assert.ok((await assistantTexts(c2, id)).includes("echo:keep"));
  });
});

describe("crash recovery", () => {
  it("lists and resumes sessions from the last persisted entry after kill -9", async () => {
    const env = makeEnv();
    const run1 = await spawnDaemon(env);
    cleanups.push(() => void run1.child.kill("SIGKILL"));
    const c1 = await Client.connect(run1.socketPath);
    const a = await createSession(c1, env, { name: "alpha" });
    const b = await createSession(c1, env, { name: "beta" });
    await c1.request({ type: "prompt", sessionId: a, message: "one" });
    await waitFor("alpha reply", async () => (await assistantTexts(c1, a)).includes("echo:one"));
    const before = (await c1.request({ type: "get_entries", sessionId: a })).data;
    const sessionFile = (await c1.request({ type: "get_state", sessionId: a })).data.sessionFile;
    c1.close();

    run1.child.kill("SIGKILL");
    await new Promise((resolve) => run1.child.once("exit", resolve));
    assert.ok(existsSync(run1.socketPath), "kill -9 leaves a stale socket behind");

    const run2 = await spawnDaemon(env);
    cleanups.push(() => void run2.child.kill("SIGKILL"));
    const c2 = await Client.connect(run2.socketPath);
    cleanups.push(() => c2.close());
    const listed = (await c2.request({ type: "list_sessions" })).data.sessions;
    assert.deepEqual(listed.map((s: any) => s.sessionId).sort(), [a, b].sort());
    assert.ok(listed.every((s: any) => s.status === "running" && s.live));
    assert.equal(listed.find((s: any) => s.sessionId === a).name, "alpha");

    const after = (await c2.request({ type: "get_entries", sessionId: a })).data;
    assert.deepEqual(after.entries, before.entries);
    assert.equal(after.leafId, before.leafId);
    assert.equal((await c2.request({ type: "get_state", sessionId: a })).data.sessionFile, sessionFile);

    await c2.request({ type: "prompt", sessionId: a, message: "two" });
    await waitFor("alpha continues", async () => (await assistantTexts(c2, a)).includes("echo:two"));
    const texts = await assistantTexts(c2, a);
    assert.deepEqual(texts, ["echo:one", "echo:two"]);
    // The never-prompted session came back too and works.
    await c2.request({ type: "prompt", sessionId: b, message: "hello" });
    await waitFor("beta reply", async () => (await assistantTexts(c2, b)).includes("echo:hello"));
  });
});

describe("prompt disposition", () => {
  // Pi 1.x reports started / handled / queued; Pi 0.82 reports nothing, so the response carries no data.
  const reportsDisposition = Number(PI_VERSION.split(".")[0]) >= 1;

  it("prompt, steer and follow_up carry Pi's disposition when the installed Pi reports one", async () => {
    const env = makeEnv();
    const { client } = await inProcess(env);
    const c = await client();
    const id = await createSession(c, env);
    const disposition = (r: any) => r.data?.disposition;

    const prompted = await c.request({ type: "prompt", sessionId: id, message: "tool d1" });
    assert.equal(prompted.success, true, JSON.stringify(prompted));
    assert.equal(disposition(prompted), reportsDisposition ? "started" : undefined);
    await waitFor("tool running", () => gate(env, "d1").started());

    const steered = await c.request({ type: "steer", sessionId: id, message: "steer it" });
    assert.equal(steered.success, true, JSON.stringify(steered));
    assert.equal(disposition(steered), reportsDisposition ? "queued" : undefined);
    const followed = await c.request({ type: "follow_up", sessionId: id, message: "then this" });
    assert.equal(followed.success, true, JSON.stringify(followed));
    assert.equal(disposition(followed), reportsDisposition ? "queued" : undefined);
    gate(env, "d1").release();
    await waitFor("turn done", async () => (await isIdle(c, id)) && (await assistantTexts(c, id)).includes("echo:then this"));
  });
});

describe("steer", () => {
  it("mid-turn steer lands after the running tool and before the next LLM call", async () => {
    const env = makeEnv();
    const { client } = await inProcess(env);
    const c = await client();
    const id = await createSession(c, env);
    await c.request({ type: "prompt", sessionId: id, message: "tool s1" });
    await waitFor("tool running", () => gate(env, "s1").started());

    const steered = await c.request({ type: "steer", sessionId: id, message: "change course" });
    assert.equal(steered.success, true, JSON.stringify(steered));
    // The turn is still inside the tool call: exactly one LLM call so far, steer still queued.
    assert.equal(llmCalls(env).length, 1);
    assert.equal((await c.request({ type: "get_state", sessionId: id })).data.pendingMessageCount, 1);

    gate(env, "s1").release();
    await waitFor("turn done", async () => (await isIdle(c, id)) && llmCalls(env).length >= 2);

    const calls = llmCalls(env);
    assert.equal(calls.length, 2);
    const second = calls[1]!;
    assert.deepEqual(second.messages.slice(-3).map((m) => m.role), ["assistant", "toolResult", "user"]);
    assert.equal(second.messages.at(-1)!.text, "change course");
    const finishedAt = Number(await import("node:fs").then((fs) => fs.readFileSync(`${env.gateDir}/s1.finished`, "utf8")));
    assert.ok(second.at >= finishedAt, "the next LLM call happens after the tool finished");
    assert.equal((await assistantTexts(c, id)).at(-1), "echo:change course");
  });

  it("steer on an idle session starts the next turn", async () => {
    const env = makeEnv();
    const { client } = await inProcess(env);
    const c = await client();
    const id = await createSession(c, env);
    const steered = await c.request({ type: "steer", sessionId: id, message: "wake up" });
    assert.equal(steered.success, true, JSON.stringify(steered));
    await waitFor("turn ran", async () => (await assistantTexts(c, id)).includes("echo:wake up"));
    assert.equal(llmCalls(env).length, 1);
  });

  it("a steer sent right behind a prompt (during preflight) is queued for that turn, not lost", async () => {
    const env = makeEnv();
    const { client } = await inProcess(env);
    const c = await client();
    const id = await createSession(c, env);
    // One write holds both lines, so the steer is dispatched while the prompt is still in Pi's preflight.
    c.sendRaw(`${JSON.stringify({ id: "p1", type: "prompt", sessionId: id, message: "tool g1" })}\n${JSON.stringify({ id: "s1", type: "steer", sessionId: id, message: "change course" })}\n`);
    const responses = await Promise.all(["p1", "s1"].map((rid) => c.responseFor(rid)));
    for (const r of responses) assert.equal(r.success, true, JSON.stringify(r));
    // The steer joins the starting turn: it must reach an LLM call and the session history, never vanish.
    await waitFor("turn done", async () => (await isIdle(c, id)) && llmCalls(env).length >= 1);
    const delivered = llmCalls(env).some((call) => call.messages.some((m) => m.role === "user" && m.text === "change course"));
    assert.ok(delivered, "an LLM call saw the steer");
    const messages = (await c.request({ type: "get_messages", sessionId: id })).data.messages;
    assert.ok(messages.some((m: any) => m.role === "user" && JSON.stringify(m.content).includes("change course")), "steer is in the session history");
    assert.equal((await c.request({ type: "get_state", sessionId: id })).data.pendingMessageCount, 0);
  });
});
