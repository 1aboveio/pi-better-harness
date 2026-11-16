import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { WorkClient } from '../src/runtime/work-client.mjs';

// A duplex peer keeps the exact client framing and request deadlines while
// controlling when the replacement worker can accept subscriptions.
function fixture() {
  const socket: any = new PassThrough();
  const requests: any[] = [];
  socket.write = (line: string) => { requests.push(JSON.parse(line)); return true; };
  const client = new WorkClient(socket, '/agent');
  const reply = (request: any, data: any, error?: string) => socket.emit('data', JSON.stringify({id:request.id,success:!error,data,error})+'\n');
  reply(requests[0], {});
  const event = () => socket.emit('data', JSON.stringify({type:'event',event:{type:'resync_required',reason:'read-worker-recovered'}})+'\n');
  return {client, requests, reply, event};
}
async function until(predicate: () => boolean) {
  const deadline = Date.now()+3000;
  while (!predicate()) { assert.ok(Date.now()<deadline, 'client did not retry recovery'); await new Promise(r=>setTimeout(r,10)); }
}
const snapshot = (epoch: string) => ({instanceId:epoch,seq:1,status:'ready',rows:[]});

test('client retries a replacement subscription after a startup deadline', async () => {
  const f=fixture();
  try {
    const initial=f.client.subscribe({cwd:'/project'});
    await until(()=>f.requests.length>=2);f.reply(f.requests[1],snapshot('old'));await initial;
    f.event(); await until(()=>f.requests.length>=3);
    f.reply(f.requests[2],undefined,'runtime-overloaded: queued read deadline exceeded; retry later');
    await until(()=>f.requests.length>=4);
    assert.deepEqual(f.requests[3].scope,{cwd:'/project'});
    f.reply(f.requests[3],snapshot('new'));
    await until(()=>f.client.snapshot?.instanceId==='new');
    assert.equal(f.client.snapshot?.status,'ready');
  } finally {f.client.close();}
});

test('closing cancels a pending recovery retry', async () => {
  const f=fixture();await f.client.ready;
  f.event();await until(()=>f.requests.length>=2);
  f.reply(f.requests[1],undefined,'runtime-timeout: caller read deadline exceeded');
  await new Promise(r=>setTimeout(r,10));f.client.close();
  const count=f.requests.length;await new Promise(r=>setTimeout(r,300));assert.equal(f.requests.length,count);
});

test('recovery coalesces events and cannot overwrite a newer subscription', async () => {
  const f=fixture();await f.client.ready;
  try {
    f.event();f.event();await until(()=>f.requests.length>=2);
    const old=f.requests[1];
    const changed=f.client.subscribe({cwd:'/new'});
    await until(()=>f.requests.length>=3);f.reply(f.requests[2],snapshot('new'));await changed;
    f.reply(old,snapshot('old'));
    await new Promise(r=>setTimeout(r,200));
    assert.equal(f.client.snapshot?.instanceId,'new');assert.equal(f.requests.length,3);
  } finally {f.client.close();}
});

test('permanent subscription errors do not create a retry loop', async () => {
  const f=fixture();await f.client.ready;
  try {
    f.event();await until(()=>f.requests.length>=2);
    f.reply(f.requests[1],undefined,'Invalid scope');
    await new Promise(r=>setTimeout(r,300));assert.equal(f.requests.length,2);
  } finally {f.client.close();}
});

test('exact-ID reads retry rebuilding while unrelated reads complete', async () => {
  const f=fixture();await f.client.ready;
  try {
    let completed=false;
    const pending=f.client.get({id:'sa_indexing'}).then(value=>{completed=true;return value;});
    await until(()=>f.requests.length>=2);
    f.reply(f.requests[1],{...snapshot('new'),status:'rebuilding'});
    const other=f.client.get({limit:2});
    await until(()=>f.requests.length>=3);f.reply(f.requests[2],snapshot('new'));await other;
    assert.equal(completed,false);
    await until(()=>f.requests.length>=4);
    assert.equal(f.requests[3].scope.id,'sa_indexing');
    f.reply(f.requests[3],{...snapshot('new'),rows:[{meta:{id:'sa_indexing'}}]});
    assert.equal((await pending).rows[0]?.meta.id,'sa_indexing');
  } finally {f.client.close();}
});
