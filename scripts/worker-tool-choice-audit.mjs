import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
const path=resolve(process.argv[2]);
const input=JSON.parse(readFileSync(path,'utf8'));
const rows=input.results.map(r=>{
 const routes=r.trace.filter(e=>e.event==='launch'||(e.event==='bash'&&e.target));
 const calls=r.trace.filter(e=>e.event==='call');
 const commands=routes.map(e=>e.command??e.args?.command??e.args?.argv?.join(' ')??'');
 const expected={short:/node --test test\/parser\.test\.mjs/,'long-build':/npm run build/,'long-failure':/npm run test:all/,unknown:/npm run check:custom/,wait:/ready\.flag/}[r.case];
 const launches=r.trace.filter(e=>e.event==='launch');
 const warnings=[];
 if(routes.length&&!commands.some(c=>expected.test(c)))warnings.push('No routed command matches assigned operation');
 for(const e of launches){
  if(e.name==='bg_task_watch'){
   const cmd=e.args?.command??'';
   if(/\bwhile\b|\bsleep\b|\bfor\s+\w+\s+in\b/.test(cmd))warnings.push('Watch command contains its own polling/wait loop');
   if(!e.args?.success_when)warnings.push('Watch has no success condition');
  }
 }
 if(launches.length>1)warnings.push('Multiple background launches; inspect for duplicate execution');
 if(r.prematureInspections)warnings.push('Inspected running task before synthetic callback');
 if(r.case==='short'&&launches.length)warnings.push('Background launch for known two-second check');
 const toolErrorKinds={schema:0,budget:0,runtimeInput:0};
 for(const error of r.toolErrors){
  const text=(error.result?.content??[]).map(c=>c.text??'').join(' ');
  toolErrorKinds[text.startsWith('Validation failed')?'schema':text.includes('limit exceeded')?'budget':'runtimeInput']++;
 }
 return {id:r.id,case:r.case,variant:r.variant,error:r.error??null,models:r.models,firstRoute:routes[0]?.event==='launch'?routes[0].name:routes[0]?'bash':'none',commands,toolErrors:r.toolErrors.length,toolErrorKinds,callbackEmitted:r.callbackObserved,postCallbackInspection:r.terminalInspected,warnings,finalText:r.finalText,calls};
});
const summary=[];
for(const scenario of ['short','long-build','long-failure','wait','unknown'])for(const variant of ['bash-only','tools','guided']){
 const group=rows.filter(r=>r.case===scenario&&r.variant===variant);
 const counts={};for(const r of group)counts[r.error?'provider-or-process-error':r.firstRoute]=(counts[r.error?'provider-or-process-error':r.firstRoute]??0)+1;
 summary.push({case:scenario,variant,n:group.length,routing:counts,toolErrors:group.reduce((a,r)=>a+r.toolErrors,0),schemaErrors:group.reduce((a,r)=>a+r.toolErrorKinds.schema,0),budgetErrors:group.reduce((a,r)=>a+r.toolErrorKinds.budget,0),runtimeInputErrors:group.reduce((a,r)=>a+r.toolErrorKinds.runtimeInput,0),postCallbackInspections:group.filter(r=>r.postCallbackInspection).length,warnings:group.flatMap(r=>r.warnings)});
}
const result={model:input.model,simulatedOperations:true,limitations:['Callbacks explicitly request inspection; inspection is a coached behavior.','Schema acceptance does not prove shell semantics or outcome-condition correctness.','Unknown-duration and readiness cases are compressed; real-time adaptation is not tested.','Three repetitions per cell; descriptive counts only.'],summary,rows};
writeFileSync(join(dirname(path),'audit.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({model:result.model,summary},null,2));
