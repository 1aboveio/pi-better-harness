import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {claimDaemonOwner,inspectDaemonOwner} from '../src/daemon-owner.ts';
import {waitForRuntimeOwner} from '../src/runtime/client.ts';

test('a live owner may recover its listener without being replaced',async()=>{
 const root=mkdtempSync('/tmp/pi-owner-wait-');const release=claimDaemonOwner(root);
 const before=inspectDaemonOwner(root);let queries=0;
 try {
  const result=await waitForRuntimeOwner(root,async()=>{if(++queries===1)throw Object.assign(new Error('missing socket'),{code:'ENOENT'});return {instanceId:'recovered'};},1500);
  assert.equal(result.instanceId,'recovered');assert.deepEqual(inspectDaemonOwner(root),before);
 }finally{release();rmSync(root,{recursive:true,force:true})}
});
test('a live owner has a bounded wait; a released owner permits normal startup',async()=>{
 const root=mkdtempSync('/tmp/pi-owner-wait-');const release=claimDaemonOwner(root);
 const missing=async()=>{throw Object.assign(new Error('missing socket'),{code:'ENOENT'})};
 try{
  await assert.rejects(waitForRuntimeOwner(root,missing,50),/deadline exceeded.*existing live owner/);
  assert.equal(inspectDaemonOwner(root).status,'live');
  release();assert.equal(await waitForRuntimeOwner(root,missing,50),undefined);
 }finally{release();rmSync(root,{recursive:true,force:true})}
});
