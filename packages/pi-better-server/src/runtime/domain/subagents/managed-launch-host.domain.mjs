// Generated fixed launch domain from packages/pi-better-subagents/managed-launch-host.ts. Do not edit directly.
import { createHash, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import extension from "./index.domain.mjs";
import { catalogSnapshotFromWire } from "./catalog-store.domain.mjs";
import { LaunchJournal, launchDigest } from "./managed-launch-journal.mjs";
import { nextRunId, processStartToken, listMetas, writeMeta, listActiveMetasForParent, effectiveStatus, readMeta } from "./registry.domain.mjs";
import { assertSubagentHandoff } from "./managed-launch-ownership.domain.mjs";
import { createOwnerCapacityGates } from "./capacity.mjs";
import { readConversationLease } from "./continuation.domain.mjs";
import { processExists } from "./spawn.domain.mjs";
/** One fixed SDK adapter per runtime, not a client-selected module or transcript writer. */
export class ManagedSubagentHost {
    root;
    instance;
    catalog;
    current;
    api;
    session;
    initializing;
    tail = Promise.resolve();
    journal;
    epoch;
    pending = 0;
    path;
    capacityFor = createOwnerCapacityGates(({ pid, start }) => listActiveMetasForParent(pid).filter(meta => meta.spawnPidStartTime === start && effectiveStatus(meta) === "running").length
        + this.journal.unresolvedAttempts().filter((attempt) => attempt.capacityOwner?.pid === pid && attempt.capacityOwner?.start === start && !readMeta(attempt.id)).length);
    get busy() { return this.pending > 0; }
    status() {
        return { owner: "server", instanceId: this.instance, runtimeEpoch: this.epoch,
            inFlight: this.pending, unresolvedAttempts: this.journal.unresolvedAttempts().length };
    }
    constructor(root, instance, catalog) {
        this.root = root;
        this.instance = instance;
        this.catalog = catalog;
        this.current = { pid: process.pid, start: processStartToken(process.pid), owner: { workspace: root, sessionId: "runtime-recovery" } };
        this.path = join(root, "operation-coordinator.sqlite");
        const active = listMetas({ includeArchived: false });
        assertSubagentHandoff(active, root);
        this.journal = new LaunchJournal(this.path);
        for (const meta of active) {
            if (meta.management?.root !== root || !processExists(meta.pid))
                continue;
            const attempt = this.journal.attempt(meta.id), lease = readConversationLease(meta.sessionId);
            if (!attempt || attempt.sessionId !== meta.sessionId || !lease || lease.token !== attempt.lease || lease.attemptId !== meta.id) {
                this.journal.close();
                throw new Error(`writer-authority-unknown: ${meta.id}`);
            }
        }
        this.epoch = this.journal.epoch(instance);
        for (const meta of active) {
            if (meta.management?.root !== root || (meta.status !== "running" && meta.status !== "orphaned"))
                continue;
            writeMeta({ ...meta, management: { root, instance, epoch: this.epoch },
                supervisionInterruptedAt: meta.supervisionInterruptedAt ?? Date.now(), supervisionInterruptedReason: "runtime-recovery" });
        }
    }
    async recover() {
        if (listMetas({ includeArchived: false }).some(meta => meta.management?.root === this.root && ["running", "orphaned"].includes(meta.status)))
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
                get owner() { return { pid: host.current.pid, start: host.current.start }; },
                get identity() { return { root: host.root, instance: host.instance, epoch: host.epoch }; },
                supervised: () => listMetas({ includeArchived: false }).filter(meta => port.owns(meta)),
                owns: meta => meta.management?.root === host.root && meta.management?.instance === host.instance && meta.management?.epoch === host.epoch,
                assertCurrent: () => host.journal.current(host.epoch),
                capacity: () => host.capacityFor(host.current),
                attempt: () => nextRunId(),
                snapshot: async (configuration) => {
                    const command = host.catalog.connection();
                    command({ type: "runtime_register_catalog", cwd: host.current.owner.workspace,
                        sessionId: host.current.owner.sessionId, authority: host.current.catalogAuthority });
                    return catalogSnapshotFromWire(command({ type: "runtime_get_catalog", overlay: configuration.getSessionSettings?.() ?? configuration.sessionSettings }));
                },
                beforeSpawn: input => {
                    assertSubagentHandoff(listMetas({ includeArchived: false }), host.root);
                    const fresh = host.grant(host.current.authority);
                    if (launchDigest(fresh) !== host.current.grantDigest)
                        throw new Error("launch-authority-changed");
                    const preflightDigest = launchDigest(JSON.parse(readFileSync(input.preflightPath, "utf8")));
                    const policyDigest = input.policyPath ? launchDigest(JSON.parse(readFileSync(input.policyPath, "utf8"))) : undefined;
                    const attempt = host.journal.prepare(host.current.ownerKey, host.current.key, host.epoch, { ...input, preflightDigest, policyDigest,
                        capacityOwner: { pid: host.current.pid, start: host.current.start } });
                    return { PI_MANAGED_SUBAGENT: JSON.stringify({ path: host.path, owner: host.current.ownerKey,
                            key: host.current.key, epoch: host.epoch, id: input.id, token: attempt.token }) };
                },
                spawned: (id, pid) => host.journal.spawned(host.current.ownerKey, host.current.key, host.epoch, id, pid),
            };
            const cwd = this.root;
            const settingsManager = SettingsManager.inMemory({});
            const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: this.root, settingsManager,
                noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
                extensionFactories: [(pi) => { this.api = pi; extension(pi, port); }] });
            await resourceLoader.reload();
            const created = await createAgentSession({ cwd, agentDir: this.root, settingsManager, resourceLoader,
                sessionManager: SessionManager.inMemory(cwd), noTools: "all" });
            this.session = created.session;
            await this.session.bindExtensions({ mode: "print" });
        })();
    }
    handle(command) {
        if (Object.keys(command).some(key => !["id", "type", "authority"].includes(key)))
            return Promise.reject(new Error("unsupported launch field"));
        this.pending++;
        const result = this.tail.catch(() => undefined).then(async () => {
            const record = this.grant(command.authority);
            // A retried tool call keeps its accepted recipient even after Goal/branch edits.
            const ownerKey = JSON.stringify([record.owner.workspace, record.owner.sessionId]);
            const digest = launchDigest({ tool: record.tool, params: record.params });
            const intent = this.journal.accept(ownerKey, record.key, digest, this.epoch);
            if (intent.prior)
                return intent.result ? JSON.parse(intent.result) : { details: { status: "outcome_unknown", attempts: JSON.parse(intent.attempts).map(({ id }) => id) }, content: [] };
            this.current = { ...record, authority: command.authority, ownerKey, grantDigest: launchDigest(record) };
            await this.initialize();
            this.api.events.emit("pi-better-sandbox:policy", { state: "enabled", ...record.permissions });
            const ctx = this.session.extensionRunner.createContext();
            const branch = [...record.settings, ...(record.owner.goalId ? [{ type: "custom", customType: "pi-better-goal", data: { kind: "set", goal: { goalId: record.owner.goalId } } }] : []), { id: record.owner.branchId }];
            const model = record.model?.split("/");
            const context = { ...ctx, cwd: record.owner.workspace, hasUI: false, isProjectTrusted: () => record.projectTrusted,
                model: model ? ctx.modelRegistry.find(model[0], model.slice(1).join("/")) : undefined,
                sessionManager: { getSessionId: () => record.owner.sessionId, getBranch: () => branch, getLeafId: () => record.owner.branchId,
                    getSessionFile: () => undefined, getEntries: () => branch } };
            const tool = this.session.extensionRunner.getToolDefinition(record.tool);
            if (!tool)
                throw new Error("Fixed subagent adapter unavailable");
            const response = await tool.execute(record.key, record.params, undefined, undefined, context);
            this.journal.finish(ownerKey, record.key, this.epoch, response);
            return response;
        }).finally(() => { this.pending--; });
        this.tail = result;
        return result;
    }
    async close() {
        await this.tail.catch(() => undefined);
        if (this.session)
            await this.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        this.session?.dispose();
        this.journal.close();
    }
}
