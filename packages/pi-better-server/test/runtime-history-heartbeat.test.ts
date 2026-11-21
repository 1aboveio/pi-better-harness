import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {WorkQueryExecutor} from '../src/runtime/query-executor.ts';

test('10000 resumed history records rebuild without starving the read-worker watchdog', {timeout:45000}, async()=>{
 const root=mkdtempSync('/tmp/pi-history-heartbeat-'),durable=join(root,'durable'),archives=join(durable,'attempts');
 mkdirSync(archives,{recursive:true});mkdirSync(join(root,'runs'));
 const storeModule = new URL('../../operation-coordinator/index.ts', import.meta.url).href;
 const {openStore} = await import(storeModule);
 openStore({path:join(root,'operation-coordinator.sqlite')}).close();
 for(let i=0;i<10000;i++) {
  const id=`sa_history_${i}`,sessionId=`conversation-${Math.floor(i/2)}`;
  const meta={id,sessionId,cwd:root,status:'completed',startedAt:i,endedAt:i+1,
   ...(i%2?{resumedFrom:`sa_history_${i-1}`,operations:{resumeLaunchToken:`token-${i}`}}:{}),
   recipe:{version:1,sessionId,cwd:root,sessionDir:join(durable,'sessions')}};
  writeFileSync(join(archives,id+'.json'),JSON.stringify({version:1,meta}));
 }
 const executor=new WorkQueryExecutor(root,'history-heartbeat',{modelOptions:{baseDir:root,durableDir:durable,intervalMs:60000}});
 try {
  const deadline=Date.now()+30000;
  while(executor.observation().status!=='ready') {
   assert.equal(executor.metrics().executor.status,'ready','worker heartbeat must survive the inventory');
   assert.ok(Date.now()<deadline,'history inventory must converge');await delay(50);
  }
  const snapshot=await executor.snapshot({limit:1});
  assert.equal(snapshot.totalMatching,10000);
  assert.equal(executor.metrics().executor.restarts,0);
 }finally{await executor.close();rmSync(root,{recursive:true,force:true});}
});
