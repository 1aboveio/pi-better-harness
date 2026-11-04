import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,appendFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {captureParkCheckpoint,verifyParkCheckpoint} from '../park-checkpoint.ts';

function fixture(run){
 const root=mkdtempSync(join(tmpdir(),'park-checkpoint-'));
 const sessionFile=join(root,'session.jsonl');
 const input={sessionId:'conversation-1',sessionFile,toolCallId:'wait-call',waitId:'wait-1',generation:1};
 const records=[{type:'session',version:3,id:input.sessionId,cwd:root},
  {type:'message',id:'request',message:{role:'assistant',content:[{type:'toolCall',id:input.toolCallId,name:'wait_for_operations',arguments:{task_ids:['task-1']}}]}},
  {type:'message',id:'result',message:{role:'toolResult',toolCallId:input.toolCallId,toolName:'wait_for_operations',content:[{type:'text',text:JSON.stringify({operationWait:{waitId:input.waitId,generation:1}})}]}}];
 writeFileSync(sessionFile,records.map(JSON.stringify).join('\n')+'\n');
 try{return run({root,input,records,save:()=>writeFileSync(sessionFile,records.map(JSON.stringify).join('\n')+'\n')});}finally{rmSync(root,{recursive:true,force:true});}
}

test('a saved wait result pins a verifiable prefix while preserving subsequent continuation history',()=>fixture(({input})=>{
 const proof=captureParkCheckpoint(input);
 assert.equal(proof.entryId,'result');
 appendFileSync(input.sessionFile,JSON.stringify({type:'message',id:'resumed',message:{role:'user',content:'The task finished.'}})+'\n');
 verifyParkCheckpoint(proof);
 const original=readFileSync(input.sessionFile,'utf8');
 writeFileSync(input.sessionFile,original.replace('task-1','task-2'));
 assert.throws(()=>verifyParkCheckpoint(proof),/no longer contains/);
}));

test('parking refuses a result not flushed to the native transcript',()=>fixture(({input,records,save})=>{
 records.pop();save();
 assert.throws(()=>captureParkCheckpoint(input),/not the last persisted/);
}));

test('foreign identity, wrong generation, tool error and post-result activity cannot certify parking',()=>{
 for(const mutation of ['session','generation','error','activity','request'])fixture(({input,records,save})=>{
  if(mutation==='session')records[0].id='foreign';
  if(mutation==='generation')input.generation=2;
  if(mutation==='error')records[2].message.isError=true;
  if(mutation==='activity')records.push({type:'message',id:'extra',message:{role:'assistant',content:[{type:'text',text:'I continued working.'}]}});
  if(mutation==='request')records[1].message.content[0].name='bash';
  save();assert.throws(()=>captureParkCheckpoint(input),/another conversation|does not match|not the last persisted|No matching/);
 });
});

test('partial writes and truncated saved history remain unparkable',()=>fixture(({input})=>{
 const proof=captureParkCheckpoint(input);const bytes=readFileSync(input.sessionFile);
 writeFileSync(input.sessionFile,bytes.subarray(0,bytes.length-1));
 assert.throws(()=>captureParkCheckpoint(input),/incomplete checkpoint/);
 assert.throws(()=>verifyParkCheckpoint(proof),/no longer contains/);
}));
