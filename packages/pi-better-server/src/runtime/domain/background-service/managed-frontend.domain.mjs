// Generated fixed launch domain from packages/pi-better-background-tasks/src/managed-frontend.ts. Do not edit directly.
import { randomUUID } from 'node:crypto';
import { requestBackgroundTool } from "./managed-client.domain.mjs";
import { onBackgroundObservation } from "./work-observation.domain.mjs";
import { getCallbackBatcher } from "./shared-callback-batcher.domain.mjs";
import { registerObservedWaitClient } from "./observed-wait-client.domain.mjs";
import { observeNavigatorLaunch } from "./shared-navigator.domain.mjs";
/** Native transcript delivery and cached UI projections; no coordinator or supervisor. */
export function createManagedBackgroundFrontend(pi) {
    let ctx, generation = 0, refresh, dirty = false;
    let rows = [], legacyRows = [], details = new Map(), logs = new Map();
    const retainedTasks = new Map();
    const cachedTask = (id) => rows.find(row => row.id === id) ?? retainedTasks.get(id);
    let adoptedScope;
    let observing = false;
    const scopeOf = (context) => JSON.stringify([context.cwd, context.sessionManager.getSessionId()]);
    const ownership = new Map();
    const adoptContext = (context) => {
        if (adoptedScope !== undefined && adoptedScope !== scopeOf(context)) {
            ownership.clear();
            rows = [];
            legacyRows = [];
            details.clear();
            logs.clear();
            retainedTasks.clear();
            generation++;
        }
        ctx = context;
        adoptedScope = scopeOf(context);
    };
    const rememberOwnership = (proof, context) => {
        if (!proof || typeof proof.id !== 'string' || typeof proof.operationId !== 'string'
            || proof.owner?.kind !== 'parent-session' || proof.owner.workspace !== context.cwd
            || proof.owner.sessionId !== context.sessionManager.getSessionId())
            return;
        ownership.delete(proof.id);
        ownership.set(proof.id, proof);
        if (ownership.size > 256)
            ownership.delete(ownership.keys().next().value);
    };
    const queued = new Set(), listeners = new Set();
    const traceSeen = new Set();
    const trace = (stage, facts = {}) => {
        if (process.env.PI_BG_OBSERVED_WAITS_DEBUG !== '1')
            return;
        const full = JSON.stringify({ stage, sessionId: ctx?.sessionManager.getSessionId(), ...facts });
        const line = full.length <= 4096 ? full : JSON.stringify({ stage, truncated: true });
        if (traceSeen.has(line) || traceSeen.size >= 128)
            return;
        const output = traceSeen.size === 127 ? JSON.stringify({ stage: 'capture-limit', limit: 128 }) : line;
        traceSeen.add(line);
        try {
            console.error('[background-handoff-frontend]', output);
        }
        catch { /* diagnostics never own delivery */ }
    };
    const active = (origin, branch) => Boolean(ctx && origin.cwd === ctx.cwd && origin.sessionId === ctx.sessionManager.getSessionId()
        && (!branch || ctx.sessionManager.getBranch().some(entry => entry.id === branch)));
    const request = (tool, params) => {
        if (!ctx)
            throw new Error('Native Background session unavailable');
        return requestBackgroundTool(pi, ctx, randomUUID(), tool, params);
    };
    const notify = () => {
        for (const listener of listeners)
            listener({ workspace: ctx?.cwd, sessionId: ctx?.sessionManager.getSessionId() });
    };
    const reconcile = () => {
        if (!ctx)
            return Promise.resolve();
        if (refresh) {
            dirty = true;
            return refresh;
        }
        dirty = false;
        const captured = ctx, version = generation;
        refresh = (async () => {
            trace('poll-start');
            const snapshot = await request('__background_poll', { knownActiveIds: rows.filter(row => row.active).map(row => row.id).slice(0, 200) });
            trace('poll-received', { stale: version !== generation, total: snapshot.deliveries?.length ?? 0, deliveries: (snapshot.deliveries ?? []).slice(0, 8).map((item) => ({ taskId: item.notification.taskId, receiptId: item.receiptId })) });
            if (version !== generation)
                return;
            if (snapshot.recoveryPending === true)
                dirty = true;
            // A rebuilding snapshot is not evidence that visible tasks vanished.
            if (snapshot.status !== 'rebuilding' && snapshot.status !== 'degraded') {
                // Older servers include compact callback pointers in the task list.
                rows = (snapshot.tasks ?? []).filter((task) => !task.callbackPending);
                // Detail remains inspectable while Navigator retains a terminal row.
                for (const task of rows) {
                    retainedTasks.delete(task.id);
                    retainedTasks.set(task.id, task);
                    if (retainedTasks.size > 256)
                        retainedTasks.delete(retainedTasks.keys().next().value);
                }
                legacyRows = snapshot.legacyRows ?? [];
            }
            notify();
            for (const item of snapshot.deliveries ?? []) {
                if (queued.has(item.token))
                    continue;
                queued.add(item.token);
                const facts = { taskId: item.notification.taskId, receiptId: item.receiptId };
                const receipt = (delivered, reason) => {
                    trace('handoff', { ...facts, delivered, reason: reason?.slice(0, 256) });
                    void requestBackgroundTool(pi, captured, randomUUID(), '__background_receipt', { token: item.token, delivered, reason })
                        .then(() => trace('receipt-return', facts), error => trace('receipt-error', { ...facts, error: String(error).slice(0, 256) }))
                        .finally(() => { queued.delete(item.token); if (ctx === captured)
                        void reconcile().catch(() => undefined); });
                };
                const proof = captured.sessionManager.getBranch().some((entry) => {
                    const message = entry.type === 'custom_message' ? entry : entry.message;
                    return item.notification.urgent ? message?.customType === item.notification.event.customType && message.details?.urgentEventId === item.receiptId : message?.customType === 'background-completion-batch' && message.details?.completionEventIds?.includes(item.receiptId);
                });
                if (proof) {
                    receipt(true);
                    continue;
                }
                const n = item.notification;
                trace('queue', { ...facts, urgent: n.urgent === true, recipientActive: active(n.origin, n.branchId) });
                if (n.urgent) {
                    void getCallbackBatcher(pi).deliverUrgent({ ...n.event, receiptId: item.receiptId, getSuppressionReason: () => active(n.origin, n.branchId) ? undefined : 'The originating session or branch is no longer active', onDelivered: () => receipt(true), onSuppressed: (reason) => receipt(false, reason) });
                    continue;
                }
                getCallbackBatcher(pi).enqueue({ ...n.event, source: 'background-task', id: n.taskId, label: n.taskId, status: n.waitId ? `${n.status}; wait ${n.waitId} ready` : n.status,
                    detailTool: 'bg_task_status', outcome: n.outcome, callback: true, receiptId: item.receiptId,
                    getSuppressionReason: () => active(n.origin, n.branchId) ? undefined : 'The originating session or branch is no longer active',
                    onDelivered: () => receipt(true), onSuppressed: (reason) => receipt(false, reason) });
            }
        })().catch(error => { trace('poll-error', { error: String(error).slice(0, 256) }); throw error; })
            .finally(() => { refresh = undefined; if (dirty && ctx)
            void reconcile().catch(() => undefined); });
        return refresh;
    };
    const activate = () => {
        if (observing || !ctx)
            return;
        observing = true;
        const version = generation;
        void reconcile().catch(() => { if (generation === version)
            observing = false; });
    };
    const host = {
        async reconcileNow() { await reconcile(); while (refresh)
            await refresh; },
        start(context, restore = true) {
            adoptContext(context);
            generation++;
            observing = false;
            if (restore)
                activate();
        },
        noteParentContext(context) { adoptContext(context); generation++; void reconcile().catch(() => undefined); },
        close() { observing = false; ctx = undefined; adoptedScope = undefined; generation++; rows = []; legacyRows = []; details.clear(); logs.clear(); retainedTasks.clear(); queued.clear(); ownership.clear(); },
        isParentOriginActive: active,
        onDurableTaskChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        listDurableTasks(origin, _options = {}) { return active(origin) ? rows : []; },
        readDurableTask(origin, id) { const task = cachedTask(id); return active(origin, task?.parentRecipient?.branchId) ? task : undefined; },
        ownsDurableTask(id) { if (!ctx || adoptedScope !== scopeOf(ctx))
            return false; return ownership.has(id) || rows.some(row => row.id === id && !row.readOnly); },
        readDurableTaskLog(origin, id, lines = 40) {
            if (!active(origin))
                return;
            const key = `${id}:${lines}`;
            return logs.get(key);
        },
        async stopDurableTask(origin, id) {
            if (!active(origin))
                return;
            const result = await request('__background_stop', { id });
            await host.reconcileNow();
            return result;
        },
        dismissDurableTask(origin, id) {
            if (!active(origin))
                return false;
            void request('__background_dismiss', { id }).then(() => reconcile()).catch(() => undefined);
            return false;
        },
    };
    registerObservedWaitClient(pi, host);
    pi.events?.on?.('pi-better-background-tasks:managed-capability', (request) => { if (ctx && typeof request?.accept === 'function')
        request.accept({ version: 1, assignmentContinuation: 1 }); });
    onBackgroundObservation(pi, () => { details.clear(); logs.clear(); void reconcile().catch(() => undefined); });
    const proxy = new Proxy(pi, { get(target, key) {
            if (key === 'registerTool')
                return (definition) => target.registerTool({ ...definition, execute: async (id, params, signal, _update, context) => {
                        if (!context)
                            throw new Error('Native Background context unavailable');
                        adoptContext(context);
                        const capturedGeneration = generation, capturedScope = adoptedScope;
                        const launch = () => requestBackgroundTool(pi, context, id, definition.name, params, definition.parameters, signal);
                        const spawning = ['bg_task_spawn', 'bg_task_spawn_batch', 'bg_task_watch'].includes(definition.name)
                            || definition.name === 'bg_task' && ['spawn', 'watch'].includes(params?.action);
                        const result = spawning ? await observeNavigatorLaunch(context, 'background-tasks', id, params?.name || 'Background task launch', launch) : await launch();
                        if (ctx === context && generation === capturedGeneration && adoptedScope === capturedScope)
                            rememberOwnership(result.details?.backgroundOwnership, context);
                        await host.reconcileNow().catch(() => undefined);
                        return result;
                    } });
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
        } });
    registerObservedWaitClient(proxy, host);
    const ui = {
        onOpen: activate,
        rows: () => legacyRows,
        prepareDetail(id, options) {
            const lines = options?.logTailLines ?? 40, key = `${id}:${lines}`;
            const durable = Boolean(cachedTask(id)), cache = durable ? logs : details;
            const version = generation;
            if (cache.has(key))
                return;
            cache.set(key, null);
            void request(durable ? '__background_log' : '__background_detail', { id, lines }).then(value => { if (version === generation) {
                cache.set(key, value);
                notify();
            } }, () => { if (version === generation)
                cache.delete(key); });
        },
        detail(id, now, options) { return details.get(`${id}:${options?.logTailLines ?? 40}`) ?? null; },
        close(id) { if (cachedTask(id)?.readOnly)
            return { action: 'not-closable', providerId: 'background-tasks', id }; void request('__background_action', { id, action: rows.find(row => row.id === id)?.active || legacyRows.find(row => row.id === id)?.status === 'running' ? 'stop' : 'dismiss' }).then(() => reconcile()).catch(() => undefined); return { action: 'requested', providerId: 'background-tasks', id }; }
    };
    return { host, proxy, ui };
}
