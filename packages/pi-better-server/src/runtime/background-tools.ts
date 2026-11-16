import { effectiveBackgroundPolicy } from './background-policy.ts';
import { Check } from 'typebox/value';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { acquireMutationStore } from './mutation-store.ts';
/** Fixed canonical adapter. It never owns a native parent transcript. */
export async function createBackgroundTools(root: string, instance: string, draining: () => boolean = () => false, observe?: (scope: Record<string, unknown>) => Promise<any>) {
    const load = (file: string) => import(`./domain/background-service/${file}.domain.mjs`);
    const [{ createObservedWaitHost }, { registerTools }, { createBackgroundTaskRuntime }, sandbox, authority, permissions, registry, navigator, failures] = await Promise.all([
        load('observed-waits'), load('tools'), load('runtime'), load('sandbox'), load('managed-authority'),
        import(String('./domain/sandbox-policy/permission-settings.domain.mjs')), load('registry'), load('navigator-provider'), load('failures'),
    ]);
    const lease = acquireMutationStore(root);
    let journal: ReturnType<typeof lease.store.backgroundRequests>;
    let pi: any, service: any, session: any, runtime: any, current: any;
    let tail: Promise<unknown> = Promise.resolve(), pending = 0;
    const projections = new Map<string, any>(), metrics = { scopeRefreshes: 0, exactDetailReads: 0, reconciles: 0 };
    const recoveryVersions = new Map<string, string>();
    const scopes = new Map<string, any>(), deliveries = new Map<string, any>();
    const ownerKey = (owner: any) => JSON.stringify([owner.workspace, owner.sessionId]);
    const forgetView = (view: string) => { projections.delete(view); recoveryVersions.delete(view); };
    const forgetOwner = (key: string) => {
        for (const view of new Set([...projections.keys(), ...recoveryVersions.keys()]))
            if (JSON.parse(view)[0] === key) forgetView(view);
    };
    const effectivePolicy = (record: any) => effectiveBackgroundPolicy(record.policy, permissions.readPermissionSettings({ agentDir: () => root }).background, record.owner.workspace);
    const assertAdmission = () => {
        if (!current)
            throw new Error('background-authority-unavailable');
        const fresh = authority.readBackgroundAuthority(root, instance, current.authority, false);
        if (authority.backgroundDigest(fresh) !== current.digest || authority.backgroundDigest(effectivePolicy(fresh) ?? null) !== current.policyDigest)
            throw new Error('background-authority-changed');
    };
    const notifyParent = (notification: any, delivery: any) => {
        const owner = { workspace: notification.origin?.cwd, sessionId: notification.origin?.sessionId }, scope = scopes.get(ownerKey(owner));
        if (!scope || deliveries.size >= 256) {
            delivery.defer('Native recipient unavailable or delivery backlog full');
            return;
        }
        if ([...deliveries.values()].some(item => item.receiptId === delivery.receiptId && ownerKey(item.scope.owner) === ownerKey(owner))) {
            delivery.defer('Delivery already pending');
            return;
        }
        const token = randomUUID();
        deliveries.set(token, { token, notification, receiptId: delivery.receiptId ?? `background-terminal:${notification.operationId}`, delivery, scope, createdAt: Date.now() });
    };
    try {
        journal = lease.store.backgroundRequests();
        // Durable exact identities survive an interrupted RPC. Recover only
        // pending indexed batches and yield between them; never redispatch.
        for (;;) {
            const batch = journal.pending();
            if (!batch.length) break;
            for (const previous of batch) journal.finish(previous.owner, previous.key, {
                content: [{ type: 'text', text: previous.state === 'accepted' ? 'Background request was recovered before dispatch.' : 'Background request recovered after interrupted dispatch; inspect the recorded operations before issuing new work.' }],
                details: { status: previous.state === 'accepted' ? 'not_launched' : 'outcome_unknown', recovered: true, operations: previous.operations },
            });
            await yieldTurn();
        }
    // Seed only bounded legacy candidates, yielding between canonical manager
    // batches. Readers never scan sidecar history or mutate this obligation index.
    while (!lease.store.seedPendingParentCallbacks({ limit: 256 }).done) await yieldTurn();
        const settingsManager = SettingsManager.inMemory({});
        const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
            extensionFactories: [(api: any) => {
                    pi = new Proxy(api, { get(target, key) { if (key === 'sendMessage')
                            return () => { throw new Error('Native parent transcript delivery requires authenticated frontend'); }; const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
                    runtime = createBackgroundTaskRuntime(failures.createFailureAttention((origin:any,event:any)=>new Promise<boolean>(resolve=>notifyParent({origin,taskId:event.inspectId??event.id,status:event.status,urgent:true,event:{...event,isDelivered:undefined,getSuppressionReason:undefined,onDelivered:undefined}},
              {receiptId:event.receiptId,delivered:()=>{event.onDelivered?.(Date.now());resolve(true);},defer:()=>resolve(false)}))), (origin: any, event: any) => notifyParent({ origin, taskId: event.id, status: event.status, outcome: event.outcome, event: { ...event, isDelivered: undefined, getSuppressionReason: undefined, onDelivered: undefined, onSuppressed: undefined } }, { receiptId: event.receiptId, delivered: () => event.onDelivered?.(Date.now()), defer: () => undefined }), { assert: assertAdmission, prepared: (id: string) => journal.operation(current.ownerKey, current.record.key, { operationId: `legacy:${id}`, taskId: id, token: current.record.key }) });
                    service = createObservedWaitHost(pi, { sharedStore: lease.store, storePath: join(root, 'operation-coordinator.sqlite'), serverOwnedResults: true, pollMs: 0,
                        enterControl: () => lease.budget.enter('control'),
                        notifyParent, assertAdmission,
                        authorizeParentCancellation: ({requester, operation, requestId}: any) => {
                            assertAdmission();
                            const record=current.record;
                            const stopTool=record.tool==='bg_task_stop'||(['bg_task','bg_status'].includes(record.tool)&&record.params.action==='stop');
                            if (!stopTool || record.params.id !== operation.taskId
                                || (record.params.request_id ?? record.key) !== requestId
                                || requester.kind !== 'parent-session' || requester.workspace !== record.owner.workspace
                                || requester.sessionId !== record.owner.sessionId
                                || requester.branchId && !record.branchIds.includes(requester.branchId))
                                throw new Error('not_accepted: cancellation request is outside the protected native grant');
                            const sameOwner=requester.kind===operation.owner.kind&&requester.sessionId===operation.owner.sessionId&&requester.workspace===operation.owner.workspace;
                            if (!sameOwner && record.params.all !== true)
                                throw new Error('not_accepted: task belongs to another execution owner; explicit all:true is required');
                            return {requestId:`native-stop:${authority.backgroundDigest([record.owner,requestId,operation.taskId])}`,
                                reason:`explicit native stop; requester ${authority.backgroundDigest(record.owner)}; grant ${record.id}`};
                        }, beforeParentOperation: (operation: any) => journal.operation(current.ownerKey, current.record.key, operation) });
                    registerTools(pi, runtime, () => undefined, { resumeLocal: false });
                    sandbox.observeForegroundSandboxPolicy(pi);
                    pi.events.on(sandbox.FOREGROUND_SANDBOX_POLICY_REQUEST_CHANNEL, () => { if (current?.policy)
                        pi.events.emit(sandbox.FOREGROUND_SANDBOX_POLICY_CHANNEL, { ...current.policy, background: current.policy }); });
                }] });
        await resourceLoader.reload();
        const created = await createAgentSession({ cwd: root, agentDir: root, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(root), noTools: 'all' });
        session = created.session;
        await session.bindExtensions({ mode: 'print', onError: (error: any) => { throw new Error(String(error)); } });
        service.start();
    }
    catch (error) {
        try {
            service?.close();
            runtime?.suspendScheduledWork();
            session?.dispose();
        }
        finally {
            lease.release();
        }
        throw error;
    }
    return {
        get busy() { return pending > 0; },
        metrics() { return { ...metrics, registry: registry.getRegistryIoMetrics(), cachedScopes: projections.size }; },
        handle(command: any) {
            if (Object.keys(command).some(key => !['id', 'type', 'authority'].includes(key)))
                return Promise.reject(new Error('unsupported Background request field'));
            if (pending >= 64)
                return Promise.reject(new Error('runtime-overloaded: Background request capacity'));
            pending++;
            const request = tail.catch(() => undefined).then(async () => {
                const record = authority.readBackgroundAuthority(root, instance, command.authority), key = ownerKey(record.owner);
                // A warmed branch view must not overwrite another foreground's progress.
                const viewKey = JSON.stringify([key, authority.backgroundDigest(record.branchIds)]);
                const policy = effectivePolicy(record);
                current = { record, authority: command.authority, ownerKey: key, digest: authority.backgroundDigest(record), policy, policyDigest: authority.backgroundDigest(policy ?? null) };
                if (scopes.size >= 128 && !scopes.has(key)) {
                    const oldest = [...scopes.keys()].find(candidate => ![...deliveries.values()].some(item => ownerKey(item.scope.owner) === candidate));
                    if (oldest) {
                        scopes.delete(oldest); forgetOwner(oldest);
                    }
                    else
                        throw new Error('runtime-overloaded: Background scope capacity');
                }
                scopes.set(key, { owner: record.owner, branchIds: record.branchIds, pid: record.pid, start: record.start });
                sandbox.clearForegroundSandboxPolicy(pi);
                if (policy)
                    pi.events.emit(sandbox.FOREGROUND_SANDBOX_POLICY_CHANNEL, { ...policy, background: policy });
                const base = session.extensionRunner.createContext(), branch = record.branchIds.map((id: string) => ({ id }));
                const ctx = { ...base, cwd: record.owner.workspace, hasUI: false, isProjectTrusted: () => record.projectTrusted,
                    sessionManager: { getSessionId: () => record.owner.sessionId, getBranch: () => branch, getEntries: () => branch, getLeafId: () => record.branchIds.at(-1), getSessionFile: () => undefined } };
                service.noteParentContext(ctx, { recover: false });
                for (const [token, item] of deliveries)
                    if (Date.now() - item.createdAt > 30000) {
                        item.delivery.defer('Native delivery lease expired');
                        forgetOwner(ownerKey(item.scope.owner));
                        deliveries.delete(token);
                    }
                if (record.tool === '__background_receipt') {
                    const item = deliveries.get(record.params.token);
                    if (!item || ownerKey(item.scope.owner) !== key)
                        throw new Error('delivery-receipt-refused');
                    if (record.params.delivered === true && !service.isParentOriginActive(item.notification.origin, item.notification.branchId))
                        throw new Error('delivery-recipient-inactive');
                    if (record.params.delivered === true)
                        item.delivery.delivered();
                    else {
                        item.delivery.defer(String(record.params.reason ?? 'Native handoff deferred'));
                    }
                    deliveries.delete(record.params.token);
                    forgetOwner(key);
                    return { receipted: record.params.delivered === true };
                }
                if (record.tool === '__background_poll') {
                    if (!observe)
                        throw new Error('Shared Background observation unavailable');
                    // Recovery is indexed and bounded independently of display readiness.
                    const recoveryVersion = authority.backgroundDigest([lease.store.getChangeRevision(), record.branchIds]);
                    if (recoveryVersions.get(viewKey) !== recoveryVersion || service.hasPendingParentCallbackRecovery()) {
                        metrics.reconciles++;
                        service.noteParentContext(ctx);
                        await service.reconcileNow();
                        if (!recoveryVersions.has(viewKey) && recoveryVersions.size >= 128) forgetView(recoveryVersions.keys().next().value!);
                        recoveryVersions.set(viewKey, recoveryVersion);
                    }
                    const snapshot = await observe({ background: true, cwd: record.owner.workspace, sessionId: record.owner.sessionId });
                    if (snapshot.status !== 'ready')
                        throw new Error(snapshot.reason ?? 'Shared Background observation unverified');
                    const revision = authority.backgroundDigest([snapshot.scopeRevision, record.branchIds]);
                    let projection = projections.get(viewKey);
                    if (projection?.revision !== revision) {
                        metrics.scopeRefreshes++;
                        const legacy = snapshot.rows.filter((row: any) => !row.meta.durable).map((row: any) => row.meta);
                        const recovery=new Map([...legacy,...registry.listPendingCallbackMetasForOrigin({cwd:record.owner.workspace,sessionId:record.owner.sessionId})].map((meta:any)=>[meta.id,meta]));
                        for (const meta of recovery.values())
                            if (meta.status === 'running' || meta.callback !== false && !meta.callbackSentAt && !meta.callbackSuppressedAt)
                                runtime.resumeRunningTask(pi, meta, () => ({ cwd: record.owner.workspace, sessionId: record.owner.sessionId }));
                        projection = { revision, tasks: snapshot.rows.filter((row: any) => row.meta.durable).map((row: any) => row.meta), legacyRows: legacy.filter((meta: any) => !meta.dismissedAt).map((meta: any) => navigator.rowFromMeta(meta, Date.now())) };
                        if (projections.size >= 128 && !projections.has(viewKey))
                            forgetView(projections.keys().next().value!);
                        projections.set(viewKey, projection);
                    }
                    return { ...projection, recoveryPending: service.hasPendingParentCallbackRecovery(), deliveries: [...deliveries.values()].filter(item => ownerKey(item.scope.owner) === key).map(({ token, notification, receiptId }) => ({ token, notification, receiptId })) };
                }
                const origin = { cwd: record.owner.workspace, sessionId: record.owner.sessionId };
                if (record.tool === '__background_detail' || record.tool === '__background_action') {
                    const durable = service.readDurableTask(origin, record.params.id);
                    const candidate = registry.readMeta(record.params.id);
                    const meta = candidate && registry.belongsToOrigin(candidate, origin) ? candidate : undefined;
                    metrics.exactDetailReads++;
                    if (record.tool === '__background_detail')
                        return navigator.detailFromMeta(meta, Date.now(), { logTailLines: record.params.lines });
                    assertAdmission();
                    if (durable)
                        return record.params.action === 'stop' ? service.stopDurableTask(origin, record.params.id) : service.dismissDurableTask(origin, record.params.id);
                    if (!meta)
                        throw new Error('Background task is outside the captured scope');
                    if (record.params.action === 'stop')
                        return runtime.stopTask(pi, meta.id);
                    if (meta.status === 'running')
                        throw new Error('Cannot dismiss running work');
                    meta.dismissedAt = Date.now();
                    registry.writeMeta(meta);
                    return true;
                }
                if (record.tool === '__background_log')
                    return service.readDurableTaskLog(origin, record.params.id, record.params.lines);
                if (record.tool === '__background_stop')
                    return service.stopDurableTask(origin, record.params.id);
                if (record.tool === '__background_dismiss')
                    return service.dismissDurableTask(origin, record.params.id);
                const tool = session.extensionRunner.getToolDefinition(record.tool);
                if (!tool || record.parametersDigest !== authority.backgroundDigest(tool.parameters))
                    throw new Error('capability-mismatch: Background tool schema');
                if (!Check(tool.parameters, record.params))
                    throw new Error('Invalid Background tool parameters');
                const mutation = !['bg_task_list', 'bg_task_status', 'bg_task_log', 'bg_task_wait_list', 'bg_status'].includes(record.tool);
                const admission = ['bg_task_spawn', 'bg_task_spawn_batch', 'bg_task_watch', 'bg_task', 'wait_for_operations'].includes(record.tool);
                const prior = journal.read(key, record.key);
                if (admission && draining() && !prior)
                    throw new Error('runtime-draining: new Background execution deferred for upgrade');
                if (mutation) {
                    const accepted = journal.accept(key, record.key, authority.backgroundDigest({ tool: record.tool, params: record.params }));
                    if (accepted.prior)
                        return accepted.record.result ?? { content: [{ type: 'text', text: 'Accepted Background request has an uncertain outcome; inspect its exact operations before issuing new work.' }], details: { status: 'outcome_unknown', operations: accepted.record.operations } };
                    journal.dispatch(key, record.key);
                }
                assertAdmission();
                let result;
                try {
                    result = await tool.execute(record.key, record.params, undefined, undefined, ctx);
                }
                catch (error) {
                    if (mutation)
                        journal.finish(key, record.key, { content: [{ type: 'text', text: String(error) }], isError: true, details: { status: 'outcome_unknown', operations: journal.read(key, record.key)?.operations ?? [] } });
                    throw error;
                }
                // An exact canonical tool reply can establish ownership before
                // the shared display snapshot catches up. It grants no execution
                // authority; cancellation still revalidates the current request.
                const inspectedId = typeof record.params.id === 'string' ? record.params.id : result.details?.id;
                const inspected = typeof inspectedId === 'string' ? service.readDurableTask(origin, inspectedId) : undefined;
                if (inspected) result = { ...result, details: { ...result.details, backgroundOwnership: {
                    id: inspected.id, operationId: inspected.operationId,
                    owner: { kind: 'parent-session', sessionId: record.owner.sessionId, workspace: record.owner.workspace },
                } } };
                if (mutation)
                    journal.finish(key, record.key, result);
                return result;
            }).finally(() => { pending--; });
            tail = request;
            return request;
        },
        async close() { await tail.catch(() => undefined); for (const item of deliveries.values())
            item.delivery.defer('Runtime closing'); deliveries.clear(); try {
            service.close();
            runtime.suspendScheduledWork();
            session.dispose();
        }
        finally {
            lease.release();
        } },
    };
}
export function hasBackgroundRequests(root: string): boolean {
    if (!existsSync(join(root, 'operation-coordinator.sqlite')))
        return false;
    const lease = acquireMutationStore(root);
    try {
        return lease.store.backgroundRequests().hasPending();
    }
    finally {
        lease.release();
    }
}
