import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { DaemonClient, HandshakeError, PROTOCOL_VERSION, startDaemon } from "../src/index.ts";
import { SERVER_VERSION } from "../src/handshake.ts";
import { Client, makeEnv, waitFor } from "./helpers.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function daemon() {
  const env = makeEnv();
  Object.assign(process.env, env.vars);
  const d = await startDaemon({ serverDir: env.serverDir });
  cleanups.push(() => d.stop());
  return d;
}

const [piMajor, piMinor] = PI_VERSION.split(".");

describe("hello handshake", () => {
  it("accepts a compatible client and reports protocol, pi and extension versions", async () => {
    const d = await daemon();
    const client = await DaemonClient.connect(d.socketPath);
    cleanups.push(() => client.close());
    assert.equal(client.server?.protocolVersion, PROTOCOL_VERSION);
    assert.equal(client.server?.piVersion, PI_VERSION);
    assert.equal(client.server?.extensionVersions["pi-better-server"], SERVER_VERSION);
    assert.deepEqual((await client.call({ type: "list_sessions" })).data, { sessions: [] });
  });

  it("accepts a different pi patch version on the same major.minor", async () => {
    const d = await daemon();
    const client = await DaemonClient.connect(d.socketPath, { hello: { piVersion: `${piMajor}.${piMinor}.999` } });
    cleanups.push(() => client.close());
    assert.equal(client.server?.protocolVersion, PROTOCOL_VERSION);
  });

  it("rejects a different protocol version with a clear error, then closes the connection", async () => {
    const d = await daemon();
    const raw = await Client.connect(d.socketPath);
    const response = await raw.request({ type: "hello", protocolVersion: PROTOCOL_VERSION + 1 });
    assert.equal(response.success, false);
    assert.match(response.error, new RegExp(`Protocol version mismatch: client speaks protocol ${PROTOCOL_VERSION + 1}, daemon speaks protocol ${PROTOCOL_VERSION}`));
    await waitFor("daemon to close the rejected connection", () => (raw as any).socket.destroyed);
    await assert.rejects(DaemonClient.connect(d.socketPath, { hello: { protocolVersion: 0 } }), (error: Error) => error instanceof HandshakeError && /Protocol version mismatch.*protocol 0.*protocol 1/.test(error.message));
  });

  it("rejects a different pi major.minor and names both versions", async () => {
    const d = await daemon();
    const other = `${piMajor}.${Number(piMinor) + 1}.0`;
    await assert.rejects(DaemonClient.connect(d.socketPath, { hello: { piVersion: other } }), (error: Error) => {
      assert.ok(error instanceof HandshakeError);
      assert.ok(error.message.includes(`client runs pi ${other}`) && error.message.includes(`daemon runs pi ${PI_VERSION}`), error.message);
      return true;
    });
  });

  it("rejects a malformed hello and leaves the daemon serving other clients", async () => {
    const d = await daemon();
    const raw = await Client.connect(d.socketPath);
    assert.match((await raw.request({ type: "hello" })).error, /integer protocolVersion/);
    const other = await DaemonClient.connect(d.socketPath);
    cleanups.push(() => other.close());
    assert.equal((await other.request({ type: "list_sessions" })).success, true);
  });

  it("still serves a client that never says hello", async () => {
    const d = await daemon();
    const raw = await Client.connect(d.socketPath);
    cleanups.push(() => raw.close());
    assert.equal((await raw.request({ type: "list_sessions" })).success, true);
  });

  it("keeps SERVER_VERSION equal to package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(SERVER_VERSION, pkg.version);
  });
});
