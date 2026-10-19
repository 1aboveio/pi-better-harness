import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { DaemonClient } from "../src/client.ts";
import { startDaemon, type DaemonOptions } from "../src/index.ts";
import { cursorKey, readCursor, writeCursor } from "../src/remote/cursors.ts";
import type { RemoteContext } from "../src/remote/context.ts";
import { createTailCommand, subscribeSince } from "../src/remote/tail.ts";
import { Client, makeEnv, waitFor, type Env } from "./helpers.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(env: Env, options: Partial<DaemonOptions> = {}) {
  Object.assign(process.env, env.vars);
  process.env.PI_REMOTE_STATE_DIR = mkdtempSync(join(tmpdir(), "tail-state-"));
  const daemon = await startDaemon({ serverDir: env.serverDir, ...options });
  cleanups.push(() => daemon.stop());
  const driver = await Client.connect(daemon.socketPath);
  cleanups.push(() => driver.close());
  const created = await driver.request({ type: "create_session", cwd: env.cwd, model: { provider: "fake", modelId: "fake-1" } });
  assert.equal(created.success, true, JSON.stringify(created));
  const sessionId: string = created.sessionId;
  const turn = async (message: string) => {
    const before = driver.events.filter((e) => e.event?.type === "agent_end").length;
    await driver.request({ type: "prompt", sessionId, message });
    await waitFor(`turn "${message}"`, () => driver.events.filter((e) => e.event?.type === "agent_end").length > before);
  };
  return { daemon, driver, sessionId, turn };
}

/** Run `tail` for a session until `until(stdout)` holds, then interrupt it like Ctrl-C would. */
async function tailUntil(socketPath: string, sessionId: string, until: (stdout: string) => boolean) {
  const client = await DaemonClient.connect(socketPath);
  cleanups.push(() => client.close());
  const abort = new AbortController();
  let stdout = "";
  let stderr = "";
  const context: RemoteContext = {
    host: undefined,
    json: false,
    signal: abort.signal,
    connect: async () => client,
    forwardSocket: async () => {
      throw new Error("unused");
    },
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    close: async () => undefined,
  };
  const done = createTailCommand(subscribeSince).run({ values: {}, positionals: [sessionId] }, context);
  await waitFor("tail output", () => until(stdout));
  abort.abort();
  assert.equal(await done, 0);
  return { stdout, stderr };
}

describe("tail catch-up", () => {
  it("resumes from the saved cursor: replays what was missed once, and saves the new cursor", async () => {
    const env = makeEnv();
    const { daemon, driver, sessionId, turn } = await setup(env);
    await driver.request({ type: "subscribe", sessionId });
    await turn("first");
    const seen = driver.events.filter((e) => e.sessionId === sessionId);
    const cursor = [...seen].reverse().find((e) => e.event.type === "agent_end")!.seq;
    await turn("second");
    const last = driver.events.at(-1)!.seq;
    writeCursor(cursorKey(undefined, sessionId), cursor);

    const { stdout, stderr } = await tailUntil(daemon.socketPath, sessionId, (out) => out.includes("echo:second"));
    assert.ok(!stdout.includes("echo:first"), "events before the cursor are not replayed");
    assert.equal(stdout.split("echo:second").length, 2, "the missed turn prints once");
    assert.equal(stderr, "");
    assert.equal(readCursor(cursorKey(undefined, sessionId)), last);
  });

  it("says so when events after the saved cursor are no longer retained", async () => {
    const env = makeEnv();
    const { daemon, driver, sessionId, turn } = await setup(env, { eventLog: { ringSize: 5, maxEvents: 20 } });
    await driver.request({ type: "subscribe", sessionId });
    for (let n = 0; n < 8; n++) await turn(`turn ${n}`);
    writeCursor(cursorKey(undefined, sessionId), 1);

    const { stderr } = await tailUntil(daemon.socketPath, sessionId, (out) => out.includes("turn ended"));
    assert.match(stderr, /no longer retained/);
  });
});
