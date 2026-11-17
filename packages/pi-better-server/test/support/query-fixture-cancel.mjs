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
      rootRemoved: !existsSync(f.root), mode, peerErrors: f.peerErrors, peerActivity: f.peerActivity }));
  });
  if (mode !== "bootstrap-held") {
    await f.worker.terminate();
    let deferred;
    if (!mode?.startsWith("unannounced-")) {
      deferred = assert.rejects(client.request("fixture_defer_reply"), /client closed/);
      await client.request("fixture_close");
    }
    client.close();
    await deferred;
    if (mode === "already-ended") assert.ok(f.peerActivity.lateRepliesSkipped >= 1, "closure must suppress queued replies");
    // Exercise the external transport error boundary after this exact peer closes.
    const codes = mode === "already-ended" ? ["ECONNRESET", "EPIPE"] : [mode === "unexpected-error" ? "EIO" : mode === "unannounced-pipe" ? "EPIPE" : "ECONNRESET"];
    for (const code of codes) peer.emit("error", Object.assign(new Error(`fixture peer ${code}`), { code }));
  }
  // Cancellation must run the fixture's hook even though this body never unwinds.
  await new Promise(() => {});
});
