import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { getNavigatorView, setNavigatorView, loadNavigatorView, treeRows, mergeAgentAttempts, ensureBackgroundWorkNavigator,
  disposeBackgroundWorkNavigator, registerBackgroundWorkProvider, type BackgroundWorkRow } from './index.ts';
const row = (providerId: string, id: string, extra: Partial<BackgroundWorkRow> = {}): BackgroundWorkRow => ({providerId,id,name:id,status:'running',statusTone:'running',kind:'task',elapsed:'2m',primary:'running',sortStartedAt:1,...extra});

test('tree keeps agents as peers, attaches tasks once and retains children with absent agents', () => {
  const result = treeRows([row('subagents','old',{agentId:'worker',sortStartedAt:1}),row('subagents','new',{agentId:'worker',sortStartedAt:2}),
    row('subagents','main'),row('background-tasks','child',{parentAgentId:'worker'}),row('background-tasks','direct'),
    row('background-tasks','orphan',{parentAgentId:'finished'})]);
  assert.deepEqual(result.map(r=>r.id),['main','direct','new','child','orphan']);
  assert.deepEqual(result.map(r=>r.treeDepth),[0,1,0,1,1]);
  assert.match(result[4].ownerGroupLabel!,/finished/);
});

test('view persists, switches mounted TUI immediately and renders at narrow and wide widths', () => {
  const root=mkdtempSync(join(tmpdir(),'navigator-view-')), prior=process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR=root;
  let widget:any, editor:any;
  const theme={fg:(_tone:string,value:string)=>value};
  const ui={theme,setStatus(){},setWidget(_key:string,value:any){widget=value;},getEditorComponent:()=>editor,setEditorComponent:(value:any)=>{editor=value;}};
  const ctx={mode:'tui',hasUI:true,cwd:root,ui,sessionManager:{getSessionId:()=> 'view-test'}} as any;
  const common={visibleCount:()=>1,detail:()=>null,close:(id:string)=>({action:'not-closable',providerId:'test',id}),armCloseLabel:()=>''};
  const offA=registerBackgroundWorkProvider({...common,id:'subagents',label:'Subagents',priority:10,
    parentRow:()=>row('subagents','main',{name:'Main'}),listRows:()=>[row('subagents','old-attempt',{agentId:'worker',name:'developer',sortStartedAt:1}),row('subagents','new-attempt',{agentId:'worker',name:'developer',sortStartedAt:2})]});
  const offB=registerBackgroundWorkProvider({...common,id:'background-tasks',label:'Background Tasks',priority:20,
    listRows:()=>[row('background-tasks','download',{parentAgentId:'worker'}),row('background-tasks','watch-pr')]});
  try {
    loadNavigatorView(); assert.equal(getNavigatorView(),'flatten');
    ensureBackgroundWorkNavigator(ctx,{createDefaultEditor:()=>({getText:()=>'',handleInput(){}}),isOpenTrigger:()=>false,matchKey:()=>false,truncate:truncateToWidth});
    const render=(width:number)=>widget({requestRender(){}},theme).render(width) as string[];
    assert.match(render(100).join('\n'),/subagents/);
    assert.equal((render(100).join('\n').match(/developer/g) ?? []).length,1,'flatten merges attempts of one conversation');
    setNavigatorView('tree');
    const previews=[];
    for(const width of [40,80,120]) {
      const lines=render(width); assert.ok(lines.every(line=>visibleWidth(line)<=width));
      const text=lines.join('\n'); assert.match(text,/work/);assert.match(text,/└─.*download/);assert.doesNotMatch(text,/background tasks/);
      previews.push(`${width} columns\n${text}`);
    }
    writeFileSync('/tmp/pi-navigator-view-preview.txt',previews.join('\n\n'));
    assert.equal(JSON.parse(readFileSync(join(root,'settings.json'),'utf8')).piBetterHarness.navigatorView,'tree');
    loadNavigatorView();assert.equal(getNavigatorView(),'tree');
    setNavigatorView('flatten');assert.match(render(100).join('\n'),/background tasks/);assert.doesNotMatch(render(100).join('\n'),/└─/);
    assert.throws(()=>setNavigatorView('nested'),/tree or flatten/);
  } finally {disposeBackgroundWorkNavigator(ctx);offA();offB();process.env.PI_CODING_AGENT_DIR=prior; if(prior===undefined) delete process.env.PI_CODING_AGENT_DIR;rmSync(root,{recursive:true,force:true});}
});


test('attempt merge preserves distinct same-name agents, tasks and latest failure', () => {
  const rows = [row('subagents','old',{agentId:'a',name:'developer',sortStartedAt:1}),
    row('subagents','failed',{agentId:'a',name:'developer',sortStartedAt:2,status:'failed',statusTone:'failed',expiresAt:30000}),
    row('subagents','other',{agentId:'b',name:'developer'}),row('background-tasks','task',{parentAgentId:'a'}),
    row('subagents','runtime-observation',{kind:'observation',status:'degraded'})];
  const result=mergeAgentAttempts(rows);
  assert.deepEqual(result.map(row=>row.id),['failed','other','task','runtime-observation']);
  assert.equal(result[0].expiresAt,30000);
  assert.equal(result[0].status,'failed');
});
