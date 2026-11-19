import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {createServer, type Socket} from 'node:net';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import * as transport from '../src/runtime/work-client.mjs';

async function fixture(t: TestContext, handler: (socket: Socket, message: any) => void) {
 const root=mkdtempSync('/tmp/pi-connect-'), path=join(root,'pi-server.sock'), sockets=new Set<Socket>();
 const server=createServer(socket=>{sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));let buffer='';socket.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\n')){const i=buffer.indexOf('\n'),m=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);handler(socket,m);}})});
 t.after(async()=>{for(const s of sockets)s.destroy();if(server.listening)await new Promise<void>(r=>server.close(()=>r()));rmSync(root,{recursive:true,force:true});});
 return {root,path,listen:()=>new Promise<void>(r=>server.listen(path,r))};
}
const reply=(s: Socket,m: any)=>s.write(JSON.stringify({id:m.id,success:true,data:{capabilities:[]}})+'\n');
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

test('an expired shared recovery reports a reconnect deadline to a later waiter', async t => {
 const f = await fixture(t, reply);
 let entered!: () => void;
 const recovering = new Promise<void>(resolve => { entered = resolve; });
 const recover = async ({ signal }: { signal: AbortSignal }) => {
  entered();
  await delay(5000, undefined, { signal });
 };
 const first = assert.rejects(transport.connectWorkClient(f.path, f.root, [], { timeoutMs: 950, recover }), /reconnect deadline/);
 void first.catch(() => {});
 await recovering;
 await assert.rejects(transport.connectWorkClient(f.path, f.root, [], { timeoutMs: 2500, recover }), /reconnect deadline/);
 await first;
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
