import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {operationBridgeToolAllowed} from '../task-guard.ts';
import {parseTaskPolicy,DEFAULT_TASK_PERMISSIONS} from '../task-policy.ts';

const source=fileURLToPath(new URL('../child-operations.ts',import.meta.url));
const base={version:1,root:'/workspace',home:'/home/worker',agentDir:'/home/worker/.pi/agent',profilePath:'/control/task.sb',scratch:'/scratch',permissions:DEFAULT_TASK_PERMISSIONS,denyWrite:['/control'],tools:['bash','bg_task_spawn','wait_for_operations'],applyPatch:false,extensionTools:[]};

test('only the explicit fixed worker bridge source and selected capability qualify for guarded admission',()=>{
 const policy=parseTaskPolicy({...base,operationBridge:true});
 assert.equal(operationBridgeToolAllowed(policy,'bg_task_spawn',source),true);
 assert.equal(operationBridgeToolAllowed(policy,'wait_for_operations',source),true);
 assert.equal(operationBridgeToolAllowed(policy,'bg_task_log',source),false,'not selected by launcher');
 assert.equal(operationBridgeToolAllowed(policy,'bash',source),false,'cannot replace guarded builtins');
 assert.equal(operationBridgeToolAllowed(policy,'bg_task_spawn',fileURLToPath(new URL('../task-guard.ts',import.meta.url))),false,'another real package source is not the bridge');
 assert.equal(operationBridgeToolAllowed(policy,'bg_task_spawn',undefined),false);
 assert.equal(operationBridgeToolAllowed(policy,'bg_task_spawn','<inline:spoof>'),false);
});

test('old policies cannot implicitly enable operation transport and malformed opt-ins refuse',()=>{
 const old=parseTaskPolicy(base);
 assert.equal(old.operationBridge,false);
 assert.equal(operationBridgeToolAllowed(old,'bg_task_spawn',source),false);
 assert.throws(()=>parseTaskPolicy({...base,operationBridge:'yes'}),/operation bridge/);
});
