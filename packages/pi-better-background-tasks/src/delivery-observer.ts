import {existsSync,realpathSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {Type} from 'typebox';
import type {ExtensionAPI,ExtensionContext} from '@earendil-works/pi-coding-agent';

/** Domain observation uses the installed stateful watcher, never a generated polling predicate. */
export function resolveDeliveryWatcher(agentDir=process.env.PI_CODING_AGENT_DIR??join(homedir(),'.pi','agent')): string {
 const candidates=[
  join(agentDir,'skills','mergify','scripts','watch-pr-delivery.mjs'),
  join(homedir(),'.agents','skills','mergify','scripts','watch-pr-delivery.mjs'),
  join(agentDir,'npm','node_modules','@1aboveio','skills','skills','cicd','mergify','scripts','watch-pr-delivery.mjs'),
 ];
 for(const candidate of candidates)if(existsSync(candidate)&&statSync(candidate).isFile())return realpathSync.native(candidate);
 throw new Error('The installed Mergify delivery watcher is unavailable. Install the mergify skill; no replacement polling script was launched.');
}

export function deliveryObserverArguments(repo:string,pr:number,watcher:string): string[] {
 if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)||!Number.isSafeInteger(pr)||pr<1)throw new Error('A repository owner/name and positive PR number are required');
 if(!watcher.endsWith('/watch-pr-delivery.mjs'))throw new Error('Unsupported delivery observer implementation');
 return [process.execPath,watcher,'--repo',repo,'--pr',String(pr)];
}

export interface DeliveryObserverDependencies {
 resolveWatcher?:()=>string;
 launch:(params:{argv:string[];shell:false;cwd:string;name:string;callback:true},ctx:ExtensionContext)=>Promise<{id:string}>|{id:string};
 wait:(taskIds:string[],note:string,ctx:ExtensionContext)=>Promise<unknown>|unknown;
}

export function registerDeliveryObserver(pi:Pick<ExtensionAPI,'registerTool'>,dependencies:DeliveryObserverDependencies):void {
 pi.registerTool({
  name:'watch_delivery',label:'Watch delivery',
  description:'Observe an already-enqueued GitHub pull request through Mergify with the installed stateful delivery watcher. Starts a supervised background task and registers its wait. This does not enqueue, merge, push, edit the PR, or delegate polling to an LLM. Inspect the terminal verdict on completion before reporting delivery.',
  parameters:Type.Object({repo:Type.String({description:'Repository owner/name'}),pr:Type.Integer({minimum:1})}),
  async execute(_id,params,_signal,_update,ctx){
   const argv=deliveryObserverArguments(params.repo,params.pr,(dependencies.resolveWatcher??resolveDeliveryWatcher)());
   const task=await dependencies.launch({argv,shell:false,cwd:ctx.cwd,name:`Mergify delivery ${params.repo}#${params.pr}`,callback:true},ctx);
   const wait=await dependencies.wait([task.id],`Interpret the Mergify terminal verdict for ${params.repo}#${params.pr}; inspect merge/dequeue evidence before reporting delivery.`,ctx);
   return {content:[{type:'text',text:JSON.stringify({taskId:task.id,wait,status:'observing',mutationPerformed:false})}],details:{taskId:task.id,wait}};
  },
 });
}
