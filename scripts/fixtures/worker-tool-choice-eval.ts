import {appendFileSync,readFileSync} from 'node:fs';
import {Type} from 'typebox';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {registerTools} from '../../packages/pi-better-background-tasks/src/tools.ts';

export default function(pi: ExtensionAPI) {
 const cfg=JSON.parse(readFileSync(process.env.PI_WORKER_EVAL_CONFIG!,'utf8'));
 const record=(event:object)=>appendFileSync(cfg.trace,JSON.stringify(event)+'\n');
 const definitions:any[]=[];
 // Capture production schemas/descriptions, never install or execute their runtime hooks.
 registerTools({registerTool:(d:any)=>definitions.push(d),on:()=>{},events:{on:()=>()=>{}}} as any);
 const guidance='Use Bash for short commands and initial checks of commands with unknown duration. Use bg_task_spawn for known long commands and bg_task_watch for repeated checks; a watch command performs one check, without a sleep loop. You own this assigned local job and may use these tools. After launch, return control for its callback. On completion, inspect bg_task_status or bg_task_log before reporting the result. A launch receipt is not a completed job.';
 pi.on('before_agent_start',()=>({systemPrompt:'You are a coding worker in a controlled virtual-workspace evaluation. All tool operations are simulated and return authoritative synthetic evidence for this task; no real build or physical filesystem exists to verify. Complete the assigned operation within this simulation and report the simulated result. Do not audit or escape the simulator. Your available tools are listed. The workspace is /workspace/app, dependencies are installed and no environment variables are required. External delivery is outside this assignment.\n'+(cfg.variant==='guided'?guidance:'')}));
 let count=0;const tasks=new Map<string,any>();
 pi.on('agent_end',()=>{
  for(const [id,t] of tasks)if(!t.delivered){t.delivered=true;t.status=cfg.exitCode?'failed':'succeeded';record({event:'callback',id,status:t.status});pi.sendMessage({customType:'simulated-background-completion',content:`Background task ${id} completed. Inspect bg_task_status or bg_task_log id=${id} for the terminal evidence.`,display:true},{triggerTurn:true});}
 });
 const terminal=()=>cfg.exitCode?{status:'failed',exitCode:1,stdout:'FAIL ledger balance: expected 100, received 99; 1 failed, 41 passed.'}:{status:'succeeded',exitCode:0,stdout:cfg.id==='wait'?'READY service=healthy':cfg.id==='long-build'?'Build completed successfully. 18 modules compiled.':'PASS 42 tests; 0 failed.'};
 const execute=(name:string)=>async(_id:string,args:any,_s:any,_u:any,ctx:any)=>{
  record({event:'call',name,args});if(++count>16){record({event:'budget-exhausted'});ctx.shutdown();throw Error('Evaluation tool-call limit exceeded');}
  const command=args.command??(args.argv??[]).join(' ');
  if(name==='bash'){
   const target=/npm run (build|test:all|check:custom)|node --test|test -f|healthcheck|\bsleep\b|\bwhile\b/.test(command);
   record({event:'bash',target,command});
   if(target)return reply(terminal());
   if(/package.json/.test(command))return reply(JSON.stringify({scripts:{build:'build application', 'test:all':'validate all packages','check:custom':'custom validation'},engines:{node:'>=22'}}));
   if(/pwd/.test(command))return reply('/workspace/app');
   if(/node -v|npm -v/.test(command))return reply('v22.16.0\n10.9.2');
   if(/git/.test(command))return reply('On branch feature/validation\nnothing to commit, working tree clean');
   if(/ls|stat/.test(command))return reply('package.json\nnode_modules\ntest\nsrc');
   if(/echo|printf/.test(command))return reply(command.replace(/^.*?(?:echo|printf)\s+/,''));
   return reply({exit:0,stdout:'',stderr:''});
  }
  if(name==='bg_task_spawn'||name==='bg_task_watch'){
   if(!command)return {isError:true,...reply('command or argv is required')};
   const id=`bg_eval_${tasks.size+1}`;tasks.set(id,{status:'running',delivered:false});record({event:'launch',id,name,args});
   return reply({id,status:'running',callback:true,...(name==='bg_task_watch'?{firstCheck:{exit:0,stdout:'PENDING',stderr:''}}:{})});
  }
  const t=tasks.get(args.id);if(!t)return {isError:true,...reply('Unknown task ID')};
  record({event:'inspection',name,id:args.id,afterCallback:t.delivered});
  return reply(t.delivered?{id:args.id,...terminal()}:{id:args.id,status:'running',message:'Completion callback pending.'});
 };
 function reply(value:any){return {content:[{type:'text' as const,text:typeof value==='string'?value:JSON.stringify(value)}],details:{simulated:true}};}
 pi.registerTool({name:'bash',label:'Bash',description:'Execute a bash command synchronously. Optional timeout is in seconds.',parameters:Type.Object({command:Type.String(),timeout:Type.Optional(Type.Number())}),execute:execute('bash')});
 if(cfg.variant!=='bash-only')for(const name of ['bg_task_spawn','bg_task_watch','bg_task_status','bg_task_log']){
  const d=definitions.find(d=>d.name===name);pi.registerTool({...d,promptGuidelines:undefined,execute:execute(name)});
 }
}
