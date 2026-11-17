import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fixture } from "./query-fixture.ts";

assert.ok(Number(process.versions.node.split(".")[0]) >= 24, "Cancellation control requires private Node 24");

test("cancelled query fixture releases its owned resources", { timeout: 1000 }, async t => {
  const f = await fixture({ workerUrl: new URL(`data:text/javascript,${encodeURIComponent(`
    import { parentPort } from "node:worker_threads";
    parentPort.on("message", () => {});
  `)}`) });
  const client = await f.client();
  const mode = process.env.PI_QUERY_FIXTURE_CANCEL_MODE;
  assert.equal(f.sockets.size, 1, "this child owns exactly one accepted peer");
  const [peer] = f.sockets;
  t.after(() => {
    t.diagnostic(JSON.stringify({ workerStopped: f.worker.threadId === -1,
      clientDestroyed: client.socket.destroyed, transportRemoved: !existsSync(dirname(f.path)),
      rootRemoved: !existsSync(f.root), mode, peerErrors: f.peerErrors }));
  });
  if (mode !== "bootstrap-held") {
    await f.worker.terminate();
    if (mode !== "unannounced-reset") await client.request("fixture_close");
    client.close();
    // Exercise the external transport error boundary after this exact peer closes.
    const code = mode === "unexpected-error" ? "EIO" : "ECONNRESET";
    peer.emit("error", Object.assign(new Error(`fixture peer ${code}`), { code }));
  }
  // Cancellation must run the fixture's hook even though this body never unwinds.
  await new Promise(() => {});
});
