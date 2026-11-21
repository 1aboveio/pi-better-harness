import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createTerminalRowRetention, observeNavigatorLaunch, ensureBackgroundWorkNavigator, disposeBackgroundWorkNavigator, registerBackgroundWorkProvider, refreshBackgroundWorkNavigator, type BackgroundWorkRow} from './index.ts';
const row: BackgroundWorkRow = {providerId:'tasks', id:'one', status:'failed', statusTone:'failed', kind:'task', elapsed:'', primary:'failure', sortStartedAt:0, expiresAt:100};
test('a late terminal observation remains for thirty seconds, including omission and reconnect', () => {
 const cache=createTerminalRowRetention();
 assert.equal(cache.merge([row],10000)[0].expiresAt,40000);
 assert.equal(cache.merge([],10001).length,1);
 assert.equal(cache.merge([row],39999).length,1);
 assert.equal(cache.merge([row],40000).length,0);
 assert.equal(cache.merge([row],50000).length,0,'repeated refresh must not restart retention');
});
test('a rejected launch is visible in the actual main list and late failures cannot leak across sessions',async()=>{
 let widget:any;
 const ui={setWidget(_key:string,value:any){widget=value;},setStatus(){},setEditorComponent(){},getEditorComponent(){},theme:{fg:(_c:string,s:string)=>s}};
 const ctx={cwd:'/workspace',mode:'tui',hasUI:true,ui,sessionManager:{getSessionId:()=> 'first'}} as any;
 const deps={createDefaultEditor:()=>({}),isOpenTrigger:()=>false,matchKey:()=>false,truncate:(s:string)=>s};
 const unregister=registerBackgroundWorkProvider({id:'tasks',label:'Tasks',priority:10,visibleCount:()=>0,listRows:()=>[],detail:()=>null,armCloseLabel:()=> 'dismiss',close:id=>({action:'dismissed',providerId:'tasks',id})});
 const rendered=()=>typeof widget==='function'?widget({requestRender(){}},ui.theme).render(140).join('\n'):String(widget);
 try{
  ensureBackgroundWorkNavigator(ctx,deps);
  await assert.rejects(observeNavigatorLaunch(ctx,'tasks','request-1','Failed startup',async()=>{throw new Error('runtime startup timed out');}),/timed out/);
  assert.match(rendered(),/Failed startup/);
  refreshBackgroundWorkNavigator(ctx);assert.match(rendered(),/Failed startup/);
  let reject!:(e:Error)=>void;
  const pending=observeNavigatorLaunch(ctx,'tasks','late','Old session failure',()=>new Promise((_,no)=>{reject=no;}));
  const next={...ctx,sessionManager:{getSessionId:()=> 'second'}};
  ensureBackgroundWorkNavigator(next,deps);
  reject(new Error('late rejection'));await assert.rejects(pending);
  refreshBackgroundWorkNavigator(next);assert.doesNotMatch(rendered(),/Failed startup|Old session failure/);
 }finally{disposeBackgroundWorkNavigator();unregister();}
});
test('scope disposal and explicit dismissal clear retained rows',()=>{
 const cache=createTerminalRowRetention();cache.merge([row],0);cache.dismiss('one');assert.equal(cache.merge([],1).length,0);
 cache.merge([row],2);cache.clear();assert.equal(cache.merge([],3).length,0);
});
