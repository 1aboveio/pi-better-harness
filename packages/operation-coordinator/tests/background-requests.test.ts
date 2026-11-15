import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { BACKGROUND_PENDING_QUERY } from '../src/background-requests.ts';
import { test,afterEach } from 'node:test';
import { cleanupHarnesses,createHarness } from './support.ts';
afterEach(cleanupHarnesses);
test('Background request replay retains prepared identities across writer loss and refuses changed content',()=>{
  const h=createHarness(),owner='workspace/session',key='native-tool-call';
  let journal=h.store.backgroundRequests();
  assert.equal(journal.accept(owner,key,'digest').prior,false);journal.dispatch(owner,key);
  journal.operation(owner,key,{operationId:'exact-operation',taskId:'exact-task',token:'exact-token'});
  h.reopen();journal=h.store.backgroundRequests();
  assert.equal(journal.accept(owner,key,'digest').prior,true);
  assert.throws(()=>journal.accept(owner,key,'changed'),/request-conflict/);
  assert.throws(()=>journal.dispatch(owner,key),/already dispatched/);
  assert.deepEqual(journal.pending()[0]?.operations,[{operationId:'exact-operation',taskId:'exact-task',token:'exact-token'}]);
  journal.finish(owner,key,{status:'outcome_unknown',operations:journal.pending()[0]!.operations});
  h.reopen();journal=h.store.backgroundRequests();assert.equal(journal.pending().length,0);
  assert.deepEqual(journal.accept(owner,key,'digest').record.result,{status:'outcome_unknown',operations:[{operationId:'exact-operation',taskId:'exact-task',token:'exact-token'}]});
});

test('pending request migration tolerates non-JSON coordinator keys and excludes large returned history with an indexed bounded query',()=>{
  const h=createHarness();h.closeStore();
  const db=new DatabaseSync(h.path);
  const key=(owner:string,value:string)=>'background-request-v1:'+createHash('sha256').update(JSON.stringify([owner,value])).digest('hex');
  const insert=db.prepare('INSERT INTO coordinator_state (key,value) VALUES (?,?)');
  db.exec('BEGIN');
  insert.run('unrelated-counter','not-json');
  insert.run('another-counter','17');
  for(let i=0;i<10000;i++)insert.run(key('owner',`done-${i}`),JSON.stringify({owner:'owner',key:`done-${i}`,digest:'same',state:'returned',operations:[],result:{receipt:`receipt-${i}`,text:'x'.repeat(4096)}}));
  for(let i=0;i<260;i++)insert.run(key('owner',`pending-${i}`),JSON.stringify({owner:'owner',key:`pending-${i}`,digest:'same',state:i%2?'dispatching':'accepted',operations:[{operationId:`operation-${i}`,taskId:`task-${i}`,token:`token-${i}`}]}));
  db.exec('COMMIT');
  h.reopen();let journal=h.store.backgroundRequests();
  const plan=db.prepare('EXPLAIN QUERY PLAN '+BACKGROUND_PENDING_QUERY).all(128).map(row=>String(row.detail)).join(' ');
  assert.match(plan,/USING INDEX background_requests_pending/);assert.doesNotMatch(plan,/TEMP B-TREE/);
  assert.equal(journal.hasPending(),true);assert.equal(journal.pending().length,128);
  assert.throws(()=>journal.pending(129),/batch limit/);
  const recovered=new Set<string>();
  for(;;){const batch=journal.pending();if(!batch.length)break;assert.ok(batch.length<=128);
    for(const prior of batch){assert.equal(recovered.has(prior.key),false);recovered.add(prior.key);journal.finish(prior.owner,prior.key,{status:'outcome_unknown',operations:prior.operations});}}
  assert.equal(recovered.size,260);assert.equal(journal.hasPending(),false);
  h.reopen();journal=h.store.backgroundRequests();
  assert.equal(journal.read('owner','done-9999')?.result && (journal.read('owner','done-9999')!.result as any).receipt,'receipt-9999');
  assert.deepEqual(journal.read('owner','pending-259')?.result,{status:'outcome_unknown',operations:[{operationId:'operation-259',taskId:'task-259',token:'token-259'}]});
  assert.equal(db.prepare("SELECT value FROM coordinator_state WHERE key='unrelated-counter'").get()?.value,'not-json');
  db.close();
});
