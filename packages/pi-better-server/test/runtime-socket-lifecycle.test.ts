import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Socket } from "node:net";
import { WorkClient } from "../src/runtime/work-client.mjs";

const fixtureURL = new URL("../../pi-better-background-tasks/src/test-support/work-runtime.ts", import.meta.url).href;
const { startWorkRuntime } = await import(fixtureURL);
const { backgroundObservation, closeBackgroundObservation } = await import(new URL("../../pi-better-background-tasks/src/work-observation.ts", import.meta.url).href);

test("an abandoned peer cannot leave late reply errors after owned fixture teardown", async () => {
  const script = `
    import {connect} from 'node:net'; import {once} from 'node:events'; import {readFileSync} from 'node:fs';
    const {startWorkRuntime}=await import(${JSON.stringify(fixtureURL)});
    const stop=await startWorkRuntime();
    const registration=JSON.parse(readFileSync(process.env.PI_CODING_AGENT_DIR+'/server-registration-v1.json','utf8'));
    try {
      for(let i=0;i<8;i++) {
        const peer=connect(registration.serverDir+'/pi-server.sock'); await once(peer,'connect');
        peer.write(Array.from({length:64},(_,id)=>JSON.stringify(id?{id,type:'runtime_subscribe',scope:{background:true,cwd:registration.agentDir,sessionId:'abandoned'}}:{id,type:'hello',protocolVersion:1})+'\\n').join(''));
        peer.destroy();
      }
    } finally {await stop()}
    await new Promise(r=>setImmediate(r));
    console.log('fixture-closed');
  `;
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: "pipe" });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr })); child.stdin.end();
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /fixture-closed/);
});

test("fixture shutdown rejects a queued request and preserves degraded client state", async () => {
  const stop = await startWorkRuntime();
  const root = process.env.PI_CODING_AGENT_DIR!;
  const registration = JSON.parse(readFileSync(join(root, "server-registration-v1.json"), "utf8"));
  const client = new WorkClient(join(registration.serverDir, "pi-server.sock"), root);
  try {
    await client.subscribe({ background: true, cwd: root, sessionId: "pending" });
    const transport = client as WorkClient & { socket: Socket; pending: Map<string, unknown> };
    // Keep this request in the real socket queue until shutdown, not racing a reply.
    transport.socket.cork();
    const pending = client.get({ background: true, cwd: root, sessionId: "pending" });
    await Promise.all([
      assert.rejects(pending, /disconnected|EPIPE|ECONNRESET/),
      (async () => {
        await Promise.resolve();
        assert.equal(transport.pending.size, 1, "the client must have registered the queued request");
        assert.ok(transport.socket.writableLength > 0, "the request must still be queued in the actual socket");
        await stop();
      })(),
    ]);
    assert.equal(client.snapshot!.status, "degraded");
  } finally { client.close(); await stop(); }
});

test("explicit Background shutdown does not reconnect an interrupted consumer query", async () => {
  const stop = await startWorkRuntime();
  const api = {};
  const ctx = { cwd: process.env.PI_CODING_AGENT_DIR!, sessionManager: { getSessionId: () => "closing" } };
  try {
    await backgroundObservation(api, ctx);
    const pending = backgroundObservation(api, ctx);
    const rejected = assert.rejects(pending, /client closed|disconnected/);
    closeBackgroundObservation(api);
    await rejected;
    assert.equal((await backgroundObservation(api, ctx)).status, "ready", "a later explicit session lifetime may connect normally");
  } finally { closeBackgroundObservation(api); await stop(); }
});

test("shutdown during connection initialization rejects without opening a replacement", async () => {
  const stop = await startWorkRuntime();
  const api = {};
  const ctx = { cwd: process.env.PI_CODING_AGENT_DIR!, sessionManager: { getSessionId: () => "initializing" } };
  try {
    const pending = backgroundObservation(api, ctx);
    const rejected = assert.rejects(pending, /client closed/);
    closeBackgroundObservation(api);
    await rejected;
  } finally { closeBackgroundObservation(api); await stop(); }
});
