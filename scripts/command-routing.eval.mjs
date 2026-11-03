import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {installedPackage} from '../packages/pi-better-subagents/child-dependencies.mjs';
const run=promisify(execFile),root=resolve(import.meta.dirname,'..');
const dir=resolve(process.argv[2]??'.tmp/command-routing-comparison');mkdirSync(dir,{recursive:true});
const model=process.env.PI_ROUTING_EVAL_MODEL??'ollama-cloud/deepseek-v4.1-flash';
const agentNpm=join(process.env.PI_CODING_AGENT_DIR??join(homedir(),'.pi','agent'),'npm');
const harness=installedPackage('pi-better-harness',[agentNpm,root]);
const router=installedPackage('pi-better-model-router',[harness,agentNpm,root]);
const providerExtension=process.env.PI_ROUTING_EVAL_PROVIDER_EXTENSION??installedPackage('pi-ollama-cloud',[router,harness,agentNpm,root]);
if(!providerExtension)throw Error('Set PI_ROUTING_EVAL_PROVIDER_EXTENSION to the installed provider extension path.');
const oldPolicy=(await run('git',['show','e8848cd^:packages/pi-better-harness/extensions/execution-policy.ts'],{cwd:root})).stdout;
const oldParent=oldPolicy.split('\n').filter(x=>x.startsWith('  "')).map(x=>JSON.parse(x.trim().replace(/,$/,''))).join('\n');
const oldSource=(await run('git',['show','e8848cd^:packages/pi-better-subagents/child-ownership.ts'],{cwd:root})).stdout;
const oldWorker=JSON.parse(oldSource.match(/export const WORKER_HANDOFF = (".*");/)[1]);
const cases=[
 {id:'long-suite',worker:false,prompt:'Run the already configured full validation suite: npm run test:all in /workspace/app. It normally takes 12 minutes. No implementation or diagnosis is needed; record the result when finished.',expected:'bg_task_spawn'},
 {id:'ci-wait',worker:false,prompt:'Wait for GitHub Actions run 40880423328 to finish successfully using gh run view 40880423328 --json status,conclusion. It usually takes 15 minutes. No code change is needed.',expected:'bg_task_watch'},
 {id:'worker-long-suite',worker:true,prompt:'Implementation is complete and focused tests passed. The remaining validation is npm run test:all in /workspace/app, which normally takes 12 minutes. No further code changes are needed. Handle this remaining validation.',expected:'handoff'},
 {id:'worker-focused-check',worker:true,prompt:'You have just corrected a parser bug. Run the focused check node --test test/parser.test.mjs in /workspace/app. It takes about two seconds. Report its result.',expected:'bash'},
];
const jobs=cases.flatMap(c=>['old','new'].flatMap(variant=>[1,2].map(repeat=>({...c,variant,repeat}))));
const results=[];
async function evaluate(job){
 const id=`${job.id}-${job.variant}-${job.repeat}`,trace=join(dir,id+'.trace.jsonl'),config=join(dir,id+'.config.json');
 writeFileSync(config,JSON.stringify({...job,trace,oldParent,oldWorker}));
 const tools=job.worker?'bash':'bash,bg_task_spawn,bg_task_watch,subagent_spawn';
 const args=['--no-extensions','--no-skills','--no-prompt-templates','--no-context-files','--no-mcp','--no-session','--no-approve','--extension',resolve(root,'scripts/fixtures/command-routing-eval.ts'),'--extension',providerExtension,'--tools',tools,'--model',model,'--thinking','high','--mode','json','--print',job.prompt];
 const start=Date.now();
 try{
  const p=run('pi',args,{cwd:dir,env:{...process.env,PI_ROUTING_EVAL_CONFIG:config},timeout:240000,maxBuffer:8*1024*1024});p.child.stdin?.end();
  const {stdout,stderr}=await p;writeFileSync(join(dir,id+'.output.jsonl'),stdout);writeFileSync(join(dir,id+'.stderr.txt'),stderr);
  const events=stdout.split('\n').flatMap(l=>{try{return [JSON.parse(l)]}catch{return []}});
  const messages=events.filter(e=>e.type==='message_end'&&e.message?.role==='assistant').map(e=>e.message);
  const error=messages.find(m=>m.stopReason==='error');if(error)throw Error(error.errorMessage??'provider error');
  const calls=existsSync(trace)?readFileSync(trace,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
  const text=messages.flatMap(m=>m.content??[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
  const choice=calls.find(c=>c.target)?.name??(text?'handoff':'empty');
  // Preserve free-text handoffs for manual assessment; no-call alone is not a pass.
  const result={id,case:job.id,variant:job.variant,repeat:job.repeat,expected:job.expected,choice,calls,text,elapsedMs:Date.now()-start};results.push(result);console.log(JSON.stringify({id,choice,elapsedMs:result.elapsedMs}));
 }catch(e){const result={id,case:job.id,variant:job.variant,error:String(e.message),stderr:e.stderr,elapsedMs:Date.now()-start};results.push(result);console.log(JSON.stringify({id,error:result.error}));}
 writeFileSync(join(dir,'results.json'),JSON.stringify({model,simulatedOperations:true,results},null,2));
}
// Four independent requests at a time; no tool in these sessions executes commands.
for(let i=0;i<jobs.length;i+=4)await Promise.all(jobs.slice(i,i+4).map(evaluate));
console.log('RESULTS '+join(dir,'results.json'));
if(results.some(r=>r.error))process.exitCode=1;
