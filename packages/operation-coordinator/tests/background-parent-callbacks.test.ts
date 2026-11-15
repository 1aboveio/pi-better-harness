import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { cleanupHarnesses, createHarness, parentOwner, workerOwner } from './support.ts';
import type { Store, OwnerIdentity } from '../index.ts';
afterEach(cleanupHarnesses);
const scope = { sessionId: parentOwner.sessionId, workspace: parentOwner.workspace };
function operation(store: Store, id: string, owner: OwnerIdentity = parentOwner) {
    return store.registerOperation({ operationId: id, taskId: `task-${id}`, launchToken: `token-${id}`, owner,
        observer: { kind: 'local-supervisor', version: '1' }, supervision: { hostId: 'host' } }).operation;
}
function history(db: DatabaseSync, count: number) {
    db.exec('BEGIN');
    const insert=db.prepare(`INSERT INTO operations(operation_id,task_id,launch_token,owner_kind,owner_workspace,owner_session_id,
        observer_kind,observer_version,phase,health,created_at,updated_at,terminal_at,terminal_revision,supervision_json)
        VALUES (?,?,?,'parent-session',?,?,'local-supervisor','1','terminal','active',1,1,1,1,'{}')`);
    for(let i=0;i<count;i++) {const id=`history-${String(i).padStart(5,'0')}`;insert.run(id,`task-${id}`,`token-${id}`,scope.workspace,scope.sessionId);}
    db.exec("UPDATE operations SET supervision_json='invalid historical payload' WHERE operation_id LIKE 'history-%'");
    db.exec('COMMIT');
}
test('pending obligations retain exact owner scope across branches, receipts and reopen',()=>{
    const h=createHarness(), store=h.store;
    operation(store,'a');operation(store,'b',{...parentOwner,branchId:'other'});
    operation(store,'foreign',{...parentOwner,sessionId:'foreign'});operation(store,'worker',workerOwner);
    const before=store.getChangeRevision();
    assert.equal(store.setParentCallbackPending('task-a',true),true);
    const revision=store.getChangeRevision();assert.notEqual(revision,before);
    assert.equal(store.setParentCallbackPending('task-a',true),false);assert.equal(store.getChangeRevision(),revision);
    store.setParentCallbackPending('task-b',true);store.setParentCallbackPending('task-foreign',true);
    assert.equal(store.setParentCallbackPending('task-worker',true),false);
    assert.deepEqual(store.listPendingParentCallbacks(scope),[],'running obligations are retained but not ready for delivery');
    const db=new DatabaseSync(h.path);db.exec("UPDATE operations SET terminal_revision=1,terminal_at=100,phase='terminal' WHERE operation_id IN ('a','b')");db.close();
    assert.deepEqual(store.listPendingParentCallbacks(scope,{limit:1}).map(op=>op.operationId),['a']);
    assert.deepEqual(store.listPendingParentCallbacks(scope,{after:'a'}).map(op=>op.operationId),['b']);
    h.reopen();assert.equal(h.store.listPendingParentCallbacks(scope).length,2);
    assert.equal(h.store.setParentCallbackPending('task-a',false),true);
    assert.equal(h.store.setParentCallbackPending('task-a',false),false);
    assert.deepEqual(h.store.listPendingParentCallbacks(scope).map(op=>op.operationId),['b']);
    h.closeStore();
});
test('pending and recent queries decode only bounded relevant rows among 10000 historical completions',()=>{
    const h=createHarness();
    for(const id of ['recent-a','recent-b','recent-c']) operation(h.store,id);
    operation(h.store,'foreign',{...parentOwner,sessionId:'foreign'});
    const db=new DatabaseSync(h.path);
    history(db,10000);
    db.exec("UPDATE operations SET terminal_revision=1,terminal_at=100,phase='terminal' WHERE operation_id LIKE 'recent-%'");
    db.exec("UPDATE operations SET supervision_json='invalid foreign payload',terminal_revision=1,terminal_at=100,phase='terminal' WHERE operation_id='foreign'");
    h.store.setParentCallbackPending('task-recent-a',true);
    assert.deepEqual(h.store.listPendingParentCallbacks(scope).map(op=>op.operationId),['recent-a']);
    const first=h.store.listRecentBackgroundTerminals({since:100,owner:scope,limit:2});
    assert.deepEqual(first.map(op=>op.operationId),['recent-a','recent-b']);
    assert.deepEqual(h.store.listRecentBackgroundTerminals({since:100,owner:scope,after:{terminalAt:100,operationId:'recent-b'}}).map(op=>op.operationId),['recent-c']);
    const recentPlan=db.prepare("EXPLAIN QUERY PLAN SELECT * FROM operations WHERE observer_kind='local-supervisor' AND terminal_revision>0 AND terminal_at>=? AND owner_kind='parent-session' AND owner_workspace=? AND owner_session_id=? ORDER BY terminal_at,operation_id LIMIT 256").all(100,scope.workspace,scope.sessionId);
    assert.match(JSON.stringify(recentPlan),/SEARCH operations USING INDEX operations_background_owner_recent/);
    const globalPlan=db.prepare("EXPLAIN QUERY PLAN SELECT * FROM operations WHERE observer_kind='local-supervisor' AND terminal_revision>0 AND terminal_at>=? ORDER BY terminal_at,operation_id LIMIT 256").all(100);
    assert.match(JSON.stringify(globalPlan),/SEARCH operations USING INDEX operations_background_recent/);
    const pendingPlan=db.prepare("EXPLAIN QUERY PLAN SELECT o.* FROM background_parent_callbacks p JOIN operations o ON o.operation_id=p.operation_id WHERE p.owner_kind='parent-session' AND p.owner_workspace=? AND p.owner_session_id=? AND p.operation_id>? ORDER BY p.operation_id LIMIT 256").all(scope.workspace,scope.sessionId,'');
    assert.match(JSON.stringify(pendingPlan),/SEARCH p USING COVERING INDEX background_parent_callbacks_owner/);
    db.close();h.closeStore();
});
test('legacy seeding is bounded, durable across restart and never repeats a completed migration',()=>{
    const h=createHarness(), db=new DatabaseSync(h.path);
    history(db,600);
    // Simulate a prior schema with callback sidecars but no obligation index.
    db.exec('DROP TABLE background_parent_callbacks; DROP TABLE background_parent_callback_migration');
    db.close();h.reopen();
    const initialRevision=h.store.getChangeRevision();
    assert.deepEqual(h.store.seedPendingParentCallbacks({limit:10000}),{done:false,seeded:256});
    assert.notEqual(h.store.getChangeRevision(),initialRevision);
    h.reopen();
    const reader=new DatabaseSync(h.path);
    assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM background_parent_callbacks').get()?.n,256);
    // New exact writes can happen between migration pages without losing work.
    operation(h.store,'new-callback');h.store.setParentCallbackPending('task-new-callback',true);
    assert.deepEqual(h.store.seedPendingParentCallbacks(),{done:false,seeded:256});
    assert.deepEqual(h.store.seedPendingParentCallbacks(),{done:true,seeded:88});
    assert.equal(reader.prepare('SELECT COUNT(*) AS n FROM background_parent_callbacks').get()?.n,601);
    h.store.setParentCallbackPending('task-history-00001',false);
    h.reopen();assert.deepEqual(h.store.seedPendingParentCallbacks(),{done:true,seeded:0});
    assert.equal(reader.prepare("SELECT COUNT(*) AS n FROM background_parent_callbacks WHERE operation_id='history-00001'").get()?.n,0);
    assert.equal(reader.prepare("SELECT COUNT(*) AS n FROM background_parent_callbacks WHERE operation_id='new-callback'").get()?.n,1);
    reader.close();h.closeStore();
});
