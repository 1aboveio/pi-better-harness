import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {installedPackage} from '../packages/pi-better-subagents/child-dependencies.mjs';
const run=promisify(execFile),root=resolve(import.meta.dirname,'..');
const dir=resolve(process.argv[2]??'.tmp/worker-tool-choice');mkdirSync(dir,{recursive:true});
const model=process.env.PI_ROUTING_EVAL_MODEL??'ollama-cloud/deepseek-v4.1-flash';
const agentNpm=join(process.env.PI_CODING_AGENT_DIR??join(homedir(),'.pi','agent'),'npm');
const harness=installedPackage('pi-better-harness',[agentNpm,root]);
const router=installedPackage('pi-better-model-router',[harness,agentNpm,root]);
const providerExtension=process.env.PI_ROUTING_EVAL_PROVIDER_EXTENSION??installedPackage('pi-ollama-cloud',[router,harness,agentNpm,root]);
if(!providerExtension)throw Error('Provider extension unavailable');
const cases=[
 {id:'short',prompt:'Run node --test test/parser.test.mjs in /workspace/app. It normally takes two seconds. Report the observed result.',exitCode:0},
 {id:'long-build',prompt:'Run npm run build in /workspace/app. It normally takes 12 minutes. Own this local validation through its terminal result and report the outcome.',exitCode:0},
 {id:'long-failure',prompt:'Run npm run test:all in /workspace/app. It normally takes 12 minutes. Own this local validation through its terminal result and report the outcome, including the failure evidence if it fails.',exitCode:1},
 {id:'wait',prompt:'Wait for the locally managed service to become ready. Run test -f /workspace/app/ready.flag && echo READY || echo PENDING to check readiness. It normally takes ten minutes; check every 30 seconds. Report only after observing readiness.',exitCode:0},
 {id:'unknown',prompt:'Run npm run check:custom in /workspace/app and report its result. Its duration is unknown; it has not been timed before.',exitCode:0},
];
const repetitions=Number(process.env.PI_WORKER_EVAL_REPEATS??3);
let jobs=cases.flatMap(c=>Array.from({length:repetitions},(_,i)=>['bash-only','tools','guided'].map(variant=>({...c,variant,repeat:i+1}))).flat());
if(process.env.PI_WORKER_EVAL_ONLY)jobs=jobs.filter(j=>`${j.id}-${j.variant}-${j.repeat}`===process.env.PI_WORKER_EVAL_ONLY);
const results=[];
async function evaluate(job){
 const id=`${job.id}-${job.variant}-${job.repeat}`,trace=join(dir,id+'.trace.jsonl'),config=join(dir,id+'.config.json');writeFileSync(trace,'');writeFileSync(config,JSON.stringify({...job,trace}));
 const tools=job.variant==='bash-only'?'bash':'bash,bg_task_spawn,bg_task_watch,bg_task_status,bg_task_log';
 const args=['--no-extensions','--no-skills','--no-prompt-templates','--no-context-files','--no-mcp','--no-session','--no-approve','--extension',resolve(root,'scripts/fixtures/worker-tool-choice-eval.ts'),'--extension',providerExtension,'--tools',tools,'--model',model,'--thinking','high','--mode','json','--print',job.prompt];
 const start=Date.now();let stdout='',stderr='',error;
 try{const p=run('pi',args,{cwd:dir,env:{...process.env,PI_WORKER_EVAL_CONFIG:config},timeout:180000,maxBuffer:12*1024*1024});p.child.stdin?.end();({stdout,stderr}=await p);}catch(e){stdout=e.stdout??'';stderr=e.stderr??'';error=String(e.message).slice(0,500);}
 writeFileSync(join(dir,id+'.output.jsonl'),stdout);writeFileSync(join(dir,id+'.stderr.txt'),stderr);
 const events=stdout.split('\n').flatMap(l=>{try{return [JSON.parse(l)]}catch{return []}});
 const messages=events.filter(e=>e.type==='message_end'&&e.message?.role==='assistant').map(e=>e.message);
 const providerError=messages.find(m=>m.stopReason==='error');if(providerError)error=providerError.errorMessage??'Provider error';
 const traceEvents=readFileSync(trace,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
 const toolErrors=events.filter(e=>e.type==='tool_execution_end'&&e.isError).map(e=>({name:e.toolName,result:e.result}));
 const finalText=messages.at(-1)?.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n')??'';
 const launch=traceEvents.find(e=>e.event==='launch');const bashTarget=traceEvents.find(e=>e.event==='bash'&&e.target);
 const choice=launch?'background':bashTarget?'bash':'no-execution';
 const result={id,case:job.id,variant:job.variant,repeat:job.repeat,exitCode:job.exitCode,choice,launchTool:launch?.name,callbackObserved:traceEvents.some(e=>e.event==='callback'),terminalInspected:traceEvents.some(e=>e.event==='inspection'&&e.afterCallback),prematureInspections:traceEvents.filter(e=>e.event==='inspection'&&!e.afterCallback).length,toolErrors,trace:traceEvents,finalText,error,elapsedMs:Date.now()-start,models:[...new Set(messages.map(m=>m.provider+'/'+m.model))]};
 results.push(result);writeFileSync(join(dir,'results.json'),JSON.stringify({model,thinking:'high',simulatedOperations:true,repetitions,results},null,2));console.log(JSON.stringify({id,choice,terminalInspected:result.terminalInspected,toolErrors:toolErrors.length,error}));
}
// At most four independent model sessions in flight, with balanced variants in each case.
let next=0;await Promise.all(Array.from({length:Math.min(4,jobs.length)},async()=>{while(next<jobs.length)await evaluate(jobs[next++]);}));
console.log('RESULTS '+join(dir,'results.json'));if(results.some(r=>r.error))process.exitCode=1;
