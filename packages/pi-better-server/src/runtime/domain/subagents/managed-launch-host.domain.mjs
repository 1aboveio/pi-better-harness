// Generated fixed launch domain from packages/pi-better-subagents/managed-launch-host.ts. Do not edit directly.
import { createHash, timingSafeEqual } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { verifyParkCheckpoint } from "./park-checkpoint.domain.mjs";
import { intersectContinuationPermissions } from "./continuation-authority.domain.mjs";
import extension from "./index.domain.mjs";
import { bindRuntimeOutcomeStore } from "./assignment-outcomes.domain.mjs";
import { catalogSnapshotFromWire } from "./catalog-store.domain.mjs";
import { openLaunchJournal, launchDigest } from "./managed-launch-journal.mjs";
import { baseDir, nextRunId, processStartToken, listMetas, writeMeta, listActiveMetasForParent, effectiveStatus, readMeta, readParkRecord, updateParkRecord } from "./registry.domain.mjs";
import { recoverLaunchMetadata } from "./managed-launch-recovery.domain.mjs";
import { assertSubagentHandoff } from "./managed-launch-ownership.domain.mjs";
import { createOwnerCapacityGates } from "./capacity.mjs";
import { readConversationLease, releaseUnspawnedConversationLease } from "./continuation.domain.mjs";
import { Worker } from "node:worker_threads";
import { processExists } from "./spawn.domain.mjs";
// Revocation only: the journal remains the authority. A new same-process
// manager revokes a previous worker before advancing the journal epoch.
const failureFoldRevocations = new Map();
/** One fixed SDK adapter per runtime, not a client-selected module or transcript writer. */
export class ManagedSubagentHost {
    root;
    instance;
    catalog;
    createWorkerHost;
    readPermissions;
    verificationMs;
    enterControl;
    foldRevocation = new Int32Array(new SharedArrayBuffer(4));
    failureWorker;
    failureWorkerError;
    failureResponse;
    current;
    api;
    session;
    initializing;
    tail = Promise.resolve();
    journal;
    closeJournal;
    epoch;
    pending = 0;
    requestSequence = 0;
    requestRecords = new Map();
    foldRecord;
    acceptedRequestLive = false;
    continuationWindow = { started: 0, admitted: 0 };
    continuationFailures = new Map();
    workerHost;
    path;
    known = new Map();
    healthClose;
    healthChanged;
    lifecycleMetrics = { passes: 0, entities: 0, deadlineLatenessMs: 0 };
    healthDue = new Map();
    writerProofs = new Map();
    lifecycleReasons() {
        const now = Date.now();
        const writers = [...this.known.values()].filter(meta => ["running", "orphaned"].includes(meta.status)).flatMap(meta => {
            const proof = this.writerProofs.get(meta.id);
            if (!proof || !proof.verified && now >= proof.unknownSince + this.verificationMs)
                return [];
            return [{
                    kind: proof.verified ? "worker" : "verification", id: meta.id, owner: meta.callbackOrigin, writer: { pid: meta.pid, start: meta.pidStartTime },
                    management: meta.management, lastProgressAt: meta.timing?.lastProgressAt ?? meta.startedAt,
                    nextDeadline: proof.verified ? this.healthDue.get(meta.id) ?? null : proof.unknownSince + this.verificationMs,
                    recovery: proof.verified ? "current-managed-writer-supervision" : "writer-unverified-no-takeover",
                }];
        });
        return [...this.requestRecords.values(), ...(this.foldRecord ? [{ ...this.foldRecord }] : []),
            ...(this.acceptedRequestLive ? this.journal.lifecycleReasons(this.current.ownerKey, this.current.key) : []).map(reason => ({ ...reason,
                management: { ...reason.management, instance: this.instance }, writerFence: 'current-managed-launch-epoch' })),
            ...writers, ...(this.workerHost?.advancingWaits?.() ?? [])];
    }
    observeHealth(reconcile) {
        this.healthClose?.();
        let closed = false, scheduled = false;
        let timer;
        const watchers = [], dirty = new Set(this.known.keys()), signatures = new Map();
        const signature = (meta) => {
            let log = "missing";
            try {
                const info = statSync(meta.logPath, { bigint: true });
                log = `${info.ino}:${info.size}:${info.mtimeNs}`;
            }
            catch { /* No log yet. */ }
            return JSON.stringify(meta) + log;
        };
        const schedule = () => {
            if (closed || scheduled)
                return;
            scheduled = true;
            setImmediate(() => { scheduled = false; if (!closed)
                pass(); });
        };
        const hint = (id) => {
            const meta = readMeta(id);
            if (meta?.management?.root === this.root && meta.management.instance === this.instance && meta.management.epoch === this.epoch) {
                if (signatures.get(id) === signature(meta))
                    return;
                if (!this.writerProofs.has(id))
                    this.writerProofs.set(id, { verified: false, checkedAt: Date.now(), unknownSince: Date.now() });
                this.known.set(id, meta);
                dirty.add(id);
                schedule();
            }
        };
        this.healthChanged = hint;
        const pass = () => {
            const now = Date.now();
            for (const [id, due] of this.healthDue)
                if (due <= now)
                    dirty.add(id);
            const ids = [...dirty].slice(0, 32);
            ids.forEach(id => dirty.delete(id));
            if (ids.length) {
                const release = this.enterControl?.();
                if (this.enterControl && !release) {
                    ids.forEach(id => dirty.add(id));
                    timer = setTimeout(schedule, 1000);
                    timer.unref();
                    return;
                }
                this.lifecycleMetrics.passes++;
                this.lifecycleMetrics.entities += ids.length;
                for (const id of ids)
                    this.lifecycleMetrics.deadlineLatenessMs = Math.max(this.lifecycleMetrics.deadlineLatenessMs, now - (this.healthDue.get(id) ?? now));
                try {
                    reconcile(ids);
                }
                finally {
                    release?.();
                }
                for (const id of ids) {
                    const meta = readMeta(id);
                    if (meta)
                        this.known.set(id, meta);
                    else
                        this.known.delete(id);
                    if (meta)
                        signatures.set(id, signature(meta));
                    this.healthDue.delete(id);
                    if (!meta || !["running", "orphaned"].includes(meta.status)) {
                        this.writerProofs.delete(id);
                        if (meta?.completionCallbackPendingAt && !meta.completionCallbackSentAt && !meta.completionCallbackSuppressedAt)
                            this.healthDue.set(id, now + 15000);
                        else {
                            this.known.delete(id);
                            signatures.delete(id);
                        }
                        continue;
                    }
                    const verified = Boolean(meta.pidStartTime && processStartToken(meta.pid) === meta.pidStartTime && processExists(meta.pid));
                    const prior = this.writerProofs.get(id);
                    this.writerProofs.set(id, { verified, checkedAt: now, unknownSince: verified ? now : prior?.unknownSince ?? now });
                    const timing = meta.timing;
                    const deadlines = [now + 15000, timing?.ceilingAt,
                        !timing?.deadlineWakeSentAt ? timing?.deadlineAt : undefined,
                        timing?.steerDeliveredAt ? timing.steerDeliveredAt + timing.graceMs : undefined]
                        .filter((value) => typeof value === "number" && value > now);
                    this.healthDue.set(id, Math.min(...deadlines));
                }
            }
            if (dirty.size)
                schedule();
            if (timer)
                clearTimeout(timer);
            if (this.healthDue.size) {
                const next = [...this.healthDue.values()].reduce((a, b) => Math.min(a, b), Infinity);
                timer = setTimeout(schedule, Math.max(1, next - Date.now()));
                timer.unref();
            }
        };
        try {
            mkdirSync(join(baseDir(), "runs"), { recursive: true });
            const watcher = watch(join(baseDir(), "runs"), { recursive: true }, (_event, file) => {
                const id = file && String(file).split(/[/\\]/)[0];
                if (id && /^[A-Za-z0-9_-]+$/.test(id))
                    hint(id);
            });
            watcher.on("error", () => watcher.close());
            watchers.push(watcher);
        }
        catch { /* Known active writers still have independent liveness deadlines. */ }
        schedule();
        return this.healthClose = () => {
            closed = true;
            if (timer)
                clearTimeout(timer);
            watchers.forEach(watcher => watcher.close());
            this.healthChanged = undefined;
            this.healthDue.clear();
        };
    }
    capacityFor = createOwnerCapacityGates(({ pid, start }) => listActiveMetasForParent(pid).filter(meta => meta.spawnPidStartTime === start && effectiveStatus(meta) === "running").length
        + this.journal.unresolvedAttempts().filter((attempt) => attempt.capacityOwner?.pid === pid && attempt.capacityOwner?.start === start && !readMeta(attempt.id)).length);
    get busy() { return this.pending > 0 || Boolean(this.failureResponse); }
    status() {
        return { owner: "server", instanceId: this.instance, runtimeEpoch: this.epoch,
            lifecycle: { ...this.lifecycleMetrics, activeDeadlines: this.healthDue.size },
            inFlight: this.pending, failureFold: { worker: Boolean(this.failureWorker), inFlight: Boolean(this.failureResponse) }, continuationReady: this.workerHost?.service.continuationReady ?? false, continuationUnavailable: [...this.continuationFailures].map(([key, value]) => ({ key, ...value })), unresolvedAttempts: this.journal.unresolvedAttempts().filter((attempt) => !readMeta(attempt.id)).length };
    }
    constructor(root, instance, catalog, sharedStore, createWorkerHost, readPermissions, verificationMs = 30000, enterControl) {
        this.root = root;
        this.instance = instance;
        this.catalog = catalog;
        this.createWorkerHost = createWorkerHost;
        this.readPermissions = readPermissions;
        this.verificationMs = verificationMs;
        this.enterControl = enterControl;
        this.current = { pid: process.pid, start: processStartToken(process.pid), owner: { workspace: root, sessionId: "runtime-recovery" } };
        this.path = join(root, "operation-coordinator.sqlite");
        const active = listMetas({ includeArchived: false });
        assertSubagentHandoff(active, root);
        const opened = openLaunchJournal(this.path, sharedStore);
        this.journal = opened.journal;
        const unbind = sharedStore ? bindRuntimeOutcomeStore(root, sharedStore) : () => { };
        this.closeJournal = () => { try {
            unbind();
        }
        finally {
            opened.close();
        } };
        try {
            for (const meta of active) {
                if (meta.management?.root !== root || !processExists(meta.pid) || processStartToken(meta.pid) !== meta.pidStartTime)
                    continue;
                const attempt = this.journal.attempt(meta.id), lease = readConversationLease(meta.sessionId);
                if (!attempt || attempt.sessionId !== meta.sessionId || !lease || lease.token !== attempt.lease || lease.attemptId !== meta.id) {
                    throw new Error(`writer-authority-unknown: ${meta.id}`);
                }
            }
            const priorFold = failureFoldRevocations.get(root);
            if (priorFold)
                Atomics.store(priorFold, 0, 1);
            this.epoch = this.journal.epoch(instance);
            failureFoldRevocations.set(root, this.foldRevocation);
            // An unpublished reservation cannot have dispatched task code. Release
            // only a proven-dead manager's claim before SDK reconciliation sees it.
            for (const claim of sharedStore?.listResumeClaims() ?? []) {
                if (!["claimed", "published"].includes(claim.state) || !/^(managed-)?subagents:/.test(claim.lease?.ownerId ?? ""))
                    continue;
                const pid = claim.lease.pid;
                if (!pid)
                    continue;
                if (processExists(pid) && (!claim.lease.processStartToken || Buffer.from(processStartToken(pid) ?? "").toString("base64url") === claim.lease.processStartToken || !processStartToken(pid)))
                    continue;
                if (claim.state === "published") {
                    // This fixed adapter journals before spawning. Its exact old
                    // manager is dead and its epoch fenced; absence of a journal
                    // intent proves this publication never dispatched a child.
                    if (!claim.attemptId || this.journal.attempt(claim.attemptId) || readMeta(claim.attemptId))
                        continue;
                    const wait = sharedStore.getWait({ waitId: claim.waitId, generation: claim.generation });
                    const prior = wait?.park?.attemptId ? readMeta(wait.park.attemptId) : undefined;
                    const park = prior ? readParkRecord(prior.id) : undefined;
                    if (!prior || prior.management?.root !== root || claim.lease.ownerId !== `managed-subagents:${prior.management.instance}` || !park?.checkpoint)
                        continue;
                    if (readConversationLease(prior.sessionId) && (!claim.lease.processStartToken || !releaseUnspawnedConversationLease({
                        sessionId: prior.sessionId, attemptId: claim.attemptId, managerPid: pid, managerStart: claim.lease.processStartToken,
                        canProveUnspawned: () => { this.journal.current(this.epoch); return !this.journal.attempt(claim.attemptId) && !readMeta(claim.attemptId); },
                    })))
                        continue;
                    verifyParkCheckpoint({ ...park.checkpoint, version: 1, waitId: claim.waitId, generation: claim.generation });
                    const result = sharedStore.repairFailedResume({ waitId: claim.waitId, generation: claim.generation,
                        claimId: claim.claimId, claimToken: claim.claimToken, attemptId: claim.attemptId, launchToken: claim.launchToken,
                        proof: { writerPidGone: true, writerLeaseReleased: true }, checkpointId: wait.park.checkpointId,
                        expectedCancelEpoch: wait.cancelEpoch, reason: "Exact managed publication never reached pre-spawn journal" });
                    updateParkRecord(prior.id, { phase: result.phase, resumeExitReconciledClaimId: claim.claimId });
                    continue;
                }
                sharedStore.releaseResumeClaim({ waitId: claim.waitId, generation: claim.generation,
                    claimId: claim.claimId, claimToken: claim.claimToken, outcome: "ready",
                    reason: "Recovered unpublished reservation after exact manager exit" });
            }
            for (const attempt of this.journal.unresolvedAttempts()) {
                if (readMeta(attempt.id))
                    continue;
                const meta = recoverLaunchMetadata(attempt, { root, instance, epoch: this.epoch }, {
                    pidExists: processExists, startToken: processStartToken, lease: readConversationLease,
                });
                writeMeta(meta, { ifAbsent: true });
                active.push(meta);
            }
            for (const intent of this.journal.pendingIntents()) {
                this.journal.finishRecovery(intent.owner, intent.request_key, this.epoch, this.recoveredResult(intent));
            }
            for (const meta of active) {
                if (meta.management?.root !== root || (meta.status !== "running" && meta.status !== "orphaned"))
                    continue;
                writeMeta({ ...meta, management: { root, instance, epoch: this.epoch },
                    supervisionInterruptedAt: meta.supervisionInterruptedAt ?? Date.now(), supervisionInterruptedReason: "runtime-recovery" });
            }
        }
        catch (error) {
            Atomics.store(this.foldRevocation, 0, 1);
            if (failureFoldRevocations.get(root) === this.foldRevocation)
                failureFoldRevocations.delete(root);
            this.closeJournal();
            throw error;
        }
    }
    async recover() {
        for (const meta of listMetas({ includeArchived: false }))
            if (meta.management?.root === this.root) {
                this.known.set(meta.id, meta);
                this.writerProofs.set(meta.id, { verified: false, checkedAt: Date.now(), unknownSince: Date.now() });
            }
        if (listMetas({ includeArchived: false }).some(meta => meta.management?.root === this.root))
            await this.initialize();
    }
    grant(authority) {
        if (!authority || !/^[a-f0-9-]{36}$/.test(authority.id) || !/^[a-f0-9]{64}$/.test(authority.secret))
            throw new Error("launch-authority-refused");
        const directory = join(this.root, "subagent-launch-admission"), path = join(directory, `${authority.id}.json`);
        const dir = lstatSync(directory), stat = lstatSync(path);
        if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || (dir.mode & 0o077)
            || !stat.isFile() || stat.isSymbolicLink() || stat.uid !== dir.uid || (stat.mode & 0o077) || stat.size > 1024 * 1024)
            throw new Error("launch-authority-refused");
        const record = JSON.parse(readFileSync(path, "utf8"));
        const digest = createHash("sha256").update(authority.secret).digest("hex");
        if (record.version !== 1 || record.instanceId !== this.instance || record.id !== authority.id || typeof record.secretHash !== "string"
            || record.secretHash.length !== digest.length || !timingSafeEqual(Buffer.from(record.secretHash), Buffer.from(digest))
            || !record.owner?.sessionId
            || !Number.isSafeInteger(record.pid)
            || !["subagent_spawn", "subagent_spawn_batch"].includes(record.tool) || typeof record.key !== "string" || !record.key)
            throw new Error("launch-authority-refused");
        if (record.owner.workspace !== realpathSync(record.owner.workspace))
            throw new Error("launch-authority-refused: noncanonical workspace");
        if (!record.start)
            throw new Error("launch-authority-refused: host process start identity unavailable");
        const start = processStartToken(record.pid);
        if (!start)
            throw new Error("launch-authority-refused: server cannot verify host process start identity");
        if (start !== record.start)
            throw new Error("launch-authority-refused: host process identity changed");
        process.kill(record.pid, 0);
        return record;
    }
    initialize() {
        return this.initializing ??= (async () => {
            const host = this;
            const port = {
                observeHealth: reconcile => host.observeHealth(reconcile),
                backgroundTools: () => host.current.background?.available === true ? host.current.background.tools : [],
                get owner() { return { pid: host.current.pid, start: host.current.start }; },
                get identity() { return { root: host.root, instance: host.instance, epoch: host.epoch }; },
                continuationContext: () => host.executionContext(host.current),
                dispatchContinuation: (park, run) => host.dispatchContinuation(park, run),
                supervised: () => [...host.known.values()].filter(meta => port.owns(meta)),
                owns: meta => meta.management?.root === host.root && meta.management?.instance === host.instance && meta.management?.epoch === host.epoch,
                assertCurrent: () => host.journal.current(host.epoch),
                capacity: () => host.capacityFor(host.current),
                attempt: () => nextRunId(),
                workerCommand: args => ({ file: process.execPath, fileArgs: [fileURLToPath(new URL("./managed-worker.mjs", import.meta.url)), ...args] }),
                snapshot: async (configuration) => {
                    const command = host.catalog.connection();
                    command({ type: "runtime_register_catalog", cwd: host.current.owner.workspace,
                        sessionId: host.current.owner.sessionId, authority: host.current.catalogAuthority });
                    return catalogSnapshotFromWire(command({ type: "runtime_get_catalog", overlay: configuration.getSessionSettings?.() ?? configuration.sessionSettings }));
                },
                beforeSpawn: input => {
                    assertSubagentHandoff(listMetas({ includeArchived: false }), host.root);
                    if (host.current.continuation) {
                        const permissions = intersectContinuationPermissions(host.current.capturedPermissions, host.readPermissions?.());
                        if (launchDigest(permissions) !== launchDigest(host.current.permissions))
                            throw new Error("continuation-permissions-changed");
                        host.current.key = `${host.current.baseKey}:${input.id}`;
                        host.current.digest = launchDigest({ key: host.current.key, runId: host.current.priorRunId });
                        host.journal.accept(host.current.ownerKey, host.current.key, host.current.digest, host.epoch);
                    }
                    else {
                        const fresh = host.grant(host.current.authority);
                        if (launchDigest(fresh) !== host.current.grantDigest)
                            throw new Error("launch-authority-changed");
                    }
                    const preflightDigest = launchDigest(JSON.parse(readFileSync(input.preflightPath, "utf8")));
                    const policyDigest = input.policyPath ? launchDigest(JSON.parse(readFileSync(input.policyPath, "utf8"))) : undefined;
                    const attempt = host.journal.prepare(host.current.ownerKey, host.current.key, host.epoch, { ...input, preflightDigest, policyDigest,
                        capacityOwner: { pid: host.current.pid, start: host.current.start },
                        launchAuthority: host.current.launchAuthority ?? { owner: host.current.owner, pid: host.current.pid, start: host.current.start, settings: host.current.settings, model: host.current.model, projectTrusted: host.current.projectTrusted, background: host.current.background, permissions: host.current.permissions } });
                    return { PI_MANAGED_SUBAGENT: JSON.stringify({ path: host.path, owner: host.current.ownerKey,
                            key: host.current.key, epoch: host.epoch, id: input.id, token: attempt.token }) };
                },
                spawned: (id, pid) => { host.journal.spawned(host.current.ownerKey, host.current.key, host.epoch, id, pid, processStartToken(pid)); setImmediate(() => host.healthChanged?.(id)); },
            };
            const cwd = this.root;
            const settingsManager = SettingsManager.inMemory({});
            const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: this.root, settingsManager,
                noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
                extensionFactories: [(pi) => {
                        const registered = [];
                        const adapterPi = { ...pi,
                            registerTool: (tool) => { registered.push(tool); pi.registerTool(tool); },
                            getAllTools: () => [...registered, ...pi.getAllTools()], };
                        this.api = adapterPi;
                        this.workerHost = this.createWorkerHost?.(adapterPi);
                        if (this.workerHost)
                            pi.on("session_start", (_event, ctx) => this.workerHost.start(ctx));
                        extension(adapterPi, port);
                    }] });
            await resourceLoader.reload();
            const created = await createAgentSession({ cwd, agentDir: this.root, settingsManager, resourceLoader,
                sessionManager: SessionManager.inMemory(cwd), noTools: "all" });
            this.session = created.session;
            const initializationErrors = [];
            await this.session.bindExtensions({ mode: "print", onError: (error) => {
                    if (!initializationErrors.length)
                        initializationErrors.push(String(error.error ?? error.message ?? error));
                } });
            if (initializationErrors.length)
                throw new Error(`Managed launch initialization failed: ${initializationErrors.join("; ")}`);
        })();
    }
    executionContext(record) {
        const ctx = this.session.extensionRunner.createContext();
        const branch = [...record.settings, ...(record.owner.goalId ? [{ type: "custom", customType: "pi-better-goal", data: { kind: "set", goal: { goalId: record.owner.goalId } } }] : []), { id: record.owner.branchId }];
        const model = record.model?.split("/");
        return { ...ctx, cwd: record.owner.workspace, hasUI: false, isProjectTrusted: () => record.projectTrusted,
            model: model ? ctx.modelRegistry.find(model[0], model.slice(1).join("/")) : undefined,
            sessionManager: { getSessionId: () => record.owner.sessionId, getBranch: () => branch, getLeafId: () => record.owner.branchId,
                getSessionFile: () => undefined, getEntries: () => branch } };
    }
    dispatchContinuation(park, run) {
        const now = Date.now();
        if (now - this.continuationWindow.started >= 1000)
            this.continuationWindow = { started: now, admitted: 0 };
        if (this.continuationWindow.admitted >= 32)
            return Promise.resolve("skipped");
        const retryKey = `${park.waitId}:${park.generation}`;
        const failure = this.continuationFailures.get(retryKey);
        if (failure && Date.now() < failure.retryAt)
            return Promise.resolve("skipped");
        this.continuationWindow.admitted++;
        this.pending++;
        const requestId = ++this.requestSequence;
        this.requestRecords.set(requestId, { kind: 'continuation-request', id: requestId, waitId: park.waitId, runId: park.runId,
            generation: park.generation, lastProgressAt: now, executionDeadline: null, nextDeadline: null,
            recovery: 'captured-continuation-serialized-by-current-launch-journal-owner' });
        const result = this.tail.catch(() => undefined).then(async () => {
            const saved = this.journal.attempt(park.runId)?.launchAuthority;
            if (!saved)
                throw new Error("Captured continuation launch authority unavailable");
            const permissions = intersectContinuationPermissions(saved.permissions, this.readPermissions?.());
            const key = `continuation:${park.waitId}:${park.generation}`;
            this.current = { ...saved, key, baseKey: key, priorRunId: park.runId, continuation: true, launchAuthority: saved,
                capturedPermissions: saved.permissions, permissions,
                ownerKey: JSON.stringify([saved.owner.workspace, saved.owner.sessionId]),
                digest: launchDigest({ key, runId: park.runId }) };
            this.acceptedRequestLive = true;
            this.api.events.emit("pi-better-sandbox:policy", { state: "enabled", ...permissions });
            const outcome = await run();
            if (outcome === "resumed")
                this.journal.finish(this.current.ownerKey, this.current.key, this.epoch, { status: outcome });
            this.continuationFailures.delete(retryKey);
            return outcome;
        }).catch(error => {
            const failures = Math.min(6, (this.continuationFailures.get(retryKey)?.failures ?? 0) + 1);
            if (this.continuationFailures.size >= 128 && !this.continuationFailures.has(retryKey))
                this.continuationFailures.delete(this.continuationFailures.keys().next().value);
            this.continuationFailures.set(retryKey, { failures, retryAt: Date.now() + Math.min(30000, 1000 * 2 ** (failures - 1)), reason: String(error).slice(0, 500) });
            return "skipped";
        }).finally(() => { this.requestRecords.delete(requestId); this.acceptedRequestLive = false; this.pending--; });
        this.tail = result;
        return result;
    }
    recoveredResult(intent) {
        const ids = JSON.parse(intent.attempts).map(({ id }) => id);
        const runs = ids.map((id) => readMeta(id));
        const status = !ids.length ? "not_launched" : runs.every(Boolean) ? "recovered" : "outcome_unknown";
        return { details: { status, attempts: ids, runs: runs.filter(Boolean).map((meta) => ({
                    runId: meta.id, sessionId: meta.sessionId, status: meta.status,
                })) }, content: [{ type: "text", text: `Original launch ${status}; no replacement attempt was dispatched.` }] };
    }
    handle(command, onAccepted) {
        if (Object.keys(command).some(key => !["id", "type", "authority"].includes(key)))
            return Promise.reject(new Error("unsupported launch field"));
        this.pending++;
        const requestId = ++this.requestSequence;
        this.requestRecords.set(requestId, { kind: 'launch-request', id: requestId, phase: 'queued-unaccepted',
            lastProgressAt: Date.now(), executionDeadline: null, nextDeadline: null,
            recovery: 'validate-captured-native-authority-before-admission-no-detached-execution-lease' });
        const result = this.tail.catch(() => undefined).then(async () => {
            const record = this.grant(command.authority);
            // A retried tool call keeps its accepted recipient even after Goal/branch edits.
            const ownerKey = JSON.stringify([record.owner.workspace, record.owner.sessionId]);
            const digest = launchDigest({ tool: record.tool, params: record.params });
            const intent = this.journal.accept(ownerKey, record.key, digest, this.epoch);
            onAccepted?.(`launch-progress:${launchDigest([ownerKey, record.key])}`);
            this.requestRecords.set(requestId, { ...this.requestRecords.get(requestId), phase: 'accepted',
                operation: `launch-progress:${launchDigest([ownerKey, record.key])}`, lastProgressAt: Date.now() });
            if (intent.prior) {
                if (intent.result)
                    return JSON.parse(intent.result);
                return this.recoveredResult(intent);
            }
            try {
                this.current = { ...record, authority: command.authority, ownerKey, grantDigest: launchDigest(record) };
                this.acceptedRequestLive = true;
                await this.initialize();
                this.api.events.emit("pi-better-sandbox:policy", { state: "enabled", ...record.permissions });
                const context = this.executionContext(record);
                const tool = this.session.extensionRunner.getToolDefinition(record.tool);
                if (!tool)
                    throw new Error("Fixed subagent adapter unavailable");
                const response = await tool.execute(record.key, record.params, undefined, undefined, context);
                this.journal.finish(ownerKey, record.key, this.epoch, response);
                return response;
            }
            catch (error) {
                const pending = this.journal.read(ownerKey, record.key);
                if (pending?.state === "accepted" && JSON.parse(pending.attempts).length === 0) {
                    this.journal.finish(ownerKey, record.key, this.epoch, this.recoveredResult(pending));
                }
                throw error;
            }
        }).finally(() => { this.requestRecords.delete(requestId); this.acceptedRequestLive = false; this.pending--; });
        this.tail = result;
        return result;
    }
    /** One root mechanical worker; no coordinator connection or query mutations. */
    foldTerminalFailures(ids) {
        let release;
        let physicalExit;
        const result = this.tail.catch(() => undefined).then(async () => {
            release = this.enterControl?.();
            if (this.enterControl && !release)
                throw new Error("runtime-overloaded: failure fold source capacity");
            this.journal.current(this.epoch);
            if (Atomics.load(this.foldRevocation, 0))
                throw new Error("failure-fold-owner-revoked");
            if (this.failureWorkerError)
                throw this.failureWorkerError;
            if (ids.length > 128)
                throw new Error("failure-fold-batch-overflow");
            if (!this.failureWorker) {
                const worker = this.failureWorker = new Worker(new URL("./managed-failure-worker.mjs", import.meta.url), {
                    execArgv: [], workerData: { root: this.root, epoch: this.epoch, revocation: this.foldRevocation.buffer },
                });
                const fail = (error) => {
                    this.failureWorkerError = error;
                    this.failureResponse?.reject(error);
                    this.failureResponse = undefined;
                };
                worker.on("message", message => {
                    const response = this.failureResponse;
                    this.failureResponse = undefined;
                    if (message.error)
                        response?.reject(new Error(message.error));
                    else
                        response?.resolve();
                });
                worker.on("error", fail);
                worker.on("exit", code => fail(new Error(`failure-fold-worker-exited: ${code}`)));
                worker.unref();
            }
            let timer;
            try {
                await new Promise((resolve, reject) => {
                    this.failureResponse = { resolve, reject };
                    this.foldRecord = { kind: 'failure-fold', ids: [...ids], lastProgressAt: Date.now(), nextDeadline: Date.now() + this.verificationMs,
                        recovery: 'revoke-unacknowledged-fold-generation-at-existing-verification-deadline' };
                    timer = setTimeout(() => {
                        const error = new Error("failure-fold-verification-deadline: source worker did not acknowledge");
                        Atomics.store(this.foldRevocation, 0, 1);
                        this.failureWorkerError = error;
                        this.failureResponse = undefined;
                        physicalExit = this.failureWorker?.terminate();
                        reject(error);
                    }, this.verificationMs);
                    this.failureWorker.postMessage({ ids });
                });
            }
            finally {
                this.foldRecord = undefined;
                if (timer)
                    clearTimeout(timer);
            }
        }).finally(() => {
            if (physicalExit)
                void physicalExit.then(() => release?.(), () => undefined);
            else
                release?.();
        });
        this.tail = result;
        return result;
    }
    async close() {
        this.healthClose?.();
        Atomics.store(this.foldRevocation, 0, 1);
        await this.tail.catch(() => undefined);
        await this.failureWorker?.terminate();
        this.failureWorker = undefined;
        if (failureFoldRevocations.get(this.root) === this.foldRevocation)
            failureFoldRevocations.delete(this.root);
        const session = this.session;
        this.session = undefined;
        const workerHost = this.workerHost;
        this.workerHost = undefined;
        try {
            if (session)
                await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        }
        finally {
            try {
                workerHost?.close();
            }
            finally {
                try {
                    session?.dispose();
                }
                finally {
                    this.closeJournal();
                }
            }
        }
    }
}
