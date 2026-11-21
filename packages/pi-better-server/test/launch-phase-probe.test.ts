import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parkPhaseTrace } from "./support/park-phase-trace.ts";
const probe = new URL("./support/launch-phase-probe.mjs", import.meta.url).href;
const clientModule = new URL("../../pi-better-subagents/shared-work-client.mjs", import.meta.url).href;
const { launchFixtureRequest } = await import(probe);

for (const failed of [false, true]) test(`launch phase receipts preserve real IPC reply and failure attribution: ${failed}`, { timeout: 10000 }, async t => {
  const root = mkdtempSync("/tmp/launch-phases-");
  const socketPath = join(root, "fixture.sock");
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", data => {
      buffer += data;
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n"), request = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        socket.write(JSON.stringify({ id: request.id, success: !(failed && request.type === "runtime_launch_subagent"),
          error: "component rejection", data: { receipt: "wire-reply" } }) + "\n");
      }
    });
  });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); });
  await new Promise<void>(resolve => server.listen(socketPath, resolve));
  // This component child runs the real client and shell, never an SDK or daemon.
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { spawn } from 'node:child_process';
    import { once } from 'node:events';
    import { WorkClient } from ${JSON.stringify(clientModule)};
    import { observeLaunchPhases } from ${JSON.stringify(probe)};
    process.send({ready:true});
    process.once('message', async request => {
      const original = WorkClient.prototype.request;
      const originalSpawn = spawn;
      const stop = observeLaunchPhases(message => process.send(message));
      const client = new WorkClient(request.socketPath, 'private-root');
      let result, error;
      try {
        await client.ready;
        await once(spawn('/bin/sh', ['-c', 'exit 0']), 'close');
        await client.request('runtime_bind_catalog_host', { secret: request.secret });
        await client.request('runtime_register_catalog');
        result = await client.request('runtime_launch_subagent', { secret: request.secret });
        for (let i=0; i<35; i++) await client.request('hello');
      } catch (cause) { error = String(cause); }
      finally { client.close(); stop(error ? 'failed' : 'finished'); }
      process.send({result, error, restored: WorkClient.prototype.request === original && spawn === originalSpawn});
      process.disconnect();
    });
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const exited = once(child, "exit");
  t.after(async () => { if (child.exitCode === null) child.kill(); await exited; });
  await once(child, "message");
  const controller = new AbortController(), records: any[] = [], receipts: any[] = [];
  const trace = parkPhaseTrace(controller.signal, record => records.push(record));
  t.after(() => trace.close());
  const reply = await launchFixtureRequest(child, { socketPath, secret: "DO_NOT_RECORD" }, {
    launchPhase(receipt: unknown) { receipts.push(receipt); trace.launchPhase(receipt as any); },
  });
  assert.equal(reply.restored, true);
  if (failed) assert.match(reply.error, /component rejection/);
  else assert.equal(reply.result.receipt, "wire-reply");
  assert.equal(records.length, 0, "success transport stays silent until the original failure reporter runs");
  controller.abort();
  const phases = records[0].parkPhaseFailure.launchPhases;
  assert.equal(phases[0].state, failed ? "failed" : "finished");
  assert.equal(phases.find((phase: any) => phase.phase === "launch-bridge").state, failed ? "failed" : "finished");
  for (const name of ["hello", "provision-shell", "catalog-binding", "catalog-registration"])
    assert.equal(phases.find((phase: any) => phase.phase === name).state, "finished");
  for (const phase of phases) assert.ok(phase.sdkEndedMs >= phase.sdkStartedMs);
  assert.ok(receipts.length <= 64);
  if (!failed) { assert.equal(phases.length, 32); assert.equal(receipts.length, 64); }
  assert.equal(JSON.stringify(receipts).includes("DO_NOT_RECORD"), false);
  assert.equal(JSON.stringify(receipts).includes(socketPath), false);
  assert.equal(child.listenerCount("message"), 0, "reply transport releases its listener");
  assert.equal((await exited)[0], 0);
});

test("launch reply rejects an exited fixture rather than accepting a phase as its receipt", { timeout: 5000 }, async () => {
  const child = spawn(process.execPath, ["-e", `process.once('message', () => { process.send({launchPhase:{index:0,phase:'tool-execute',state:'started',elapsedMs:0}}); process.disconnect(); });`], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const receipts: any[] = [];
  await assert.rejects(launchFixtureRequest(child, {}, { launchPhase(value: unknown) { receipts.push(value); } }), /exited before launch receipt/);
  assert.equal(receipts.length, 1);
  assert.equal(child.listenerCount("message"), 0);
});
