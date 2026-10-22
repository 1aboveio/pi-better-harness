import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DAEMON_COMMANDS, type SessionSummary } from "../src/protocol.ts";
import { startDaemon, type Daemon } from "../src/server.ts";
import { Client, gate, llmCalls, makeEnv, waitFor, type Env } from "./helpers.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function connect(env: Env): Promise<{ daemon: Daemon; client: Client }> {
  Object.assign(process.env, env.vars);
  const daemon = await startDaemon({ serverDir: env.serverDir });
  cleanups.push(() => daemon.stop());
  const client = await Client.connect(daemon.socketPath);
  cleanups.push(() => client.close());
  return { daemon, client };
}

async function create(client: Client, env: Env): Promise<SessionSummary> {
  const response = await client.request({ type: "create_session", cwd: env.cwd, name: "Original", model: { provider: "fake", modelId: "fake-1" } });
  assert.equal(response.success, true, JSON.stringify(response));
  return response.data;
}

async function listed(client: Client, sessionId: string): Promise<SessionSummary> {
  const response = await client.request({ type: "list_sessions" });
  return response.data.sessions.find((session: SessionSummary) => session.sessionId === sessionId);
}

async function prompt(client: Client, sessionId: string): Promise<void> {
  const response = await client.request({ type: "prompt", sessionId, message: "remember" });
  assert.equal(response.success, true, JSON.stringify(response));
  await waitFor("completed turn", async () => {
    const state = await client.request({ type: "get_state", sessionId });
    const messages = await client.request({ type: "get_messages", sessionId });
    return state.success && !state.data.isStreaming && messages.data.messages.some((message: { role: string }) => message.role === "assistant");
  });
}

