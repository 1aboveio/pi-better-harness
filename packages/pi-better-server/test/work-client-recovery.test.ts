import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { WorkClient } from '../src/runtime/work-client.mjs';

// A duplex peer keeps the exact client framing and request deadlines while
// controlling when the replacement worker can accept subscriptions.
function fixture(Client = WorkClient) {
  const socket: any = new PassThrough();
  const requests: any[] = [];
  socket.write = (line: string) => { requests.push(JSON.parse(line)); return true; };
  const client = new Client(socket, '/agent');
  const reply = (request: any, data: any, error?: string) => socket.emit('data', JSON.stringify({id:request.id,success:!error,data,error})+'\n');
  reply(requests[0], {});
  const event = () => socket.emit('data', JSON.stringify({type:'event',event:{type:'resync_required',reason:'read-worker-recovered'}})+'\n');
  const disconnect = () => socket.emit('close');
  const publish = (value: any) => socket.emit('data', JSON.stringify({type:'event',event:{type:'runtime_snapshot',snapshot:value}})+'\n');
  return {client, requests, reply, event, disconnect, publish};
}
async function until(predicate: () => boolean) {
  const deadline = Date.now()+3000;
  while (!predicate()) { assert.ok(Date.now()<deadline, 'client did not retry recovery'); await new Promise(r=>setTimeout(r,10)); }
}
const snapshot = (epoch: string) => ({instanceId:epoch,seq:1,status:'ready',rows:[]});

test('global sequence gaps between full scoped snapshots do not synthesize degraded frames', async () => {
  const f = fixture(); await f.client.ready;
  try {
    f.publish({ ...snapshot('same'), seq: 2, scopeRevision: 'scope-before' });
    const seen: any[] = [];
    f.client.onChange(value => seen.push(value));
    f.publish({ ...snapshot('same'), seq: 7, scopeRevision: 'scope-after' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].status, 'ready');
    assert.equal(seen[0].resyncRequired, undefined);
    f.publish({ ...snapshot('same'), seq: 6, scopeRevision: 'stale' });
    assert.equal(seen.length, 1, 'older observations still fail the sequence fence');
    f.publish(snapshot('replacement'));
    assert.equal(seen[1].status, 'degraded', 'runtime replacement still requires resync');
    assert.equal(seen[2].resyncReason, 'instance-changed');
  } finally { f.client.close(); }
});

for (const [name, path] of Object.entries({ canonical: '../src/runtime/work-client.mjs',
  subagent: '../../pi-better-subagents/shared-work-client.mjs', background: '../../pi-better-background-tasks/src/shared-work-client.mjs',
  embeddedSubagent: '../src/runtime/domain/subagents/shared-work-client.mjs', embeddedBackground: '../src/runtime/domain/background-service/shared-work-client.mjs' })) {
test(`${name} client retries a replacement subscription after a startup deadline`, async () => {
  const { WorkClient: Client }: { WorkClient: typeof WorkClient } = await import(path);
  const f=fixture(Client);
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
}

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

test('an interrupted read rejects instead of turning a cached empty snapshot into verified activity', async () => {
  const f=fixture();await f.client.ready;
  try {
    const initial=f.client.subscribe({background:true,cwd:'/project'});
    await until(()=>f.requests.length>=2);f.reply(f.requests[1],snapshot('old'));await initial;
    const pending=f.client.get({background:true,cwd:'/project'});
    const rejected=assert.rejects(pending,/runtime-unavailable: disconnected/);
    await until(()=>f.requests.length>=3);
    f.disconnect();
    await rejected;
    assert.equal(f.client.closed,true);
    assert.equal(f.client.snapshot?.status,'degraded');
  } finally {f.client.close();}
});

test('a response delivered before disconnect is an old observation, not replacement readiness', async () => {
  const f=fixture();await f.client.ready;
  try {
    const pending=f.client.get({background:true,cwd:'/project'});
    await until(()=>f.requests.length>=2);
    f.reply(f.requests[1],snapshot('old'));
    // Transport delivery and process death are separate events. This ordering
    // cannot establish that the interrupted read reached a replacement daemon.
    f.disconnect();
    const observed=await pending;
    assert.equal(observed.instanceId,'old');
    assert.equal(f.client.closed,true);
    await assert.rejects(f.client.get({background:true,cwd:'/project'}),/runtime-unavailable: disconnected/);
  } finally {f.client.close();}
});

test('the standalone crash trigger owns a pending transport read, not just cached Goal activity', async () => {
  const { backgroundGoalObservation, backgroundObservation, closeBackgroundObservation } = await import(new URL('../../pi-better-background-tasks/src/work-observation.ts', import.meta.url).href);
  const f=fixture();await f.client.ready;
  const pi={events:{emit(_name: string, request: any){request.accept(f.client);}}};
  const ctx={cwd:'/project',sessionManager:{getSessionId:()=> 'parent'}};
  try {
    const initial=backgroundGoalObservation(pi,ctx);
    await until(()=>f.requests.length===2);f.reply(f.requests[1],snapshot('old'));await initial;
    const before=f.requests.length;
    const cached=await backgroundGoalObservation(pi,ctx);
    assert.equal(cached.instanceId,'old');
    assert.equal(f.requests.length,before,'warmed Goal activity intentionally sends no RPC');
    const pending=backgroundObservation(pi,ctx);
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert.equal(f.requests.length,before+1,'an interrupted read must issue an actual snapshot RPC');
    const request=f.requests.at(-1);
    assert.equal(request.type,'runtime_get_snapshot');
    assert.equal((f.client as unknown as {pending: Map<string, unknown>}).pending.has(request.id),true);
    const rejected=assert.rejects(pending,/runtime-unavailable: disconnected/);
    f.disconnect();await rejected;
  } finally {closeBackgroundObservation(pi);f.client.close();}
});
