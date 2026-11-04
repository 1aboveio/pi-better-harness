import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import type {ExtensionAPI,ExtensionContext} from '@earendil-works/pi-coding-agent';
import extension from './extension-fixture.js';
import {OPERATION_RESUME_ADMISSION,operationOwnerMatches,type OperationResumeGate} from '../src/operation-admission.js';
import {currentGoalSnapshot} from '../src/goal-state.js';
import {operationResumeSchedulerGate} from '../src/workflow-gates.js';

test('worker resume admission follows parent identity, branch ancestry, goal pause and activation',async(t)=>{
 t.mock.timers.enable({apis:['setInterval','setTimeout']});
 const events=new EventEmitter();const handlers=new Map<string,any>();const commands=new Map<string,any>();const entries:any[]=[{type:'message',id:'anchor'}];
 const ctx={cwd:'/workspace',hasUI:false,isIdle:()=>true,sessionManager:{getBranch:()=>entries,getSessionId:()=> 'parent'},ui:{notify(){},setStatus(){},setWidget(){}}} as unknown as ExtensionContext;
 const bus={emit:(name:string,...args:any[])=>events.emit(name,...args),on:(name:string,listener:any)=>{events.on(name,listener);return ()=>events.off(name,listener);}};
 const pi={events:bus,on:(name:string,handler:any)=>handlers.set(name,handler),registerCommand:(name:string,command:any)=>commands.set(name,command),registerTool(){},registerShortcut(){},sendMessage(){},appendEntry:(customType:string,data:any)=>entries.push({type:'custom',customType,data})} as unknown as ExtensionAPI;
 extension(pi);await handlers.get('session_start')({},ctx);
 t.after(()=>handlers.get('session_shutdown')({},ctx));
 const ask=(owner:any)=>new Promise<OperationResumeGate>(resolve=>events.emit(OPERATION_RESUME_ADMISSION,{version:1,owner,reply:resolve}));
 const owner={sessionId:'parent',workspace:'/workspace',branchId:'anchor'};
 assert.equal((await ask(owner)).allowed,true);
 assert.equal((await ask({...owner,sessionId:'foreign'})).allowed,false);
 assert.equal((await ask({...owner,branchId:'abandoned'})).allowed,false);
 await commands.get('goal').handler('Implement observed waits',ctx);
 const goal=currentGoalSnapshot(ctx)!;
 assert.equal((await ask(owner)).allowed,false,'a changed goal cannot silently inherit an older operation');
 const bound={...owner,goalId:goal.goalId};
 const grant=await ask(bound);
 assert.equal(grant.allowed,true);
 assert.equal(grant.isCurrent?.(),true,'a fresh admission can be checked synchronously at execution release');
 await commands.get('goal').handler('pause',ctx);
 assert.equal(grant.isCurrent?.(),false,'a pause after the async reply invalidates the release capability');
 assert.equal((await ask(bound)).allowed,false,'task completion does not release a human pause');
 await handlers.get('session_shutdown')({},ctx);
 assert.equal(events.listenerCount(OPERATION_RESUME_ADMISSION),0,'shutdown removes admission capability rather than retaining an inactive listener');
});

test('branch anchors remain valid on descendants and refuse identity gaps',()=>{
 const ctx={cwd:'/workspace',sessionManager:{getSessionId:()=> 'parent',getBranch:()=>[{id:'anchor'},{id:'descendant'}]}} as unknown as ExtensionContext;
 assert.equal(operationOwnerMatches(ctx,{sessionId:'parent',workspace:'/workspace',branchId:'anchor'}),true);
 assert.equal(operationOwnerMatches(ctx,{sessionId:'parent',workspace:'/workspace',branchId:'other-fork'}),false);
 assert.equal(operationOwnerMatches(undefined,{sessionId:'parent',workspace:'/workspace'}),false);
});

test('automatic continuation disabled during an admission await invalidates that admission',async(t)=>{
 t.mock.timers.enable({apis:['setInterval','setTimeout']});
 const events=new EventEmitter();const handlers=new Map<string,any>();const commands=new Map<string,any>();const entries:any[]=[];
 const ctx={cwd:'/workspace',hasUI:false,isIdle:()=>true,sessionManager:{getBranch:()=>entries,getSessionId:()=> 'parent'},ui:{notify(){},setStatus(){},setWidget(){}}} as unknown as ExtensionContext;
 const pi={events,on:(name:string,handler:any)=>handlers.set(name,handler),registerCommand:(name:string,command:any)=>commands.set(name,command),registerTool(){},registerShortcut(){},sendMessage(){},appendEntry:(customType:string,data:any)=>entries.push({type:'custom',customType,data})} as unknown as ExtensionAPI;
 extension(pi);await handlers.get('session_start')({},ctx);
 await commands.get('goal').handler('Continue the assigned worker',ctx);
 const owner={sessionId:'parent',workspace:'/workspace',goalId:currentGoalSnapshot(ctx)!.goalId};
 const pending=new Promise<OperationResumeGate>(resolve=>events.emit(OPERATION_RESUME_ADMISSION,{version:1,owner,reply:resolve}));
 await commands.get('goal').handler('settings auto-continue off',ctx);
 assert.equal((await pending).allowed,false);
 await commands.get('goal').handler('settings auto-continue on',ctx);
 await handlers.get('session_shutdown')({},ctx);
});

test('worker scheduler admission distinguishes unreadable evidence from an eligible workflow',async()=>{
 const root=mkdtempSync(join(tmpdir(),'operation-scheduler-'));
 const skill=join(root,'skill');mkdirSync(join(skill,'scripts'),{recursive:true});
 const owner={name:'fixture-workflow',path:join(skill,'SKILL.md'),role:'coordinator' as const,planOwner:'workflow' as const};
 const entries=[{type:'custom',customType:'pi-better-workflow-plan',data:{version:1,kind:'set',owner:owner.name,path:join(root,'task-plan.json')}}];
 try{
  assert.equal((await operationResumeSchedulerGate(entries,owner)).ok,false,'missing scheduler is not eligibility');
  writeFileSync(join(skill,'scripts','next-actions.mjs'),'process.stdout.write("invalid scheduler output");');
  assert.equal((await operationResumeSchedulerGate(entries,owner)).ok,false,'invalid output must hold');
  writeFileSync(join(skill,'scripts','next-actions.mjs'),'process.stdout.write(JSON.stringify({due:[]}));');
  assert.deepEqual(await operationResumeSchedulerGate(entries,owner),{ok:true,waitUntil:undefined});
 }finally{rmSync(root,{recursive:true,force:true});}
});
