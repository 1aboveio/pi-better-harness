import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,chmodSync,realpathSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID,randomBytes,createHash } from 'node:crypto';
import { readBackgroundAuthority } from './managed-authority.js';
import { readProcessStartTokenFresh } from './process-identity.js';
test('Background admission authenticates exact instance, secret, native identity and protected grant',()=>{
 const root=realpathSync(mkdtempSync('/tmp/bg-authority-')),directory=join(root,'background-tool-admission');mkdirSync(directory,{mode:0o700});
 const id=randomUUID(),secret=randomBytes(32).toString('hex'),path=join(directory,`${id}.json`),authority={id,secret};
 const record={version:1,id,secretHash:createHash('sha256').update(secret).digest('hex'),instanceId:'server',key:'call',tool:'bg_task_spawn',owner:{sessionId:'native',workspace:root},branchIds:['exact-branch'],pid:process.pid,start:readProcessStartTokenFresh(process.pid)};
 const write=()=>writeFileSync(path,JSON.stringify(record),{mode:0o600});
 try {write();assert.equal(readBackgroundAuthority(root,'server',authority).owner.sessionId,'native');
 assert.throws(()=>readBackgroundAuthority(root,'other-server',authority),/refused/);
 assert.throws(()=>readBackgroundAuthority(root,'server',{id,secret:'0'.repeat(64)}),/refused/);
 record.start='different-start';write();assert.throws(()=>readBackgroundAuthority(root,'server',authority),/identity changed/);
 record.start=readProcessStartTokenFresh(process.pid)!;write();chmodSync(path,0o644);assert.throws(()=>readBackgroundAuthority(root,'server',authority),/refused/);
 chmodSync(path,0o600);rmSync(path);assert.throws(()=>readBackgroundAuthority(root,'server',authority));
 }finally{rmSync(root,{recursive:true,force:true});}
});
