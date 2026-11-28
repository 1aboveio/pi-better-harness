import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {createServer, type Socket} from 'node:net';
import {mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import { claimDaemonOwner, inspectDaemonOwner } from '../src/daemon-owner.ts';
import { runtimeStatus, waitForRuntimeOwner } from '../src/runtime/client.ts';
import * as transport from '../src/runtime/work-client.mjs';

async function fixture(t: TestContext, handler: (socket: Socket, message: any) => void) {
 const root=mkdtempSync('/tmp/pi-connect-'), path=join(root,'pi-server.sock'), sockets=new Set<Socket>();
 const server=createServer(socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));let buffer='';socket.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\n')){const i=buffer.indexOf('\n'),m=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);handler(socket,m);}})});
 t.after(async()=>{for(const s of sockets)s.destroy();if(server.listening)await new Promise<void>(r=>server.close(()=>r()));rmSync(root,{recursive:true,force:true});});
 return {root,path,listen:()=>new Promise<void>(r=>server.listen(path,r))};
}
const reply=(s: Socket,m: any)=>s.write(JSON.stringify({id:m.id,success:true,data:{capabilities:[]}})+'\n');
test('a pending launch keeps its receipt while an ordinary read times out', async t => {
 const f = await fixture(t, (socket, message) => {
   if (message.type === 'hello') reply(socket, message);
   if (message.type === 'runtime_launch_subagent') {
     setTimeout(() => socket.write(JSON.stringify({id: message.id, success: true, data: {status: 'partial'}}) + '\n'), 5500);
   }
 });
 await f.listen();
 const client = new transport.WorkClient(f.path, f.root);
 try {
   await client.ready;
   const [receipt] = await Promise.all([
     client.request('runtime_launch_subagent'),
     assert.rejects(client.request('runtime_get_snapshot'), /timed out/),
   ]);
   assert.deepEqual(receipt, {status: 'partial'});
 } finally { client.close(); }
});

test('concurrent connects survive missing socket with one recovery and no command replay',async t=>{
 let recoveries=0,commands=0;
 const f=await fixture(t,(s,m)=>{if(m.type==='hello')reply(s,m);else{commands++;s.destroy();}});
 const recover=async()=>{recoveries++;await delay(80);await f.listen();};
 const clients=await Promise.all(Array.from({length:6},()=>transport.connectWorkClient(f.path,f.root,[],{recover,timeoutMs:1500})));
 assert.equal(recoveries,1);
 await assert.rejects(clients[0]!.request('runtime_launch_subagent'),/disconnected/);
 await delay(40);assert.equal(commands,1);
 clients.forEach(c=>c.close());
});
test('connection retries await listener without recovery and reject capability failures immediately',async t=>{
 let hellos=0;
 const f=await fixture(t,(s,m)=>{hellos++;s.write(JSON.stringify({id:m.id,success:false,error:'capability-mismatch: fixture'})+'\n')});
 const start=f.listen;
 const timer=setTimeout(()=>void start(),80);t.after(()=>clearTimeout(timer));
 await assert.rejects(transport.connectWorkClient(f.path,f.root,[],{timeoutMs:1000}),/capability-mismatch/);
 assert.equal(hellos,1);
});
test('unavailable connection has a bounded deadline and supports cancellation',async t=>{
 const f=await fixture(t,reply);
 await assert.rejects(transport.connectWorkClient(f.path,f.root,[],{timeoutMs:80}),/runtime-unavailable:.*reconnect/);
 const controller=new AbortController();
 const pending=transport.connectWorkClient(f.path,f.root,[],{signal:controller.signal,timeoutMs:2000});
 controller.abort();await assert.rejects(pending,{name:'AbortError'});
});

test('a shared recovery deadline refuses a live owner without reporting caller cancellation', async t => {
 const { root, path } = await fixture(t, reply);
 const release = claimDaemonOwner(root);
 const before = inspectDaemonOwner(root);
 assert.equal(before.status, 'live');
 let recoveries = 0;
 const recover = ({ signal }: { signal: AbortSignal }) => {
  recoveries++;
  // Let the transport budget expire while the installer would still wait for the owner.
  return waitForRuntimeOwner(root, () => runtimeStatus(path, root, {} as any), 3000, signal);
 };
 try {
  // The longer call can see the shared recovery's error after the shorter call expires.
  await Promise.all([
   assert.rejects(transport.connectWorkClient(path, root, [], { recover, timeoutMs: 1200 }), /reconnect deadline/),
   assert.rejects(transport.connectWorkClient(path, root, [], { recover, timeoutMs: 2500 }),
    /runtime-unavailable: reconnect deadline exceeded during recovery/),
  ]);
  assert.equal(recoveries, 1);
  assert.deepEqual(inspectDaemonOwner(root), before);
 } finally {
  release();
 }
});

