import type { ManagedBackgroundNavigator } from './navigator-provider.js';
import { randomUUID } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { requestBackgroundTool } from './managed-client.js';
import { onBackgroundObservation } from './work-observation.js';
import { getCallbackBatcher } from './shared-callback-batcher.js';
import { registerObservedWaitClient, type ObservedWaitHost } from './observed-waits.js';
/** Native transcript delivery and cached UI projections; no coordinator or supervisor. */
export function createManagedBackgroundFrontend(pi: ExtensionAPI) {
    let ctx: ExtensionContext | undefined, generation = 0, refresh: Promise<void> | undefined, dirty=false;
    let rows: any[] = [], legacyRows: any[] = [], details = new Map<string, any>(), logs = new Map<string, any>();
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
            const snapshot = await request('__background_poll', {});
            if (version !== generation)
                return;
            rows = snapshot.tasks ?? [];
            legacyRows = snapshot.legacyRows ?? [];
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
        start(context: ExtensionContext) { ctx = context; generation++; void reconcile().catch(() => undefined); },
        noteParentContext(context: ExtensionContext) { ctx = context; generation++; void reconcile().catch(() => undefined); },
        close() { ctx = undefined; generation++; rows = []; legacyRows = []; details.clear(); logs.clear(); queued.clear(); },
        isParentOriginActive: active,
        onDurableTaskChange(listener: (change: any) => void) { listeners.add(listener); return () => listeners.delete(listener); },
        listDurableTasks(origin: any, options: any = {}) { return active(origin) ? rows.filter(row => !options.retentionMs || !row.terminal || Date.now() - (row.endedAt ?? Date.now()) < options.retentionMs) : []; },
        readDurableTask(origin: any, id: string) { return active(origin) ? rows.find(row => row.id === id) : undefined; },
        ownsDurableTask(id: string) { return rows.some(row => row.id === id); },
        readDurableTaskLog(origin: any, id: string, lines = 40) {
            if (!active(origin))
                return;
            const key = `${id}:${lines}`;
            return logs.get(key);
        },
        async stopDurableTask(origin: any, id: string) { if (!active(origin))
            return; const result = await request('__background_stop', { id }); await reconcile(); return result; },
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
                        ctx = context;
                        const result = await requestBackgroundTool(pi, context, id, definition.name, params, definition.parameters, signal);
                        await reconcile().catch(() => undefined);
                        return result;
                    } });
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
        } });
    registerObservedWaitClient(proxy, host as unknown as ObservedWaitHost);
    const ui: ManagedBackgroundNavigator = {
        rows: () => legacyRows.filter(row => !row.expiresAt || row.expiresAt > Date.now()),
        prepareDetail(id, options) {
            const lines = options?.logTailLines ?? 40, key = `${id}:${lines}`;
            const durable = rows.some(row => row.id === id), cache = durable ? logs : details;
            const version=generation;
            if (cache.has(key))
                return;
            cache.set(key, null);
            void request(durable ? '__background_log' : '__background_detail', { id, lines }).then(value => { if(version===generation){cache.set(key, value); notify();} }, () => {if(version===generation)cache.delete(key);});
        },
        detail(id, now, options) { return details.get(`${id}:${options?.logTailLines ?? 40}`) ?? null; },
        close(id) { void request('__background_action', { id, action: rows.find(row => row.id === id)?.active || legacyRows.find(row => row.id === id)?.status === 'running' ? 'stop' : 'dismiss' }).then(() => reconcile()).catch(() => undefined); return { action: 'requested', providerId: 'background-tasks', id }; }
    };
    return { host, proxy, ui };
}
