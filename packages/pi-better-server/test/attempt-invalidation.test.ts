import test from 'node:test';
import assert from 'node:assert/strict';
import {affectedAttempts} from '../src/runtime/attempt-invalidation.ts';
const row=(id:string,extra:object={})=>({id,sessionId:'session',cwd:'/workspace',...extra});
const edge=(id:string,parent:string,assignmentId='assignment')=>row(id,{resumedFrom:parent,operations:{resumeLaunchToken:id},assignment:{assignmentId}});
test('invalidation follows old and new resume chains with assignment and workspace fences',async()=>{
 const rows=[row('root'),edge('child','root'),edge('grandchild','child'),edge('foreign','root','other'),row('manual',{resumedFrom:'root'}),{...edge('outside','root'),cwd:'/other'}];
 assert.deepEqual([...await affectedAttempts(rows,[edge('child','root')])].sort(),['child','grandchild','root']);
 assert.deepEqual([...await affectedAttempts(rows,[row('root')])].sort(),['child','foreign','grandchild','root']);
 assert.deepEqual([...await affectedAttempts(rows,[row('manual')])],['manual']);
});
test('long resumed conversation visits each record once and yields to timers',async()=>{
 const rows=Array.from({length:10000},(_,i)=>edge(String(i),String(i-1)));
 let yielded=false;const timer=setTimeout(()=>{yielded=true},0);
 try{const affected=await affectedAttempts(rows,rows);assert.equal(affected.size,10001);assert.equal(yielded,true);}finally{clearTimeout(timer)}
});

test('indexed invalidation matches the previous traversal across changed and removed edges',async()=>{
 let seed=73;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed};
 for(let trial=0;trial<40;trial++) {
  const rows=Array.from({length:80},(_,i)=>row(String(i),{sessionId:String(random()%3),cwd:'/w'+random()%2,
   ...(random()%3?{operations:{resumeLaunchToken:String(i)},resumedFrom:String(random()%80)}:{}),
   ...(random()%2?{assignment:{assignmentId:String(random()%3)}}:{})}));
  const changed=rows.filter(()=>random()%5===0);const expected=new Set<string>();
  for(const meta of changed as any[]) {
   const ids=new Set<string>([meta.id]);let grew=true;
   while(grew){grew=false;for(const candidate of rows as any[]){
    if(!candidate.operations?.resumeLaunchToken||candidate.sessionId!==meta.sessionId||candidate.cwd!==meta.cwd
     ||(meta.assignment&&candidate.assignment?.assignmentId!==meta.assignment.assignmentId))continue;
    if(ids.has(candidate.id)||ids.has(candidate.resumedFrom))for(const id of [candidate.id,candidate.resumedFrom])if(id&&!ids.has(id)){ids.add(id);grew=true;}
   }}
   for(const id of ids)expected.add(id);
  }
  assert.deepEqual([...await affectedAttempts(rows,changed)].sort(),[...expected].sort());
 }
});
