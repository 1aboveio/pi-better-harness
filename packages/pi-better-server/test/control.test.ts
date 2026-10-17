import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { promisify } from "node:util";
import { socketPathFor } from "../src/paths.ts";
import { startDaemon, type Daemon, type DaemonOptions } from "../src/index.ts";
import { Client, gate, makeEnv, waitFor, type Env } from "./helpers.ts";

const run = promisify(execFile);
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function inProcess(env: Env, options: Partial<DaemonOptions> = {}): Promise<{ daemon: Daemon; client: () => Promise<Client> }> {
  Object.assign(process.env, env.vars);
  const daemon = await startDaemon({ serverDir: env.serverDir, ...options });
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

async function createSession(client: Client, env: Env): Promise<string> {
  const response = await client.request({ type: "create_session", cwd: env.cwd, model: { provider: "fake", modelId: "fake-1" } });
  assert.equal(response.success, true, JSON.stringify(response));
  return response.sessionId;
}

const seqs = (events: any[]): number[] => events.map((e) => e.seq);
const ended = (client: Client, id: string, count = 1): boolean => client.events.filter((e) => e.sessionId === id && e.event.type === "agent_end").length >= count;

describe("event delivery", () => {
  it("replays every missed event exactly once, in order, after a disconnect", async () => {
    const env = makeEnv();
    const { client } = await inProcess(env);
    const a = await client();
    const id = await createSession(a, env);
    await a.request({ type: "prompt", sessionId: id, message: "tool g1" });
    await waitFor("tool to start", () => gate(env, "g1").started());
    await waitFor("some events seen", () => a.events.length >= 3);
    const seenByA = [...a.events];
    a.close();

    // The turn finishes while nobody is connected.
    gate(env, "g1").release();
    await waitFor("tool finished", () => gate(env, "g1").finished());
    const b0 = await client();
    await waitFor("turn idle", async () => !(await b0.request({ type: "get_state", sessionId: id })).data.isStreaming);

    const lastSeen = seenByA.at(-1).seq;
    const b = await client();
    const subscribed = await b.request({ type: "subscribe", sessionId: id, sinceSeq: lastSeen });
    assert.equal(subscribed.success, true, JSON.stringify(subscribed));
    assert.equal(subscribed.data.truncated, false);
    await waitFor("replay to arrive", () => b.events.length === subscribed.data.replayed);
    assert.ok(b.events.length > 0);
    assert.ok(b.events.some((e) => e.event.type === "agent_end"));

    // A's events followed by B's replay are one contiguous run: nothing missed, nothing twice.
    const combined = [...seenByA, ...b.events];
    assert.deepEqual(seqs(combined), Array.from({ length: combined.length }, (_, i) => i + 1));
    assert.equal(combined.at(-1).seq, subscribed.data.lastSeq);

    // Live events continue the same numbering.
    await b.request({ type: "prompt", sessionId: id, message: "again" });
    await waitFor("second turn", () => ended(b, id));
    assert.deepEqual(seqs(b.events), Array.from({ length: b.events.length }, (_, i) => lastSeen + 1 + i));

    // The same replay from zero is what an uninterrupted subscriber saw.
    const full = await client();
    await full.request({ type: "subscribe", sessionId: id, sinceSeq: 0 });
    await waitFor("full replay", () => full.events.length >= combined.length);
    assert.deepEqual(full.events.slice(0, seenByA.length), seenByA);
  });

  it("gives two subscribers identical streams", async () => {
    const env = makeEnv();
    const { client } = await inProcess(env);
    const a = await client();
    const b = await client();
    const id = await createSession(a, env);
    await b.request({ type: "subscribe", sessionId: id, sinceSeq: 0 });
    await a.request({ type: "prompt", sessionId: id, message: "tool g2" });
    await waitFor("tool to start", () => gate(env, "g2").started());
    gate(env, "g2").release();
    await waitFor("both saw the end", () => ended(a, id) && ended(b, id));
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(a.events.length > 5);
    assert.deepEqual(b.events, a.events);
  });

  it("keeps seq counting across a daemon restart and stays bounded", async () => {
    const env = makeEnv();
    const options = { eventLog: { ringSize: 5, maxEvents: 20 } };
    const first = await inProcess(env, options);
    const a = await first.client();
    const id = await createSession(a, env);
    await a.request({ type: "prompt", sessionId: id, message: "turn 0" });
    await waitFor("turn 0", () => ended(a, id, 1));
    // Older than the 5-event ring but still on disk: replayed in full.
    assert.ok(a.events.length > 5 && a.events.length < 60);
    const disk = await first.client();
    const onDisk = await disk.request({ type: "subscribe", sessionId: id, sinceSeq: 1 });
    assert.equal(onDisk.data.truncated, false);
    await waitFor("disk replay", () => disk.events.length === onDisk.data.replayed);
    assert.deepEqual(seqs(disk.events), Array.from({ length: a.events.length - 1 }, (_, i) => i + 2));

    // Keep going until the on-disk bound trims the oldest events: the gap is reported, not hidden.
    for (let n = 1; n < 12; n++) {
      await a.request({ type: "prompt", sessionId: id, message: `turn ${n}` });
      await waitFor(`turn ${n}`, () => ended(a, id, n + 1));
    }
    const old = await first.client();
    const gap = await old.request({ type: "subscribe", sessionId: id, sinceSeq: 0 });
    assert.equal(gap.data.truncated, true);
    assert.ok(gap.data.firstSeq > 1);

    const lastSeq = a.events.at(-1).seq;
    await first.daemon.stop();
    const second = await inProcess(env, options);
    const c = await second.client();
    await c.request({ type: "open_session", sessionId: id });
    const resumed = await c.request({ type: "subscribe", sessionId: id, sinceSeq: lastSeq });
    assert.ok(resumed.data.lastSeq >= lastSeq, "seq must not restart at 1");
    await c.request({ type: "prompt", sessionId: id, message: "after restart" });
    await waitFor("turn after restart", () => ended(c, id));
    assert.deepEqual(seqs(c.events), Array.from({ length: c.events.length }, (_, i) => lastSeq + 1 + i));
  });
});

describe("controller lease and needs-input", () => {
  async function pendingDialogs(client: Client, id: string): Promise<any[]> {
    return (await client.request({ type: "get_state", sessionId: id })).data.needsInput;
  }

  it("lets only the lease holder answer a dialog, and frees the lease on disconnect", async () => {
    const env = makeEnv();
    const { client } = await inProcess(env);
    const a = await client();
    const b = await client();
    const id = await createSession(a, env);
    await a.request({ type: "prompt", sessionId: id, message: "ask name?" });
    const [dialog] = await waitFor("dialog", async () => {
      const list = await pendingDialogs(a, id);
      return list.length ? list : undefined;
    });
    // Subscribers see the dialog as a normal event.
    await waitFor("dialog event", () => a.events.some((e) => e.event.type === "extension_ui_request" && e.event.id === dialog.id));

    const noLease = await b.request({ type: "extension_ui_response", sessionId: id, requestId: dialog.id, value: "mallory" });
    assert.equal(noLease.success, false);
    assert.match(noLease.error, /controller/);

    assert.equal((await a.request({ type: "acquire_control", sessionId: id })).success, true);
    const second = await b.request({ type: "acquire_control", sessionId: id });
    assert.equal(second.success, false);
    assert.equal((await b.request({ type: "extension_ui_response", sessionId: id, requestId: dialog.id, value: "mallory" })).success, false);
    assert.equal((await pendingDialogs(a, id)).length, 1, "a refused answer must not resolve the dialog");
    const summary = (await a.request({ type: "list_sessions" })).data.sessions[0];
    assert.equal(summary.hasController, true);

    const answered = await a.request({ type: "extension_ui_response", sessionId: id, requestId: dialog.id, value: "alice" });
    assert.equal(answered.success, true, JSON.stringify(answered));
    await waitFor("turn to finish", () => ended(a, id));
    const { data } = await a.request({ type: "get_messages", sessionId: id });
    assert.ok(JSON.stringify(data.messages).includes("answer:alice"));
    assert.deepEqual(await pendingDialogs(a, id), []);
    assert.ok(a.events.some((e) => e.event.type === "extension_ui_resolved" && e.event.id === dialog.id && e.event.how === "answered"));

    // Lease ends with the connection.
    a.close();
    const acquired = await waitFor("lease freed", async () => {
      const r = await b.request({ type: "acquire_control", sessionId: id });
      return r.success ? r : undefined;
    });
    assert.equal(acquired.success, true);
    assert.equal((await b.request({ type: "release_control", sessionId: id })).success, true);
    assert.equal((await b.request({ type: "release_control", sessionId: id })).success, false);
  });

  it("holds a dialog as needs-input with nobody attached and resumes the turn through pi-remote answer", async () => {
    const env = makeEnv();
    const { client } = await inProcess(env);
    const a = await client();
    const id = await createSession(a, env);
    await a.request({ type: "prompt", sessionId: id, message: "ask which colour?" });
    await waitFor("dialog", async () => (await pendingDialogs(a, id)).length > 0);
    a.close();

    const b = await client();
    const listed = (await b.request({ type: "list_sessions" })).data.sessions[0];
    assert.equal(listed.hasController, false);
    assert.equal(listed.isStreaming, true);
    assert.equal(listed.needsInput.length, 1);
    assert.equal(listed.needsInput[0].title, "which colour?");
    b.close();

    const cli = join(import.meta.dirname, "..", "src", "remote-cli.ts");
    const base = [cli, "answer", id.slice(0, 8), "--socket", socketPathFor(env.serverDir)];
    // No answer flag: lists what is waiting and exits 0.
    assert.match((await run(process.execPath, base)).stdout, /pending .* input "which colour\?"/);
    const done = await run(process.execPath, [...base, "--value", "green"]);
    assert.match(done.stdout, /answered input "which colour\?"/);

    const c = await client();
    await waitFor("turn to finish", async () => !(await c.request({ type: "get_state", sessionId: id })).data.isStreaming);
    const { data } = await c.request({ type: "get_messages", sessionId: id });
    assert.ok(JSON.stringify(data.messages).includes("answer:green"));
    assert.deepEqual(await pendingDialogs(c, id), []);
    // The CLI gave its lease back.
    assert.equal((await c.request({ type: "acquire_control", sessionId: id })).success, true);
  });

  it("pi-remote answer resolves a session by name", async () => {
    const env = makeEnv();
    const { client } = await inProcess(env);
    const a = await client();
    const created = await a.request({ type: "create_session", name: "review", cwd: env.cwd, model: { provider: "fake", modelId: "fake-1" } });
    const id = created.sessionId;
    await a.request({ type: "prompt", sessionId: id, message: "ask which colour?" });
    await waitFor("dialog", async () => (await pendingDialogs(a, id)).length > 0);
    a.close();
    const cli = join(import.meta.dirname, "..", "src", "remote-cli.ts");
    const done = await run(process.execPath, [cli, "answer", "review", "--socket", socketPathFor(env.serverDir), "--value", "green"]);
    assert.match(done.stdout, /answered input "which colour\?"/);
  });

  it("pi-remote answer fails while another connection holds the lease", async () => {
    const env = makeEnv();
    const { client } = await inProcess(env);
    const a = await client();
    const id = await createSession(a, env);
    await a.request({ type: "prompt", sessionId: id, message: "ask held?" });
    await waitFor("dialog", async () => (await pendingDialogs(a, id)).length > 0);
    await a.request({ type: "acquire_control", sessionId: id });
    const cli = join(import.meta.dirname, "..", "src", "remote-cli.ts");
    await assert.rejects(run(process.execPath, [cli, "answer", id, "--socket", socketPathFor(env.serverDir), "--value", "x"]), (error: any) => error.code === 1 && /controller lease/.test(error.stderr));
    assert.equal((await pendingDialogs(a, id)).length, 1);
  });
});
