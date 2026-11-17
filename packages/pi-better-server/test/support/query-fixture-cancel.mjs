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
  if (process.env.PI_QUERY_FIXTURE_CANCEL_MODE === "already-ended") {
    await f.worker.terminate();
    client.close();
  }
  t.after(() => {
    t.diagnostic(JSON.stringify({ workerStopped: f.worker.threadId === -1,
      clientDestroyed: client.socket.destroyed, transportRemoved: !existsSync(dirname(f.path)),
      rootRemoved: !existsSync(f.root) }));
  });
  // Cancellation must run the fixture's hook even though this body never unwinds.
  await new Promise(() => {});
});
