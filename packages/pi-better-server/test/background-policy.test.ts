import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveBackgroundPolicy } from '../src/runtime/background-policy.ts';
const profile={enabled:true,projectFiles:'read-write',outsideProject:'read-write',storedCredentials:'read-write',commands:true,network:true,shell:true,processAccess:'read',commandTimeoutSeconds:null};
test('Background policy intersects captured restrictions with fresh mandatory settings without widening read to write',()=>{
 const captured={state:'enabled',writableRoot:'/captured',denyWrite:['/secret'],permissions:{...profile,projectFiles:'read',network:false,commandTimeoutSeconds:5}};
 const next=effectiveBackgroundPolicy(captured,{...profile,projectFiles:'write',commands:false,commandTimeoutSeconds:10},'/workspace');
 assert.equal(next.permissions.projectFiles,'off');assert.equal(next.permissions.commands,false);assert.equal(next.permissions.network,false);assert.equal(next.permissions.commandTimeoutSeconds,5);assert.equal(next.writableRoot,'/captured');assert.deepEqual(next.denyWrite,['/secret']);
 assert.equal(effectiveBackgroundPolicy({state:'failed',reason:'source gone'},profile,'/workspace').state,'failed');
 assert.equal(effectiveBackgroundPolicy(undefined,{...profile,enabled:false},'/workspace'),undefined);
 assert.equal(effectiveBackgroundPolicy(undefined,{...profile,commands:false},'/workspace').permissions.commands,false);
});

test('Background Off ignores retained restrictions without dropping captured authority', () => {
 const captured = { state: 'enabled', writableRoot: '/captured', denyWrite: ['/secret'], permissions: { ...profile, network: false } };
 const off = { ...profile, enabled: false, commands: false, shell: false, processAccess: 'off', commandTimeoutSeconds: 1 };
 const next = effectiveBackgroundPolicy(captured, off, '/workspace');
 assert.equal(next.state, 'enabled');
 assert.deepEqual(next.permissions, captured.permissions);
 assert.deepEqual(next.denyWrite, captured.denyWrite);
});
