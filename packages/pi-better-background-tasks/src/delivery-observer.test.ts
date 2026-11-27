import {describe,it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {deliveryObserverArguments,registerDeliveryObserver} from './delivery-observer.js';

describe('parent delivery observation',()=>{
 it('executes the installed watcher with literal arguments and links the resulting task to its parent wait',async()=>{
  const root=mkdtempSync(join(tmpdir(),'delivery-observer-'));const watcher=join(root,'watch-pr-delivery.mjs');
  writeFileSync(watcher,'console.log(JSON.stringify(process.argv.slice(2)));');
  let tool:any;const waits:any[]=[];let observed:string[]=[];
  registerDeliveryObserver({registerTool:(definition:any)=>{tool=definition;}} as any,{
   resolveWatcher:()=>watcher,
   launch:async(params)=>{
    expect(params.shell).toBe(false);expect(params.cwd).toBe(root);
    const {stdout}=await promisify(execFile)(params.argv[0],params.argv.slice(1),{cwd:params.cwd});
    observed=JSON.parse(stdout);return {id:'delivery-task'};
   },
   wait:(ids,note,ctx)=>{waits.push({ids,note,cwd:ctx.cwd});return {waitId:'delivery-wait'};},
  });
  try{
   const result=await tool.execute('call',{repo:'owner/project',pr:2203},undefined,undefined,{cwd:root});
   expect(observed).toEqual(['--repo','owner/project','--pr','2203']);
   expect(waits).toHaveLength(1);expect(waits[0].ids).toEqual(['delivery-task']);
   expect(result.details.taskId).toBe('delivery-task');expect(result.details.wait.waitId).toBe('delivery-wait');
  }finally{rmSync(root,{recursive:true,force:true});}
 });
 it('refuses malformed targets before invoking any launch',()=>{
  for(const [repo,pr] of [['owner/project; touch bad',1],['owner/project',0],['owner/project',1.5]]){
   expect(()=>deliveryObserverArguments(repo as string,pr as number,'/skills/watch-pr-delivery.mjs')).toThrow();
  }
  expect(()=>deliveryObserverArguments('owner/project',1,'/tmp/custom-poller.mjs')).toThrow(/Unsupported/);
 });
 it('does not claim a registered wait if registration fails after launch',async()=>{
  let tool:any;
  registerDeliveryObserver({registerTool:(d:any)=>{tool=d;}} as any,{
   resolveWatcher:()=>'/skills/watch-pr-delivery.mjs',launch:()=>({id:'launched-task'}),wait:()=>{throw Error('Owner is inactive');},
  });
  await expect(tool.execute('call',{repo:'owner/project',pr:1},undefined,undefined,{cwd:'/workspace'})).rejects.toThrow('Owner is inactive');
 });
});
