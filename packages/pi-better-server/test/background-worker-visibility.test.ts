import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkReadModel} from '../src/runtime/read-model.ts';
const {openStore}=await import(new URL('../../operation-coordinator/index.ts', import.meta.url).href);

for (const proof of ['launch', 'wait']) test(`worker tasks use exact captured recipients with ${proof} proof, including terminal reads`, async()=>{
 const root=mkdtempSync(join(tmpdir(),'worker-visibility-')), directory=join(root,'supervisor');
 const store=openStore({path:join(root,'operation-coordinator.sqlite')});
 const model=new WorkReadModel(root,'fixture',{supervisorDirectory:directory,baseDir:join(root,'runs'),durableDir:join(root,'archives'),intervalMs:60000});
 const owner={kind:'worker-conversation' as const,sessionId:'worker',workspace:root,branchId:'branch',goalId:null};
 const recipient={kind:'parent-session' as const,sessionId:'parent',workspace:root,branchId:'parent-branch',goalId:null};
 const scope={background:true,cwd:root,sessionId:'parent'};
 try {
  store.registerAssignment({assignmentId:'assignment',attemptId:'attempt',owner,recipient});
  // A later assignment in the same conversation belongs elsewhere. It cannot steal this task.
  store.registerAssignment({assignmentId:'new-assignment',attemptId:'new-attempt',owner,recipient:{...recipient,sessionId:'other'}});
  store.registerOperation({operationId:'operation',taskId:'bgs_0123456789abcdef0123',launchToken:'token',owner,observer:{kind:'local-supervisor',version:'1'}});
  mkdirSync(join(directory,'observed'),{recursive:true});
  writeFileSync(join(directory,'observed','bgs_0123456789abcdef0123.json'),JSON.stringify({...proof==='launch' ? {workerAttemptId:'attempt'} : {},name:'Download'}));
  if(proof==='wait') store.registerWait({owner,dependencies:[{operationId:'operation'}],continuationNote:'Inspect',origin:{assignmentRef:'assignment'}});
  model.snapshot(scope);await model.reconcile();
  assert.equal(model.snapshot(scope).status,'ready',model.snapshot(scope).reason);
  let rows=model.snapshot(scope).rows;
  assert.equal(rows.length,1);assert.equal(rows[0]!.meta.parentAgentId,'worker');assert.equal(rows[0]!.meta.readOnly,true);
  assert.equal(model.snapshot({...scope,sessionId:'other'}).rows.length,0);
  assert.equal(model.snapshot({...scope,cwd:root+'-foreign'}).rows.length,0);
  store.recordTerminalOutcome({operationId:'operation',eventId:'done',owner,outcome:'failed',evidence:[{kind:'terminal-record',ref:'fixture'}]});
  await model.reconcile();rows=model.snapshot(scope).rows;
  assert.equal(rows.length,1);assert.equal(rows[0]!.meta.status,'failed');
  assert.equal(model.snapshot({...scope,id:'bgs_0123456789abcdef0123'}).rows[0]!.meta.id,'bgs_0123456789abcdef0123');
  assert.equal(model.snapshot({...scope,id:'bgs_0123456789abcdef0123',sessionId:'other'}).rows.length,0);
 } finally {await model.close();store.close();rmSync(root,{recursive:true,force:true});}
});