describe("daemon session rename", () => {
  it("an unhandled daemon command cannot fall through to closing a session", async () => {
    const env = makeEnv();
    const { client } = await connect(env);
    const { sessionId } = await create(client, env);
    const commands = DAEMON_COMMANDS as Set<string>;
    commands.add("unhandled_test_command");
    try {
      const result = await client.request({ type: "unhandled_test_command", sessionId });
      assert.equal(result.success, false);
      assert.match(result.error, /Unknown daemon command/);
      const after = await listed(client, sessionId);
      assert.equal(after.status, "running");
      assert.equal(after.live, true);
    } finally { commands.delete("unhandled_test_command"); }
  });

  it("renames a persisted closed session without loading extensions, hosting it, or running a model", async () => {
    const env = makeEnv();
    const lifecycleFile = join(env.root, "lifecycle.log");
    writeFileSync(lifecycleFile, "");
    writeFileSync(join(env.agentDir, "extensions", "lifecycle.ts"), `
import { appendFileSync } from "node:fs";
export default function (pi) {
  appendFileSync(${JSON.stringify(lifecycleFile)}, "loaded\\n");
  pi.on("session_start", () => { appendFileSync(${JSON.stringify(lifecycleFile)}, "started\\n"); });
  pi.on("session_shutdown", () => { appendFileSync(${JSON.stringify(lifecycleFile)}, "stopped\\n"); });
}
`);
    const { daemon, client } = await connect(env);
    const { sessionId, sessionFile } = await create(client, env);
    await prompt(client, sessionId);
    const messages = (await client.request({ type: "get_messages", sessionId })).data.messages;
    assert.equal((await client.request({ type: "close_session", sessionId })).success, true);
    const lifecycle = readFileSync(lifecycleFile, "utf8");
    assert.match(lifecycle, /loaded\nstarted\n/);
    const history = SessionManager.open(sessionFile).getEntries();
    const calls = llmCalls(env).length;
    assert.equal(calls, 1);

    const renamed = await client.request({ type: "rename_session", sessionId, name: "  Closed title  " });
    assert.equal(renamed.success, true, JSON.stringify(renamed));
    assert.equal(renamed.command, "rename_session");
    assert.equal(renamed.sessionId, sessionId);
    assert.equal(renamed.data.name, "Closed title");
    assert.equal(renamed.data.live, false);
    assert.equal(renamed.data.status, "closed");
    assert.equal(daemon.registry.get(sessionId), undefined);
    assert.deepEqual(await listed(client, sessionId), renamed.data);
    assert.equal((await client.request({ type: "get_state", sessionId })).success, false);
    assert.equal(readFileSync(lifecycleFile, "utf8"), lifecycle);
    assert.equal(llmCalls(env).length, calls);
    const saved = SessionManager.open(sessionFile);
    assert.equal(saved.getSessionName(), "Closed title");
    assert.deepEqual(saved.getEntries().slice(0, -1), history);
    assert.equal(saved.getEntries().at(-1)?.type, "session_info");

    await daemon.stop();
    const restarted = await connect(env);
    const closed = await listed(restarted.client, sessionId);
    assert.equal(closed.name, "Closed title");
    assert.equal(closed.live, false);
    assert.equal(closed.status, "closed");
    assert.equal(readFileSync(lifecycleFile, "utf8"), lifecycle);
    const opened = await restarted.client.request({ type: "open_session", sessionId });
    assert.equal(opened.success, true, JSON.stringify(opened));
    assert.equal(opened.data.name, "Closed title");
    assert.equal((await restarted.client.request({ type: "get_state", sessionId })).data.sessionName, "Closed title");
    assert.deepEqual((await restarted.client.request({ type: "get_messages", sessionId })).data.messages, messages);
    assert.equal(llmCalls(env).length, calls);
  });

  for (const status of ["running", "closed"] as const) {
    it(`preserves an empty ${status} session's rename through restart, reopen, and its first persisted turn`, async () => {
      const env = makeEnv();
      const { daemon, client } = await connect(env);
      const { sessionId, sessionFile } = await create(client, env);
      assert.equal(existsSync(sessionFile), false);
      if (status === "closed") assert.equal((await client.request({ type: "close_session", sessionId })).success, true);
      const renamed = await client.request({ type: "rename_session", sessionId, name: "Empty title" });
      assert.equal(renamed.success, true, JSON.stringify(renamed));
      assert.equal(renamed.data.status, status);
      assert.equal(renamed.data.live, status === "running");
      assert.equal(renamed.data.name, "Empty title");
      assert.equal(existsSync(sessionFile), false);
      assert.equal(llmCalls(env).length, 0);
      await daemon.stop();

      const restarted = await connect(env);
      const summary = await listed(restarted.client, sessionId);
      assert.equal(summary.name, "Empty title");
      assert.equal(summary.status, status);
      assert.equal(summary.live, status === "running");
      const opened = await restarted.client.request({ type: "open_session", sessionId });
      assert.equal(opened.success, true, JSON.stringify(opened));
      assert.equal(opened.data.name, "Empty title");
      assert.equal((await restarted.client.request({ type: "get_state", sessionId })).data.sessionName, "Empty title");
      assert.equal(existsSync(opened.data.sessionFile), false);
      await prompt(restarted.client, sessionId);
      assert.equal(SessionManager.open(opened.data.sessionFile).getSessionName(), "Empty title");
      assert.equal((await restarted.client.request({ type: "close_session", sessionId })).success, true);
      const reopened = await restarted.client.request({ type: "open_session", sessionId });
      assert.equal(reopened.data.name, "Empty title");
      assert.equal(llmCalls(env).length, 1);
    });
  }

  it("renames an active turn without closing it, dropping control, or unsubscribing its client", async () => {
    const env = makeEnv();
    const { client } = await connect(env);
    const { sessionId } = await create(client, env);
    assert.equal((await client.request({ type: "acquire_control", sessionId })).success, true);
    assert.equal((await client.request({ type: "prompt", sessionId, message: "tool rename" })).success, true);
    await waitFor("tool started", () => gate(env, "rename").started());
    const renamed = await client.request({ type: "rename_session", sessionId, name: "  Active title  " });
    assert.equal(renamed.success, true, JSON.stringify(renamed));
    assert.equal(renamed.data.name, "Active title");
    assert.equal(renamed.data.status, "running");
    assert.equal(renamed.data.live, true);
    assert.equal(renamed.data.isStreaming, true);
    assert.equal(renamed.data.hasController, true);
    assert.equal((await client.request({ type: "get_state", sessionId })).data.sessionName, "Active title");
    assert.equal(llmCalls(env).length, 1);
    gate(env, "rename").release();
    await waitFor("turn finished and subscription retained", () => client.events.some((event) => event.sessionId === sessionId && event.event.type === "agent_end"));
    assert.equal((await client.request({ type: "close_session", sessionId })).success, true);
    const reopened = await client.request({ type: "open_session", sessionId });
    assert.equal(reopened.success, true, JSON.stringify(reopened));
    assert.equal(reopened.data.name, "Active title");
  });

  it("rejects unknown sessions, missing ids, and empty or non-string names without writes", async () => {
    const env = makeEnv();
    const { daemon, client } = await connect(env);
    const { sessionId, sessionFile } = await create(client, env);
    await prompt(client, sessionId);
    const indexFile = join(env.serverDir, "sessions.json");
    const index = readFileSync(indexFile, "utf8");
    const transcript = readFileSync(sessionFile, "utf8");
    const hosted = daemon.registry.get(sessionId);
    for (const [command, error] of [
      [{ sessionId: "unknown", name: "Title" }, /Unknown session: unknown/],
      [{ name: "Title" }, /sessionId is required/],
      ...["", " \t\r\n ", undefined, null, 42].map((name) => [{ sessionId, name }, /name.*non-empty/i]),
    ] as Array<[Record<string, unknown>, RegExp]>) {
      const response = await client.request({ type: "rename_session", ...command });
      assert.equal(response.success, false, JSON.stringify(response));
      assert.match(response.error, error);
    }
    assert.equal(readFileSync(indexFile, "utf8"), index);
    assert.equal(readFileSync(sessionFile, "utf8"), transcript);
    assert.equal(daemon.registry.get(sessionId), hosted);
    assert.equal((await listed(client, sessionId)).name, "Original");
  });

  for (const ownership of ["fenced", "moved"] as const) {
    for (const status of ["running", "closed"] as const) {
      it(`refuses ${ownership} ownership before writing a ${status} session`, async () => {
        const env = makeEnv();
        const { daemon, client } = await connect(env);
        const { sessionId, sessionFile } = await create(client, env);
        await prompt(client, sessionId);
        if (status === "closed") assert.equal((await client.request({ type: "close_session", sessionId })).success, true);
        daemon.registry.ownership.fence(sessionId, "rename-move");
        if (ownership === "moved") daemon.registry.ownership.retire(sessionId, "rename-move", "other-daemon");
        const indexFile = join(env.serverDir, "sessions.json");
        const index = readFileSync(indexFile, "utf8");
        const transcript = readFileSync(sessionFile, "utf8");
        const before = await listed(client, sessionId);
        const response = await client.request({ type: "rename_session", sessionId, name: "Forbidden" });
        assert.equal(response.success, false, JSON.stringify(response));
        assert.match(response.error, ownership === "fenced" ? /fenced for a move/ : /moved to another daemon/);
        await assert.rejects(daemon.registry.rename(sessionId, "Also forbidden"), ownership === "fenced" ? /fenced for a move/ : /moved to another daemon/);
        assert.equal(readFileSync(indexFile, "utf8"), index);
        assert.equal(readFileSync(sessionFile, "utf8"), transcript);
        assert.deepEqual(await listed(client, sessionId), before);
        assert.equal(llmCalls(env).length, 1);
      });
    }
  }

  it("serializes rename with in-flight open and close operations", async () => {
    const env = makeEnv();
    const { daemon, client } = await connect(env);
    const { sessionId } = await create(client, env);
    assert.equal((await client.request({ type: "close_session", sessionId })).success, true);
    const [opened, renamed, closed, renamedClosed] = await Promise.all([
      daemon.registry.open(sessionId),
      daemon.registry.rename(sessionId, "During open"),
      daemon.registry.close(sessionId),
      daemon.registry.rename(sessionId, "After close"),
    ]);
    assert.equal(opened.live, true);
    assert.equal(renamed.name, "During open");
    assert.equal(renamed.live, true);
    assert.equal(closed, undefined);
    assert.equal(renamedClosed.name, "After close");
    assert.equal(renamedClosed.status, "closed");
    assert.equal(renamedClosed.live, false);
    const reopened = await client.request({ type: "open_session", sessionId });
    assert.equal(reopened.success, true, JSON.stringify(reopened));
    assert.equal((await client.request({ type: "get_state", sessionId })).data.sessionName, "After close");
    assert.equal(llmCalls(env).length, 0);
  });
});
