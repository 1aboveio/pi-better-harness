import { effectiveBackgroundPolicy } from './background-policy.ts';
import { Check } from 'typebox/value';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, openSync, closeSync, readSync, fstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { acquireMutationStore } from './mutation-store.ts';
import { CatalogSources } from './catalog-sources.ts';
import { CiRecovery, diagnoseCiRecovery, readCiStage, recoveryFreshMs, runViewArgs, type RecoveryDependencies } from './ci-recovery.ts';
/** Fixed canonical adapter. It never owns a native parent transcript. */
export async function createBackgroundTools(root: string, instance: string, draining: () => boolean = () => false, observe?: (scope: Record<string, unknown>) => Promise<any>, verificationMs = 30000,
    trace?: (slot: number, phase: 'queued' | 'executing' | 'recovery' | 'read-pending' | 'read-returned' | 'tool-pending' | 'tool-returned' | 'settled') => void,
    catalog = new CatalogSources(), recoveryDependencies?: Partial<RecoveryDependencies>) {
    const load = (file: string) => import(`./domain/background-service/${file}.domain.mjs`);
    const [{ createObservedWaitHost }, { registerTools }, { createBackgroundTaskRuntime }, sandbox, authority, permissions, registry, navigator, failures, reviewSettings] = await Promise.all([
        load('observed-waits'), load('tools'), load('runtime'), load('sandbox'), load('managed-authority'),
        import(String('./domain/sandbox-policy/permission-settings.domain.mjs')), load('registry'), load('navigator-provider'), load('failures'), load('review-settings'),
    ]);
    const identity = await load('process-identity');
    const [ci, processTools, runnerStore] = await Promise.all([load('ci-observation'), load('process'), load('supervisor/store')]);
    const lease = acquireMutationStore(root);
    const unknownWriters = new Map<string, number>();
    let journal: ReturnType<typeof lease.store.backgroundRequests>;
    let pi: any, service: any, session: any, runtime: any, current: any;
    let tail: Promise<unknown> = Promise.resolve(), pending = 0;
    let traceSlot = 0;
    const projections = new Map<string, any>(), metrics = { scopeRefreshes: 0, exactDetailReads: 0, reconciles: 0 };
    const recoveryVersions = new Map<string, string>();
    const scopes = new Map<string, any>(), deliveries = new Map<string, any>();
    const recoveryCandidates = new Map<string, { owner: string; id: string; until: number; direct: boolean }>();
    const recoveryHistory = new Map<string, number>();
    const recoveryWindowMs = 10 * 60_000;
    const interruptedStatuses = ['failed', 'timed_out', 'lost'];
    const recoveryEnabled = () => !draining() && ci.ciObservationEnabled({ agentDir: () => root });
    const recovery = new CiRecovery(recoveryEnabled, {
        async read(run, signal, evidence, policy) {
            if (!evidence.policy) return;
            const fresh = sandbox.planFor(policy);
            const original = evidence.policy;
            // The probe must obey both the launch-time and the live restrictions.
            const confined = [original, fresh].filter(plan => plan.confined);
            if (confined.some(plan => plan.permissions?.network === false || plan.permissions?.storedCredentials === 'off')) return;
            const cwd = evidence.operation.owner.workspace;
            const spec = { argv: ['gh', ...runViewArgs(run)], shell: false, cwd };
            for (const plan of confined) sandbox.assertBackgroundExecutionAllowed(spec, plan, { cwd });
            const caps = confined.map(plan => sandbox.backgroundExecutionLimits(plan).commandTimeoutSeconds ?? 30);
            let plan = confined[0];
            if (original.confined && fresh.confined) {
                if (original.writableRoot !== fresh.writableRoot || !original.permissions || !fresh.permissions) return;
                plan = { ...original, denyWrite: [...new Set([...original.denyWrite, ...fresh.denyWrite])],
                    permissions: effectiveBackgroundPolicy({ state: 'enabled', writableRoot: cwd,
                        permissions: { ...original.permissions, enabled: true } }, { ...fresh.permissions, enabled: true }, cwd).permissions };
            }
            const directory = mkdtempSync(join(tmpdir(), 'pi-ci-recovery-'));
            try {
                const wrapped = plan ? sandbox.confineCommandSpec(spec, plan, join(directory, 'policy.sb')) : spec;
                return await readCiStage(run, signal, processTools.commandExecution(wrapped), cwd, 1000 * Math.min(30, ...caps));
            } finally { rmSync(directory, { recursive: true, force: true }); }
        },
        diagnose: (input, signal) => diagnoseCiRecovery(session.modelRuntime,
            catalog.load({ cwd: input.workspace, userRoot: root, projectTrusted: input.projectTrusted }), input, signal),
        ...recoveryDependencies,
    }, runnerStore.writeTextAtomic);
    const traceSeen = new Set<string>();
    const traceHandoff = (stage: string, facts: Record<string, unknown>) => {
        if (process.env.PI_BG_OBSERVED_WAITS_DEBUG !== '1') return;
        const full = JSON.stringify({ stage, ...facts });
        const line = full.length <= 4096 ? full : JSON.stringify({ stage, truncated: true });
        if (traceSeen.has(line) || traceSeen.size >= 128) return;
        const output = traceSeen.size === 127 ? JSON.stringify({ stage: 'capture-limit', limit: 128 }) : line;
        traceSeen.add(line);
        try { console.error('[background-handoff-server]', output); } catch { /* diagnostics never own delivery */ }
    };
    const isAttentionDelivery = (item: any) => {
        const type = item.notification.event?.customType;
        return type === 'background-task-stall' || type === 'background-wait-review' || type === ci.supervisorRecoveryType;
    };
    const sameNativeHost = (item: any, record: any) => item.scope.pid === record.pid && item.scope.start === record.start;
    const deliveryLeaseMs = 30000;
    const ownerKey = (owner: any) => JSON.stringify([owner.workspace, owner.sessionId]);
    const forgetView = (view: string) => { projections.delete(view); recoveryVersions.delete(view); };
    const forgetOwner = (key: string) => {
        for (const view of new Set([...projections.keys(), ...recoveryVersions.keys()]))
            if (JSON.parse(view)[0] === key) forgetView(view);
    };
    const effectivePolicy = (record: any) => effectiveBackgroundPolicy(record.policy, permissions.readPermissionSettings({ agentDir: () => root }).background, record.owner.workspace);
    const currentOutcome = (record: any) => {
        const value = record.supervisorOutcome;
        if (!value || !record.branchIds.includes(value.id) || typeof value.objective !== 'string' || !value.objective.trim()
            || value.objective.length > 2000 || ![value.doneWhen, value.boundaries].every(list => Array.isArray(list) && list.length <= 8
                && list.every(line => typeof line === 'string' && line.length <= 400))) return;
        return { id: value.id, objective: value.objective, doneWhen: value.doneWhen, boundaries: value.boundaries };
    };
    const candidateKey = (key: string, id: string) => JSON.stringify([key, id]);
    const rememberRecovery = (key: string, id: string, direct = false, endedAt = Date.now()) => {
        const index = candidateKey(key, id), previous = recoveryCandidates.get(index);
        if (previous && !direct) return;
        recoveryCandidates.set(index, { owner: key, id, direct: direct || previous?.direct === true, until: endedAt + recoveryWindowMs });
        if (recoveryCandidates.size > 256) recoveryCandidates.delete(recoveryCandidates.keys().next().value!);
    };
    const assertAdmission = () => {
        if (!current)
            throw new Error('background-authority-unavailable');
        const fresh = authority.readBackgroundAuthority(root, instance, current.authority, false);
        if (authority.backgroundDigest(fresh) !== current.digest || authority.backgroundDigest(effectivePolicy(fresh) ?? null) !== current.policyDigest)
            throw new Error('background-authority-changed');
    };
    const notifyParent = (notification: any, delivery: any) => {
        const owner = { workspace: notification.origin?.cwd, sessionId: notification.origin?.sessionId }, scope = scopes.get(ownerKey(owner));
        const facts = { taskId: notification.taskId, receiptId: delivery.receiptId, sessionId: owner.sessionId, urgent: notification.urgent === true };
        traceHandoff('notify', facts);
        if (!scope || deliveries.size >= 256) {
            traceHandoff('defer', { ...facts, scopeKnown: Boolean(scope), backlog: deliveries.size });
            delivery.defer('Native recipient unavailable or delivery backlog full');
            return;
        }
        if ([...deliveries.values()].some(item => item.receiptId === delivery.receiptId && ownerKey(item.scope.owner) === ownerKey(owner))) {
            traceHandoff('duplicate', facts);
            delivery.defer('Delivery already pending');
            return;
        }
        const token = randomUUID();
        deliveries.set(token, { token, notification, receiptId: delivery.receiptId ?? `background-terminal:${notification.operationId}`, delivery, scope, createdAt: Date.now() });
        traceHandoff('enqueued', facts);
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
              {receiptId:event.receiptId,delivered:()=>{event.onDelivered?.(Date.now());resolve(true);},defer:()=>resolve(false)}))), (origin: any, event: any) => notifyParent({ origin, taskId: event.id, status: event.status, outcome: event.outcome, event: { ...event, isDelivered: undefined, getSuppressionReason: undefined, onDelivered: undefined, onSuppressed: undefined } }, { receiptId: event.receiptId, delivered: () => event.onDelivered?.(Date.now()), defer: () => undefined }), { assert: assertAdmission,
                        prepared: (id: string) => journal.operation(current.ownerKey, current.record.key, { operationId: `legacy:${id}`, taskId: id, token: current.record.key }) },
                        (kind: string, id: string, work: () => unknown, dueAt?: number) => {
                            const origin = registry.readMeta(id)?.callbackOrigin;
                            return lease.budget.scheduleSource(`legacy-${kind}`, id, work, JSON.stringify([origin?.cwd ?? root, origin?.sessionId ?? null]), dueAt);
                        });
                    service = createObservedWaitHost(pi, { sharedStore: lease.store, storePath: join(root, 'operation-coordinator.sqlite'), serverOwnedResults: true, pollMs: 0,
                        enterControl: () => lease.budget.enter('control'),
                        notifyParent, assertAdmission,
                        currentOutcomeId: () => current && currentOutcome(current.record)?.id,
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
        lifecycleReasons() {
            const now = Date.now(), reasons: any[] = journal.lifecycleReasons().map((reason: any) => ({ ...reason,
                management: { instance } }));
            for (const scope of scopes.values()) for (const meta of registry.listActiveMetasForOrigin({ cwd: scope.owner.workspace, sessionId: scope.owner.sessionId })) {
                if (meta.status !== 'running') continue;
                const watch = meta.kind === 'command_watch' || Boolean(meta.remote);
                const verified = meta.pid && meta.pidStartTime && identity.readProcessStartToken(meta.pid) === meta.pidStartTime;
                if (!watch && !verified) {
                    if (!unknownWriters.has(meta.id)) unknownWriters.set(meta.id, now);
                    const since = unknownWriters.get(meta.id)!;
                    if (now >= since + verificationMs) continue;
                    reasons.push({ kind: 'verification', id: meta.id, owner: scope.owner, lastProgressAt: since,
                        nextDeadline: since + verificationMs, recovery: 'legacy-writer-unverified-no-takeover' });
                    continue;
                }
                unknownWriters.delete(meta.id);
                reasons.push({ kind: watch ? 'task' : 'runner', id: meta.id, owner: scope.owner,
                    writer: { pid: meta.pid, start: meta.pidStartTime }, lastProgressAt: meta.lastProgressAt ?? meta.startedAt,
                    nextDeadline: meta.deadlineAt ?? (watch ? (meta.lastCheckedAt ?? meta.startedAt) + (meta.intervalMs ?? 1000) : now + 1000),
                    recovery: watch ? 'captured-legacy-watch' : 'captured-legacy-command' });
            }
            return reasons;
        },
        metrics() { return { ...metrics, registry: registry.getRegistryIoMetrics(), cachedScopes: projections.size }; },
        handle(command: any, onAccepted?: (id: string) => void) {
            if (Object.keys(command).some(key => !['id', 'type', 'authority'].includes(key)))
                return Promise.reject(new Error('unsupported Background request field'));
            if (pending >= 64)
                return Promise.reject(new Error('runtime-overloaded: Background request capacity'));
            pending++;
            const slot = ++traceSlot;
            trace?.(slot, 'queued');
            const request = tail.catch(() => undefined).then(async () => {
                trace?.(slot, 'executing');
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
                    if (Date.now() - item.createdAt >= deliveryLeaseMs) {
                        item.delivery.defer('Native delivery lease expired');
                        forgetOwner(ownerKey(item.scope.owner));
                        deliveries.delete(token);
                    }
                const origin = { cwd: record.owner.workspace, sessionId: record.owner.sessionId };
                const outcome = currentOutcome(record);
                const ciEvidence = (id: string) => outcome && service.ciObservation(origin, id, outcome.id, record.branchIds);
                const recoveryInput = outcome && { outcome, policy, projectTrusted: record.projectTrusted === true,
                    authorization: authority.backgroundDigest([policy ?? null, record.projectTrusted === true, outcome]) };
                const invalidateRecovery = () => {
                    for (const [token, item] of deliveries) if (item.notification.event?.customType === ci.supervisorRecoveryType) deliveries.delete(token);
                    recovery.cancelPending();
                };
                if (record.tool === ci.supervisorConsultTool) {
                    const reply = (status: string, text: string) => ({ content: [{ type: 'text', text }], details: { status } });
                    if (!recoveryEnabled()) {
                        invalidateRecovery();
                        return reply('disabled', 'CI observation recovery is disabled or the daemon is draining. Check /harness-settings → Supervisor mode → CI observation recovery.');
                    }
                    const evidence = typeof record.params?.id === 'string' && ciEvidence(record.params.id);
                    if (!evidence || !recoveryInput) return reply('outside-scope', 'No supported watcher belongs to this active Outcome and branch.');
                    assertAdmission();
                    rememberRecovery(key, record.params.id, true);
                    // Consultation uses the same check and delivery as automatic recovery.
                    return reply('queued', 'The daemon will check this watcher through the same CI recovery path. Any advice is delivered to the original owner only once.');
                }
                if (record.tool === '__background_receipt') {
                    const item = deliveries.get(record.params.token);
                    traceHandoff('receipt', { sessionId: record.owner.sessionId, taskId: item?.notification.taskId,
                        receiptId: item?.receiptId, found: Boolean(item), delivered: record.params.delivered === true });
                    if (!item || ownerKey(item.scope.owner) !== key || isAttentionDelivery(item) && !sameNativeHost(item, record))
                        throw new Error('delivery-receipt-refused');
                    if (item.notification.event?.customType === ci.supervisorRecoveryType && record.params.delivered === true
                        && (!outcome || outcome.id !== item.notification.outcomeId))
                        throw new Error('delivery-recipient-inactive');
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
                    traceHandoff('poll-enter', { sessionId: record.owner.sessionId });
                    if (!observe)
                        throw new Error('Shared Background observation unavailable');
                    // Recovery is indexed and bounded independently of display readiness.
                    const recoveryVersion = authority.backgroundDigest([lease.store.getChangeRevision(), record.branchIds]);
                    if (recoveryVersions.get(viewKey) !== recoveryVersion || service.hasPendingParentCallbackRecovery()) {
                        metrics.reconciles++;
                        service.noteParentContext(ctx);
                        trace?.(slot, 'recovery');
                        await service.reconcileNow();
                        if (!recoveryVersions.has(viewKey) && recoveryVersions.size >= 128) forgetView(recoveryVersions.keys().next().value!);
                        recoveryVersions.set(viewKey, recoveryVersion);
                    }
                    trace?.(slot, 'read-pending');
                    const snapshot = await observe({ background: true, cwd: record.owner.workspace, sessionId: record.owner.sessionId });
                    trace?.(slot, 'read-returned');
                    if (snapshot.status !== 'ready')
                        throw new Error(snapshot.reason ?? 'Shared Background observation unverified');
                    // Callback pointers carry a delivery obligation but no navigator detail.
                    const visibleRows = snapshot.rows.filter(({ meta }: any) => !meta.callbackPending
                        && (!meta.parentRecipient?.branchId || record.branchIds.includes(meta.parentRecipient.branchId)));
                    const revision = authority.backgroundDigest([snapshot.scopeRevision, record.branchIds]);
                    let projection = projections.get(viewKey);
                    if (projection?.revision !== revision) {
                        metrics.scopeRefreshes++;
                        const legacy = visibleRows.filter((row: any) => !row.meta.durable).map((row: any) => row.meta);
                        const recovery=new Map([...legacy,...registry.listPendingCallbackMetasForOrigin({cwd:record.owner.workspace,sessionId:record.owner.sessionId})].map((meta:any)=>[meta.id,meta]));
                        for (const meta of recovery.values())
                            if (meta.status === 'running' || meta.callback !== false && !meta.callbackSentAt && !meta.callbackSuppressedAt)
                                runtime.resumeRunningTask(pi, meta, () => ({ cwd: record.owner.workspace, sessionId: record.owner.sessionId }));
                        projection = { revision, tasks: visibleRows.filter((row: any) => row.meta.durable).map((row: any) => row.meta), legacyRows: legacy.filter((meta: any) => !meta.dismissedAt).map((meta: any) => navigator.rowFromMeta(meta, Date.now())) };
                        if (projections.size >= 128 && !projections.has(viewKey))
                            forgetView(projections.keys().next().value!);
                        projections.set(viewKey, projection);
                    }
                    // A task may finish while the client is disconnected, then
                    // age out of the recent index before reconnect. Resolve only
                    // the client's bounded, previously active IDs in this owner.
                    const tasks = [...projection.tasks];
                    const present = new Set(tasks.map((task: any) => task.id));
                    if (Array.isArray(record.params.knownActiveIds)) {
                        for (const id of new Set(record.params.knownActiveIds.slice(0, 200))) {
                            if (typeof id !== 'string' || present.has(id)) continue;
                            let task = service.readDurableTask({cwd: record.owner.workspace, sessionId: record.owner.sessionId}, id);
                            if (!task) {
                                const exact = await observe({background: true, cwd: record.owner.workspace, sessionId: record.owner.sessionId, id});
                                task = exact.rows.find((row: any) => row.meta.id === id && !row.meta.callbackPending)?.meta;
                            }
                            if (task && task.dismissedAt === undefined && (!task.parentRecipient?.branchId || record.branchIds.includes(task.parentRecipient.branchId))) { tasks.push(task); present.add(id); }
                        }
                    }
                    const liveAlerts = new Map<string, any>();
                    const reviewTasks = tasks.filter(task => task.active && task.progress && task.callback && task.owner.kind === 'parent-session');
                    let intervalMinutes = reviewSettings.DEFAULT_BACKGROUND_REVIEW_INTERVAL_MINUTES;
                    if (reviewTasks.some(task => task.waits.length)) {
                        try { intervalMinutes = reviewSettings.readBackgroundReviewInterval({ agentDir: () => root }); }
                        catch { /* An unreadable settings file must not interrupt Background delivery. */ }
                    }
                    let nextReviewAt = Infinity;
                    for (const task of reviewTasks) {
                        const stall = task.progress.alertDue ? service.pendingStallAlert(origin, task.id, task.waits) : undefined;
                        const review = task.waits.length ? service.backgroundWaitReview(origin, task.id, task.waits, intervalMinutes * 60_000) : undefined;
                        for (const alert of [stall, review?.alert]) {
                            if (!alert) continue;
                            liveAlerts.set(alert.delivery.receiptId, alert.notification);
                            notifyParent(alert.notification, alert.delivery);
                        }
                        if (review && !review.alert) nextReviewAt = Math.min(nextReviewAt, review.dueAt);
                    }
                    const outgoing = [];
                    let retryAfterMs = Number.isFinite(nextReviewAt) ? Math.max(1, nextReviewAt - Date.now()) : undefined;
                    if (liveAlerts.size && deliveries.size >= 256) retryAfterMs = Math.min(retryAfterMs ?? 1000, 1000);
                    if (recoveryInput) {
                        const capture = (task: any) => {
                            if (task.durable && task.terminal && interruptedStatuses.includes(task.status) && ciEvidence(task.id)?.callback)
                                rememberRecovery(key, task.id, false, task.endedAt);
                        };
                        for (const task of tasks) capture(task);
                        const enabled = recoveryEnabled();
                        if (!enabled && recoveryCandidates.size) invalidateRecovery();
                        // A replacement daemon may not have seen the short-lived terminal
                        // snapshot. Reuse the bounded, exact-recipient history read.
                        const historyKey = JSON.stringify([key, recoveryInput.outcome.id]);
                        const historyDue = recoveryHistory.get(historyKey) ?? 0;
                        if (enabled && historyDue !== Infinity && ![...recoveryCandidates.values()].some(item => item.owner === key)) {
                            if (historyDue >= 0 && historyDue <= Date.now()) {
                                recoveryHistory.set(historyKey, -1); // pending
                                if (recoveryHistory.size > 128) recoveryHistory.delete(recoveryHistory.keys().next().value!);
                                void observe({ background: true, backgroundHistory: true, ...origin,
                                    endedAfter: Date.now() - recoveryWindowMs, statuses: interruptedStatuses, limit: 32 }).then(history => {
                                    if (!recoveryHistory.has(historyKey)) return;
                                    if (history.status === 'ready') for (const { meta } of history.rows) capture(meta);
                                    recoveryHistory.set(historyKey, history.status === 'ready' ? Infinity : Date.now() + 3000);
                                }).catch(() => { if (recoveryHistory.has(historyKey)) recoveryHistory.set(historyKey, Date.now() + 3000); });
                            }
                            const retry = Math.max(1000, historyDue - Date.now());
                            retryAfterMs = Math.min(retryAfterMs ?? retry, retry);
                        }
                        const liveRuns = new Set(tasks.filter(task => task.active).map(task => ciEvidence(task.id)?.run)
                            .filter(Boolean).map((run: any) => `${run.repo}:${run.runId}:${run.attempt}`));
                        for (const [index, candidate] of recoveryCandidates) {
                            if (candidate.until < Date.now()) { recoveryCandidates.delete(index); continue; }
                            if (candidate.owner !== key) continue;
                            const evidence = ciEvidence(candidate.id);
                            if (!evidence || !candidate.direct && !evidence.callback) { recoveryCandidates.delete(index); continue; }
                            if (liveRuns.has(`${evidence.run.repo}:${evidence.run.runId}:${evidence.run.attempt}`)) continue;
                            if (!enabled) {
                                retryAfterMs = Math.min(retryAfterMs ?? 5000, 5000);
                                continue;
                            }
                            let check;
                            try { check = recovery.inspect(evidence, recoveryInput); }
                            catch { continue; /* Do not replace unreadable intervention history. */ }
                            if (check.status !== 'ready') {
                                if (check.status === 'checking') retryAfterMs = Math.min(retryAfterMs ?? 1000, 1000);
                                else if (check.status === 'unverified') retryAfterMs = Math.min(retryAfterMs ?? 15000, 15000);
                                else recoveryCandidates.delete(index);
                                continue;
                            }
                            const { repo, runId, attempt } = evidence.run;
                            const receiptId = recovery.receiptId(evidence);
                            const args = runViewArgs(evidence.run).slice(0, 5).concat(['--attempt', String(attempt), '--json', 'status,jobs']);
                            const content = [`Supervisor: the local watcher ${evidence.inspection.status}; GitHub run ${repo}/${runId} attempt ${attempt} is ${check.stage.status}.`,
                                `Read the latest stage with \`gh ${args.join(' ')}\`, then resume observation of that same run. Do not dispatch or rerun it.`,
                                ...(check.stage.steps.length ? [`Last observed steps: ${check.stage.steps.map(step => JSON.stringify(step)).join(', ')}.`] : [])].join('\n');
                            const notification = { origin, taskId: candidate.id, operationId: evidence.operation.operationId,
                                branchId: evidence.operation.owner.branchId, outcomeId: outcome?.id, validUntil: check.checkedAt + recoveryFreshMs, urgent: true,
                                event: { source: 'background-task', id: receiptId, inspectId: candidate.id, label: 'CI observation recovery',
                                    status: 'observation interrupted', customType: ci.supervisorRecoveryType, content, detailTool: 'bg_task_status' } };
                            liveAlerts.set(receiptId, notification);
                            if (![...deliveries.values()].some(item => item.receiptId === receiptId)) {
                                notifyParent(notification, { receiptId, delivered: () => recovery.delivered(evidence), defer: () => undefined });
                            }
                        }
                    }
                    for (const [token, item] of deliveries) {
                        if (ownerKey(item.scope.owner) !== key) continue;
                        let notification = item.notification;
                        if (isAttentionDelivery(item)) {
                            if (item.notification.branchId && !record.branchIds.includes(item.notification.branchId)) continue;
                            notification = liveAlerts.get(item.receiptId);
                            if (!notification) { deliveries.delete(token); continue; }
                            // Two frontends can share a session and branch. Only the holder may hand off
                            // each alert. A survivor polls again at lease expiry if no receipt arrives.
                            if (!sameNativeHost(item, record)) {
                                const remaining = Math.max(1, item.createdAt + deliveryLeaseMs - Date.now());
                                retryAfterMs = Math.min(retryAfterMs ?? remaining, remaining);
                                continue;
                            }
                        }
                        outgoing.push({ token, notification, receiptId: item.receiptId });
                    }
                    traceHandoff('poll-return', { sessionId: record.owner.sessionId, total: outgoing.length, deliveries: outgoing.slice(0, 8).map(item => ({ taskId: item.notification.taskId, receiptId: item.receiptId })) });
                    return { ...projection, tasks, retryAfterMs, recoveryPending: service.hasPendingParentCallbackRecovery(), deliveries: outgoing };
                }
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
                if (record.tool === '__background_log') {
                    const owned = service.readDurableTaskLog(origin, record.params.id, record.params.lines);
                    if (owned) return owned;
                    const snapshot = await observe?.({background: true, ...origin, id: record.params.id});
                    if (snapshot?.status !== 'ready') throw new Error('Background task observation unavailable; retry after recovery');
                    const task = snapshot.rows.find((row: any) => row.meta.id === record.params.id)?.meta;
                    if (!task?.readOnly || task.parentRecipient?.branchId && !record.branchIds.includes(task.parentRecipient.branchId))
                        throw new Error('Background task is outside the captured scope');
                    const count = Math.max(1, Math.min(200, Number(record.params.lines) || 40));
                    let truncated = false;
                    const tail = (path: string) => {
                        const fd = openSync(path, 'r');
                        try {
                            const size = fstatSync(fd).size, bytes = Math.min(size, 65536);
                            truncated ||= size > bytes;
                            const buffer = Buffer.alloc(bytes); const read = readSync(fd, buffer, 0, bytes, size - bytes);
                            return buffer.subarray(0, read).toString('utf8').split('\n').slice(-count).join('\n');
                        } finally { closeSync(fd); }
                    };
                    return {taskId: task.id, status: task.status, stdout: tail(task.logPaths.stdout),
                        stderr: tail(task.logPaths.stderr), events: tail(task.logPaths.events), truncated};
                }
                if (record.tool === '__background_stop')
                    return service.stopDurableTask(origin, record.params.id);
                if (record.tool === '__background_dismiss')
                    return service.dismissDurableTask(origin, record.params.id);
                const tool = session.extensionRunner.getToolDefinition(record.tool);
                if (!tool || (record.parametersDigest !== authority.backgroundParametersDigest(tool.parameters)
                    && record.parametersDigest !== authority.backgroundDigest(tool.parameters)))
                    throw new Error('capability-mismatch: Background tool schema');
                if (!Check(tool.parameters, record.params))
                    throw new Error('Invalid Background tool parameters');
                const mutation = !['bg_task_list', 'bg_task_status', 'bg_task_log', 'bg_task_wait_list', 'bg_status'].includes(record.tool);
                const admission = ['bg_task_spawn', 'bg_task_spawn_batch', 'bg_task_watch', 'bg_task', 'wait_for_operations'].includes(record.tool);
                const prior = journal.read(key, record.key);
                if (admission && draining() && !prior)
                    throw new Error('runtime-draining: new Background execution deferred for upgrade');
                if (mutation) {
                    const accepted = journal.accept(key, record.key, authority.backgroundDigest({ tool: record.tool, params: record.params }),
                        { instance, pid: record.pid, start: record.start });
                    if (accepted.prior)
                        return accepted.record.result ?? { content: [{ type: 'text', text: 'Accepted Background request has an uncertain outcome; inspect its exact operations before issuing new work.' }], details: { status: 'outcome_unknown', operations: accepted.record.operations } };
                    journal.dispatch(key, record.key);
                    onAccepted?.(`background-request-v1:${authority.backgroundDigest([key, record.key])}`);
                }
                assertAdmission();
                let result;
                try {
                    trace?.(slot, 'tool-pending');
                    result = await tool.execute(record.key, record.params, undefined, undefined, ctx);
                    trace?.(slot, 'tool-returned');
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
            }).catch(error => {
                traceHandoff('request-error', { tool: current?.record.tool, sessionId: current?.record.owner.sessionId, error: String(error).slice(0, 256) });
                throw error;
            }).finally(() => { pending--; trace?.(slot, 'settled'); });
            tail = request;
            return request;
        },
        async close() { await tail.catch(() => undefined); recoveryHistory.clear(); await recovery.close(); for (const item of deliveries.values())
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