test('a compatible replacement can connect after a pinned installer rejects its build', async t => {
 const f=await fixture(t,reply);
 const client=await transport.connectWorkClient(f.path,f.root,[],{timeoutMs:1500,recover:async()=>{
  await f.listen();throw new Error('capability-mismatch: pinned build differs');
 }});
 await client.ready;client.close();
});

test('cancelled waiter does not cancel a shared recovery needed by another caller',async t=>{
 const f=await fixture(t,reply);const controller=new AbortController();let count=0;
 let recovering!:()=>void;const entered=new Promise<void>(resolve=>{recovering=resolve});
 const recover=async()=>{count++;recovering();await delay(80);await f.listen();};
 const first=transport.connectWorkClient(f.path,f.root,[],{recover,signal:controller.signal,timeoutMs:1500});
 const rejected=assert.rejects(first,{name:'AbortError'});
 const second=transport.connectWorkClient(f.path,f.root,[],{recover,timeoutMs:1500});
 await entered;controller.abort();await rejected;
 const client=await second;assert.equal(count,1);client.close();
});

test('connection observes a replacement while owner recovery is still pending', async t => {
 const f=await fixture(t,reply);
 let recoverySignal: AbortSignal | undefined;
 let finish!:()=>void;
 const recoveryPending=new Promise<void>(resolve=>{finish=resolve});
 t.after(()=>finish());
 const client=await transport.connectWorkClient(f.path,f.root,[],{timeoutMs:1500,recover:async({signal})=>{
  recoverySignal=signal;await f.listen();await recoveryPending;
 }});
 assert.equal(client.closed,false);assert.equal(recoverySignal?.aborted,true);finish();client.close();
});

function registerAgent(t: TestContext, directory: string) {
  const root = realpathSync(directory);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  writeFileSync(join(root, 'server-registration-v1.json'), JSON.stringify({ version: 1, agentDir: root, serverDir: root }));
  return root;
}

test('Background client chooses the start token advertised by the daemon', async t => {
  const savedTZ = process.env.TZ;
  process.env.TZ = 'Asia/Shanghai';
  t.after(() => {
    if (savedTZ === undefined) delete process.env.TZ;
    else process.env.TZ = savedTZ;
  });
  const records: Array<{ version: number; start: string }> = [];
  let capabilities = ['runtime-background-execution-v1'];
  const f = await fixture(t, (socket, message) => {
    if (message.type === 'runtime_background_tool') {
      records.push(JSON.parse(readFileSync(join(f.root, 'background-tool-admission', message.authority.id + '.json'), 'utf8')));
    }
    const data = message.type === 'hello' ? { instanceId: 'test', capabilities } : { instanceId: 'test', seq: 1, status: 'ready', rows: [] };
    socket.write(JSON.stringify({ id: message.id, success: true, data }) + '\n');
  });
  await f.listen();
  const root = registerAgent(t, f.root);
  const load = (file: string) => import(new URL('../../pi-better-background-tasks/src/' + file, import.meta.url).href);
  const { requestBackgroundTool } = await load('managed-client.ts');
  const { closeBackgroundObservation } = await load('work-observation.ts');
  const { readAdmissionStartToken, readProcessStartTokenFresh } = await load('process-identity.ts');
  const pi = { events: new EventEmitter() };
  const ctx = { cwd: root, sessionManager: { getSessionId: () => 'native', getBranch: () => [] }, isProjectTrusted: () => true };
  try {
    await requestBackgroundTool(pi, ctx, 'legacy', '__background_poll', {});
    capabilities = [...capabilities, 'runtime-background-admission-v2'];
    await requestBackgroundTool(pi, ctx, 'updated', '__background_poll', {});
    assert.deepEqual(records.map(r => [r.version, r.start]), [
      [1, readProcessStartTokenFresh(process.pid)], [2, readAdmissionStartToken(process.pid)],
    ]);
  } finally { closeBackgroundObservation(pi); }
});
