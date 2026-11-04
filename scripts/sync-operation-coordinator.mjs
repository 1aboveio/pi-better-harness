import {readdirSync,readFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {writeFileAtomically} from './atomic-write.mjs';

const root=resolve(import.meta.dirname,'..');
const source=join(root,'packages/operation-coordinator');
const targets=[
 join(root,'packages/pi-better-background-tasks/src/shared-operation-coordinator'),
 join(root,'packages/pi-better-subagents/shared-operation-coordinator'),
];
// Package-local copies keep standalone installs independent of the Harness bundle.
for(const target of targets){
 mkdirSync(join(target,'src'),{recursive:true});
 for(const name of readdirSync(join(source,'src'))){
  if(!name.endsWith('.ts')||name.endsWith('.test.ts'))continue;
  writeFileAtomically(join(target,'src',name),'// Generated from packages/operation-coordinator/src/'+name+'. Do not edit directly.\n'+readFileSync(join(source,'src',name),'utf8'));
 }
 writeFileAtomically(join(target,'index.ts'),'// Generated from packages/operation-coordinator/index.ts. Do not edit directly.\n'+readFileSync(join(source,'index.ts'),'utf8'));
}
