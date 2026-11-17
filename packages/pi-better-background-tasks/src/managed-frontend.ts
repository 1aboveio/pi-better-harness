import type { ManagedBackgroundNavigator } from './navigator-provider.js';
import { randomUUID } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { requestBackgroundTool } from './managed-client.js';
import { onBackgroundObservation } from './work-observation.js';
import { getCallbackBatcher } from './shared-callback-batcher.js';
import { registerObservedWaitClient, type ObservedWaitHost } from './observed-waits.js';
import { observeNavigatorLaunch } from './shared-navigator.ts';
/** Native transcript delivery and cached UI projections; no coordinator or supervisor. */
export function createManagedBackgroundFrontend(pi: ExtensionAPI) {
    let ctx: ExtensionContext | undefined, generation = 0, refresh: Promise<void> | undefined, dirty=false;
    let rows: any[] = [], legacyRows: any[] = [], details = new Map<string, any>(), logs = new Map<string, any>();
    const retainedTasks = new Map<string, any>();
    const cachedTask = (id: string) => rows.find(row => row.id === id) ?? retainedTasks.get(id);
    let adoptedScope: string | undefined;
    const scopeOf = (context: ExtensionContext) => JSON.stringify([context.cwd, context.sessionManager.getSessionId()]);
    const ownership = new Map<string, { operationId: string; owner: { kind: string; sessionId: string; workspace: string } }>();
    const adoptContext = (context: ExtensionContext) => {
        if (adoptedScope !== undefined && adoptedScope !== scopeOf(context)) {
            ownership.clear(); rows = []; legacyRows = []; details.clear(); logs.clear(); retainedTasks.clear(); generation++;
        }
        ctx = context; adoptedScope = scopeOf(context);
    };
    const rememberOwnership = (proof: any, context: ExtensionContext) => {
        if (!proof || typeof proof.id !== 'string' || typeof proof.operationId !== 'string'
            || proof.owner?.kind !== 'parent-session' || proof.owner.workspace !== context.cwd
            || proof.owner.sessionId !== context.sessionManager.getSessionId()) return;
        ownership.delete(proof.id); ownership.set(proof.id, proof);
        if (ownership.size > 256) ownership.delete(ownership.keys().next().value!);
    };
    const queued = new Set<string>(), listeners = new Set<(change: any) => void>();
    const active = (origin: any, branch?: string | null) => Boolean(ctx && origin.cwd === ctx.cwd && origin.sessionId === ctx.sessionManager.getSessionId()
        && (!branch || ctx.sessionManager.getBranch().some(entry => entry.id === branch)));
    const request = (tool: string, params: any) => {
        if (!ctx)
            throw new Error('Native Background session unavailable');
        return requestBackgroundTool(pi, ctx, randomUUID(), tool, params);
    };
    const notify = () => { for (const listener of listeners)
        listener({ workspace: ctx?.cwd, sessionId: ctx?.sessionManager.getSessionId() }); };
    const reconcile = () => {
        if (!ctx)
            return Promise.resolve();
        if (refresh) {dirty=true;return refresh;}
        dirty=false;
        const captured = ctx, version = generation;
        refresh = (async () => {
            const snapshot = await request('__background_poll', { knownActiveIds: rows.filter(row => row.active).map(row => row.id).slice(0, 200) });
            if (version !== generation)
                return;
            if (snapshot.recoveryPending === true) dirty = true;
            // A rebuilding snapshot is not evidence that visible tasks vanished.
            if (snapshot.status !== 'rebuilding' && snapshot.status !== 'degraded') {
                rows = snapshot.tasks ?? [];
                // Detail remains inspectable while Navigator retains a terminal row.
                for (const task of rows) {
                    retainedTasks.delete(task.id); retainedTasks.set(task.id, task);
                    if (retainedTasks.size > 256) retainedTasks.delete(retainedTasks.keys().next().value!);
                }
                legacyRows = snapshot.legacyRows ?? [];
            }
            notify();
            for (const item of snapshot.deliveries ?? []) {
                if (queued.has(item.token))
                    continue;
                queued.add(item.token);
                const receipt = (delivered: boolean, reason?: string) => void requestBackgroundTool(pi, captured, randomUUID(), '__background_receipt', { token: item.token, delivered, reason })
                    .catch(() => undefined).finally(() => {queued.delete(item.token);if(ctx===captured)void reconcile().catch(()=>undefined);});
                const proof = captured.sessionManager.getBranch().some((entry: any) => {
                    const message = entry.type === 'custom_message' ? entry : entry.message;
                    return item.notification.urgent ? message?.customType===item.notification.event.customType&&message.details?.urgentEventId===item.receiptId : message?.customType === 'background-completion-batch' && message.details?.completionEventIds?.includes(item.receiptId);
                });
                if (proof) {
                    receipt(true);
                    continue;
                }
                const n = item.notification;
                if(n.urgent){void getCallbackBatcher(pi).deliverUrgent({...n.event,receiptId:item.receiptId,getSuppressionReason:()=>active(n.origin,n.branchId)?undefined:'The originating session or branch is no longer active',onDelivered:()=>receipt(true),onSuppressed:(reason)=>receipt(false,reason)});continue;}
                getCallbackBatcher(pi).enqueue({ ...n.event, source: 'background-task', id: n.taskId, label: n.taskId, status: n.waitId ? `${n.status}; wait ${n.waitId} ready` : n.status,
                    detailTool: 'bg_task_status', outcome: n.outcome, callback: true, receiptId: item.receiptId,
                    getSuppressionReason: () => active(n.origin, n.branchId) ? undefined : 'The originating session or branch is no longer active',
                    onDelivered: () => receipt(true), onSuppressed: (reason) => receipt(false, reason) });
            }
        })().finally(() => { refresh = undefined;if(dirty&&ctx)void reconcile().catch(()=>undefined); });
        return refresh;
    };
    const host = {
        async reconcileNow() { await reconcile(); while (refresh) await refresh; },
        start(context: ExtensionContext) { adoptContext(context); generation++; void reconcile().catch(() => undefined); },
        noteParentContext(context: ExtensionContext) { adoptContext(context); generation++; void reconcile().catch(() => undefined); },
        close() { ctx = undefined; adoptedScope = undefined; generation++; rows = []; legacyRows = []; details.clear(); logs.clear(); retainedTasks.clear(); queued.clear(); ownership.clear(); },
        isParentOriginActive: active,
        onDurableTaskChange(listener: (change: any) => void) { listeners.add(listener); return () => listeners.delete(listener); },
        listDurableTasks(origin: any, _options: any = {}) { return active(origin) ? rows : []; },
        readDurableTask(origin: any, id: string) { const task = cachedTask(id); return active(origin, task?.parentRecipient?.branchId) ? task : undefined; },
        ownsDurableTask(id: string) { if (!ctx || adoptedScope !== scopeOf(ctx)) return false; return ownership.has(id) || rows.some(row => row.id === id && !row.readOnly); },
        readDurableTaskLog(origin: any, id: string, lines = 40) {
            if (!active(origin))
                return;
            const key = `${id}:${lines}`;
            return logs.get(key);
        },
        async stopDurableTask(origin: any, id: string) { if (!active(origin))
            return; const result = await request('__background_stop', { id }); await host.reconcileNow(); return result; },
        dismissDurableTask(origin: any, id: string) { if (!active(origin))
            return false; void request('__background_dismiss', { id }).then(() => reconcile()).catch(() => undefined); return false; },
    };
    registerObservedWaitClient(pi, host as unknown as ObservedWaitHost);
    pi.events?.on?.('pi-better-background-tasks:managed-capability',(request:any)=>{if(ctx&&typeof request?.accept==='function')request.accept({version:1,assignmentContinuation:1});});
    onBackgroundObservation(pi, () => { details.clear(); logs.clear(); void reconcile().catch(() => undefined); });
    const proxy = new Proxy(pi, { get(target, key) {
            if (key === 'registerTool')
                return (definition: any) => target.registerTool({ ...definition, execute: async (id: string, params: any, signal?: AbortSignal, _update?: unknown, context?: ExtensionContext) => {
                        if (!context)
                            throw new Error('Native Background context unavailable');
                        adoptContext(context);
                        const capturedGeneration = generation, capturedScope = adoptedScope;
                        const launch = () => requestBackgroundTool(pi, context, id, definition.name, params, definition.parameters, signal);
                        const spawning = ['bg_task_spawn', 'bg_task_spawn_batch', 'bg_task_watch'].includes(definition.name)
                            || definition.name === 'bg_task' && ['spawn', 'watch'].includes(params?.action);
                        const result = spawning ? await observeNavigatorLaunch(context, 'background-tasks', id, params?.name || 'Background task launch', launch) : await launch();
                        if (ctx === context && generation === capturedGeneration && adoptedScope === capturedScope) rememberOwnership(result.details?.backgroundOwnership, context);
                        await host.reconcileNow().catch(() => undefined);
                        return result;
                    } });
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
        } });
    registerObservedWaitClient(proxy, host as unknown as ObservedWaitHost);
    const ui: ManagedBackgroundNavigator = {
        rows: () => legacyRows,
        prepareDetail(id, options) {
            const lines = options?.logTailLines ?? 40, key = `${id}:${lines}`;
            const durable = Boolean(cachedTask(id)), cache = durable ? logs : details;
            const version=generation;
            if (cache.has(key))
                return;
            cache.set(key, null);
            void request(durable ? '__background_log' : '__background_detail', { id, lines }).then(value => { if(version===generation){cache.set(key, value); notify();} }, () => {if(version===generation)cache.delete(key);});
        },
        detail(id, now, options) { return details.get(`${id}:${options?.logTailLines ?? 40}`) ?? null; },
        close(id) { if (cachedTask(id)?.readOnly) return {action: 'not-closable', providerId: 'background-tasks', id}; void request('__background_action', { id, action: rows.find(row => row.id === id)?.active || legacyRows.find(row => row.id === id)?.status === 'running' ? 'stop' : 'dismiss' }).then(() => reconcile()).catch(() => undefined); return { action: 'requested', providerId: 'background-tasks', id }; }
    };
    return { host, proxy, ui };
}
