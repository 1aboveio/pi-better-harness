import assert from 'node:assert/strict';
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
