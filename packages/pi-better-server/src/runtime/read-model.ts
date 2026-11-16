import { processMatchesStart } from "../daemon-owner.ts";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { createAssignmentProjector } from "./domain/assignment-projection.mjs";
import { createAssignmentReader } from "./domain/assignment-observation.mjs";
import { parseArchivedAttempt, parseArchivedSessionState } from "./domain/session-store.mjs";
import { parseRun, readRunTranscript } from "./domain/parse.mjs";
import { fmtSpend } from "./domain/widget.mjs";
import { effectiveStatus } from "./domain/process-status.mjs";
import { extractChildEventFactsFromLog, healthThresholdsForConfig } from "./domain/health-observation.mjs";
import { BackgroundObservation } from "./background.ts";
// @ts-expect-error Generated canonical read-only failure projection.
import { readFailureStateReadOnly, pendingFailureAttention } from "./domain/subagents/shared-failure-observations.domain.mjs";
import { readHealthConfig } from "./health-config.ts";

export interface WorkScope { processId?: number; backgroundAll?: boolean; background?: boolean; backgroundHistory?: boolean; cwd?: string; sessionId?: string; id?: string; statuses?: string[]; active?: boolean; pendingRecipient?: boolean; endedAfter?: number; detail?: boolean; limit?: number; cursor?: string }
export interface WorkSnapshot {
  instanceId: string; runtimeEpoch: string; scopeRevision: string; seq: number;
  observedRevisionVector: { inventory: number; coordinator: string; healthConfig: string };
  status: "ready" | "rebuilding" | "degraded"; reason?: string;
  rows: Array<{ meta: any; assignment: any; sourceRevision: string }>;
  nextCursor?: string; activity: { active: number }; nextDeadline: number | null;
  totalMatching: number;
  backgroundIndex?: any;
  resyncRequired?: boolean; resyncReason?: string;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const safeId = /^[A-Za-z0-9_-]+$/;

function healthWithThresholds(health: any, config: any, meta: any) {
  if (!health) return undefined;
  const value = { ...health, thresholds: healthThresholdsForConfig(config) };
  return { ...value, nextDeadline: nextHealthDeadline(value, meta) };
}

function nextHealthDeadline(health: any, meta: any, now = Date.now()): number | null {
  if (!health) return null;
  const { thresholds } = health;
  const facts = health.facts;
  const tool = facts.activeTools.at(-1);
  const toolStart = tool?.startedAt ?? facts.lastToolAt ?? facts.lastMeaningfulAt;
  const compactionStart = facts.compactionStartedAt ?? facts.lastMeaningfulAt;
  const anchor = facts.lastMeaningfulAt ?? meta.startedAt;
  const deadlines: number[] = [];
  if (["running", "orphaned"].includes(meta.status)) {
    if (tool && Number.isFinite(toolStart)) deadlines.push(toolStart + thresholds.longToolMs);
    if (facts.compacting && Number.isFinite(compactionStart)) deadlines.push(compactionStart + thresholds.longCompactionMs);
    if (!tool && !facts.compacting && !["retrying", "error"].includes(facts.model.state) && Number.isFinite(anchor)) {
      deadlines.push(anchor + thresholds.quietMs, anchor + thresholds.staleMs);
    }
  }
  const future = deadlines.filter(deadline => deadline > now);
  return future.length ? Math.min(...future) : null;
}

const healthDeadlineExpired = (row: { health?: any }, now: number) => typeof row.health?.nextDeadline === "number" && row.health.nextDeadline <= now;

/** Reconstructable query state. It never authorizes execution or writes source records. */
export class WorkReadModel {
  onTerminalLogsChanged?: () => void;
  private background: BackgroundObservation;
  private db: any;
  private reader: ReturnType<typeof createAssignmentReader>;
  private files = new Map<string, { signature: string; meta: any }>();
  private projected = new Map<string, { meta: any; assignment: any; sourceRevision: string; display?: { spend: string; tool: string }; health?: any; recipientPending?: boolean; failurePending?: boolean }>();
  private logs = new Map<string, string>();
  private failureJournals = new Map<string, string>();
  private processes = new Map<string, string>();
  private staged?: {
    files: WorkReadModel["files"]; projected: WorkReadModel["projected"];
    logs: Map<string, string>; failureJournals: Map<string, string>; processes: Map<string, string>; healthRevision: string;
    coordinator: string; coordinatorConversations?: Map<string, string>;
  };
  private healthRevision = "";
  private details = new Map<string, { revision: string; value: any }>();
  private watchers = new Map<string, FSWatcher>();
  private rootParents = new Map<string, FSWatcher>();
  private rootWatchIdentities = new Map<string, string>();
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private dirty = false;
  private closed = false;
  private inventory = 0;
  private coordinator = "unknown";
  private coordinatorConversations?: Map<string, string>;
  private revision = 0;
  private foldQueueSequence = 0;
  private state: WorkSnapshot["status"] = "rebuilding";
  private reason: string | undefined = "Initial source inventory is rebuilding.";
  private counters = { inventories: 0, metadataReads: 0, projections: 0, healthRecomputations: 0, healthConfigInvalidations: 0 };
  get metrics() {
    return { ...this.counters, coordinatorConnections: Number(Boolean(this.reader.connection(false))) + this.background.connectionCount,
      indexConnections: this.closed ? 0 : 1, sourceWatchers: this.watchers.size, rootParentWatchers: this.rootParents.size };
  }
  readonly runs: string;
  readonly archives: string;
  readonly markers: string;
  readonly agentDir: string;
  readonly instanceId: string;

  constructor(agentDir: string, instanceId: string, options: { supervisorDirectory?: string; baseDir?: string; durableDir?: string; intervalMs?: number } = {}) {
    this.agentDir = agentDir; this.instanceId = instanceId;
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    this.db = new DatabaseSync(":memory:");
    this.reader = createAssignmentReader(join(agentDir, "operation-coordinator.sqlite"));
    this.background = new BackgroundObservation(agentDir, options.supervisorDirectory, this.db, () => this.publish(), refresh => this.reader.connection(refresh));
    this.db.exec(`CREATE TABLE rows (id TEXT PRIMARY KEY, cwd TEXT, origin_cwd TEXT, origin_session TEXT,
      started REAL, state TEXT, active INTEGER, ended REAL, recipient_pending INTEGER, payload TEXT);
      CREATE INDEX work_folder ON rows(cwd, started DESC, id DESC);
      CREATE INDEX work_origin ON rows(origin_cwd, origin_session, started DESC, id DESC);
      CREATE INDEX work_active ON rows(active, started DESC, id DESC);
      CREATE INDEX work_terminal ON rows(active, ended, started DESC, id DESC);
      CREATE INDEX work_recipient_pending ON rows(origin_cwd, origin_session, recipient_pending, started DESC, id DESC);
      CREATE INDEX work_state ON rows(state, started DESC, id DESC);
      CREATE TABLE terminal_log_folds (id TEXT PRIMARY KEY, revision TEXT NOT NULL, pending INTEGER NOT NULL, queue_position INTEGER NOT NULL);
      CREATE INDEX pending_terminal_log_folds ON terminal_log_folds(pending, queue_position, id);`);
    this.runs = join(options.baseDir ?? join(realpathSync(tmpdir()), "pi-better-subagents"), "runs");
    this.archives = join(options.durableDir ?? process.env.PI_SUBAGENT_DURABLE_DIR ?? join(agentDir, "subagents"), "attempts");
    this.markers = join(this.archives, "../session-state");
    // Watch directory entries, not file inodes. Node's Linux recursive watcher
    // can retain a replaced file's old inode after atomic rename and miss later
    // commits. Flat archives need one watcher; raw runs use one per directory.
    this.watchRootParents();
    for (const path of [this.runs, this.archives, this.markers]) this.watchDirectory(path);
    this.timer = setInterval(() => { if (!this.pending) void this.reconcile(); }, options.intervalMs ?? 1000);
    this.timer.unref();
  }

  private watchRootParents() {
    const roots = [this.runs, this.archives, this.markers];
    for (const parent of new Set(roots.map(dirname))) {
      if (this.closed || this.rootParents.has(parent)) continue;
      try {
        // An inode watcher cannot see its pathname recreated after removal.
        // Keep the parent watched even while the source root is absent.
        const watcher = watch(parent, (_event, filename) => {
          if (filename && !roots.some(root => dirname(root) === parent && basename(root) === String(filename))) return;
          void this.reconcile();
        });
        watcher.on("error", () => {
          if (this.rootParents.get(parent) !== watcher) return;
          watcher.close(); this.rootParents.delete(parent);
          this.invalidate("Root parent watcher failed; reconciling source inventory.");
        });
        this.rootParents.set(parent, watcher);
      } catch { /* Missing parents are discovered by the compatibility inventory. */ }
    }
  }

  private unwatchDirectory(path: string) {
    this.watchers.get(path)?.close(); this.watchers.delete(path);
  }
  private watchDirectory(path: string) {
    if (this.closed || this.watchers.has(path)) return;
    try {
      const watcher = watch(path, (_event, filename) => {
        if (path === this.runs) {
          // A raw directory may itself have been removed/replaced. Reattach
          // from the shared inventory, never retain its preceding inode.
          if (filename && safeId.test(String(filename))) this.unwatchDirectory(join(this.runs, String(filename)));
          else for (const watched of this.watchers.keys()) if (watched.startsWith(this.runs + sep)) this.unwatchDirectory(watched);
        }
        void this.reconcile();
      });
      watcher.on("error", () => {
        if (this.watchers.get(path) !== watcher) return;
        this.unwatchDirectory(path);
        this.invalidate("Watcher overflow or failure; reconciling source inventory.");
      });
      this.watchers.set(path, watcher);
    } catch { /* Missing roots are discovered by the existing compatibility inventory. */ }
  }

  onChange(listener: () => void, scope?: WorkScope) {
    const release = scope?.background ? this.background.retain(scope) : undefined;
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); release?.(); };
  }
  get backgroundMetrics() { return { ...this.background.metrics, scopes: this.background.scopeCount, history: this.background.historyMetrics }; }
  observation(reasons = this.livenessReasons({ refresh: false })) {
    return { status: this.state, reason: this.reason, observedAt: Date.now(), reasons };
  }
  livenessReasons(options: { refresh?: boolean } = {}) {
    return [
      ...[...this.projected.values()].filter(row => row.meta.status === "running"
        && processMatchesStart(row.meta.pid, row.meta.pidStartTime))
        .map(row => ({ kind: "worker", id: row.meta.id, owner: row.meta.callbackOrigin,
          lastProgressAt: row.meta.startedAt, nextDeadline: nextHealthDeadline(row.health, row.meta), recovery: "observe-existing-worker" })),
      ...this.background.livenessReasons(options),
    ];
  }
  upgradeObligations() {
    if (this.state !== "ready") throw new Error(`Runtime observation ${this.state}: ${this.reason}`);
    return [...this.livenessReasons(), ...this.reader.upgradeObligations(),
      ...[...this.projected.values()].filter(row => ["running", "orphaned"].includes(row.meta.status)
        && !processMatchesStart(row.meta.pid, row.meta.pidStartTime))
        .map(row => ({ kind: "unresolved-writer", id: row.meta.id }))];
  }
  async ensureId(id: string): Promise<boolean> {

    if (!safeId.test(id)) throw new Error("Invalid run ID");
    if (this.state === "rebuilding") return false;
    if (this.db.prepare("SELECT id FROM rows WHERE id = ?").get(id)) return true;
    try { await stat(join(this.runs, id, "meta.json")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
    // Repair a newly written ID without letting a global inventory consume its read deadline.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.reconcile().then(() => !!this.db.prepare("SELECT id FROM rows WHERE id = ?").get(id)),
        new Promise<false>(resolve => { timeout = setTimeout(() => resolve(false), 100); }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  invalidate(reason: string) {
    this.state = "degraded"; this.reason = reason;
    this.publish();
    void this.reconcile();
  }
  private publish() { this.revision++; for (const listener of this.listeners) listener(); }

  reconcile(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pending) { this.dirty = true; return this.pending; }
    this.pending = (async () => {
      for (let pass = 0; pass < 2; pass++) {
        this.dirty = false;
        await this.scan();
        if (!this.dirty || this.closed) break;
      }
    })().finally(() => {
      this.pending = undefined;
      if (this.dirty && !this.closed) { this.dirty = false; void this.reconcile(); }
    });
    return this.pending;
  }

  private async scan() {
    this.counters.inventories++;
    this.watchRootParents();
    if (this.background.refresh()) this.publish();
    let releaseCoordinator: (() => void) | undefined;
    const baseline = this.staged ?? { files: this.files, projected: this.projected, logs: this.logs, failureJournals: this.failureJournals, processes: this.processes,
      healthRevision: this.healthRevision, coordinator: this.coordinator, coordinatorConversations: this.coordinatorConversations };
    try {
      const next = new Map<string, { signature: string; meta: any }>();
      let batch = 0;
      let sliceStarted = performance.now();
      for (const [directory, archived] of [[this.markers, true], [this.archives, true], [this.runs, false]] as const) {
        let names: string[];
        try { names = await readdir(directory); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          this.unwatchDirectory(directory); this.rootWatchIdentities.delete(directory);
          if (!archived) for (const watched of this.watchers.keys()) if (watched.startsWith(this.runs + sep)) this.unwatchDirectory(watched);
          continue;
        }
        // Three root identities per inventory, independent of archive/client
        // cardinality. A root can be replaced without an observed ENOENT gap.
        const rootInfo = await stat(directory, { bigint: true });
        const rootIdentity = `${rootInfo.dev}:${rootInfo.ino}`;
        const previousRootIdentity = this.rootWatchIdentities.get(directory);
        if (previousRootIdentity !== undefined && previousRootIdentity !== rootIdentity) {
          this.unwatchDirectory(directory);
          if (!archived) for (const watched of this.watchers.keys()) if (watched.startsWith(this.runs + sep)) this.unwatchDirectory(watched);
        }
        this.rootWatchIdentities.set(directory, rootIdentity);
        this.watchDirectory(directory);
        if (!archived) {
          const present = new Set(names.filter(name => safeId.test(name)).map(name => join(directory, name)));
          for (const watched of this.watchers.keys()) if (watched.startsWith(this.runs + sep) && !present.has(watched)) this.unwatchDirectory(watched);
        }
        // Bound filesystem concurrency without serializing every archive round trip.
        const candidates = names.filter(name => safeId.test(archived ? name.replace(/\.json$/, "") : name)
          && (!archived || name.endsWith(".json")));
        for (let offset = 0; offset < candidates.length; offset += 32) {
          const group = candidates.slice(offset, offset + 32);
          const observations = await Promise.all(group.map(async name => {
            if (!archived) this.watchDirectory(join(directory, name));
            const path = archived ? join(directory, name) : join(directory, name, "meta.json");
            try { return { info: await stat(path, { bigint: true }) }; }
            catch (error) { return { error }; }
          }));
          for (const [index, name] of group.entries()) {
            const id = archived ? name.replace(/\.json$/, "") : name;
            const path = archived ? join(directory, name) : join(directory, name, "meta.json");
            try {
              const observation = observations[index]!;
              if (!observation.info) throw observation.error;
              const info = observation.info;
              const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
              let entry = baseline.files.get(path);
              if (entry?.signature !== signature) {
                this.counters.metadataReads++;
                const raw = await readFile(path, "utf8");
                if (directory === this.markers) {
                  const marker = parseArchivedSessionState(raw, id);
                  if (!marker) throw new Error(`Unusable session marker: ${id}`);
                  entry = { signature, meta: marker };
                  next.set(path, entry);
                  continue;
                }
                const meta = archived ? parseArchivedAttempt(raw, id, join(this.archives, "../sessions")) : JSON.parse(raw);
                if (meta?.id !== id || typeof meta.cwd !== "string" || !Number.isFinite(meta.startedAt) || typeof meta.status !== "string") throw new Error(`Unusable run record: ${id}`);
                entry = { signature, meta };
              }
              next.set(path, entry!);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            if (++batch % 256 === 0 || performance.now() - sliceStarted >= 8) {
              await yieldTurn(); sliceStarted = performance.now();
            }
            if (this.closed) return;
          }
        }
      }
      let coordinator: string;
      try {
        const snapshot = this.reader.beginSnapshot();
        coordinator = snapshot.revision; releaseCoordinator = snapshot.release;
      } catch { coordinator = "unknown"; }
      const coordinatorConversations = coordinator === baseline.coordinator ? baseline.coordinatorConversations : this.reader.conversationRevisions();
      const logs = new Map<string, string>();
      const failureJournals = new Map<string, string>();
      const processes = new Map<string, string>();
      const logFamilies = new Set<string>();
      const terminalLogChanges: string[] = [];
      for (const [path, entry] of next) {
        if (!path.startsWith(this.runs + sep)) continue;
        let signature = baseline.logs.get(entry.meta.id);
        {
          try {
            const info = await stat(join(this.runs, entry.meta.id, "output.log"), { bigint: true });
            signature = `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
          } catch (error) { signature = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unverified"; }
        }
        logs.set(entry.meta.id, signature);
        if ((signature !== this.logs.get(entry.meta.id) || this.files.get(path)?.meta.status !== entry.meta.status) && entry.meta.status !== "running"
            && entry.meta.management?.root === this.agentDir) terminalLogChanges.push(entry.meta.id);
        if (signature !== baseline.logs.get(entry.meta.id)) logFamilies.add(JSON.stringify([entry.meta.sessionId, entry.meta.cwd]));
        const failureSignature = (await Promise.all(["failures.jsonl", "failures.jsonl.observed"].map(async name => {
          try { const info = await stat(join(this.runs, entry.meta.id, name), { bigint: true }); return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`; }
          catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unverified"; }
        }))).join(":");
        failureJournals.set(entry.meta.id, failureSignature);
        if (failureSignature !== baseline.failureJournals.get(entry.meta.id)) logFamilies.add(JSON.stringify([entry.meta.sessionId, entry.meta.cwd]));

        const status = effectiveStatus(entry.meta); processes.set(entry.meta.id, status);
        if (status !== baseline.processes.get(entry.meta.id)) logFamilies.add(JSON.stringify([entry.meta.sessionId, entry.meta.cwd]));
        if (performance.now() - sliceStarted >= 8) { await yieldTurn(); sliceStarted = performance.now(); }
      }
      const healthConfig = await readHealthConfig(this.agentDir, next.size > 0);
      if (healthConfig.revision !== baseline.healthRevision) this.counters.healthConfigInvalidations++;
      const changed = next.size !== baseline.files.size || [...next].some(([path, entry]) => baseline.files.get(path)?.signature !== entry.signature);
      const now = Date.now();
      const deadlineExpired = [...baseline.projected.values()].some(row => healthDeadlineExpired(row, now));
      if (!this.staged && !changed && !logFamilies.size && !deadlineExpired && coordinator === this.coordinator && healthConfig.revision === this.healthRevision && !healthConfig.reason && this.state === "ready") return;
      const metas = new Map<string, any>();
      const markers = new Map([...next].filter(([path]) => path.startsWith(this.markers + sep)).map(([, entry]) => [entry.meta.sessionId, entry.meta]));
      for (const [path, entry] of next) {
        if (path.startsWith(this.markers + sep)) continue;
        const marker = markers.get(entry.meta.sessionId);
        if (path.startsWith(this.archives + sep) && marker && marker.attemptId !== entry.meta.id && marker.startedAt >= entry.meta.startedAt) continue;
        metas.set(entry.meta.id, entry.meta);
      }
      const attempts = [...metas.values()];
      const affected = new Set<string>(logFamilies);
      const family = (meta: any) => JSON.stringify([meta.sessionId, meta.cwd]);
      for (const [path, entry] of [...baseline.files, ...next]) {
        if (baseline.files.get(path)?.signature !== next.get(path)?.signature) affected.add(family(entry.meta));
      }
      if (coordinator !== baseline.coordinator) for (const meta of attempts) {
        if (!(meta.assignment || meta.operations || meta.park)) continue;
        const owner = JSON.stringify([meta.operations?.conversationId ?? meta.sessionId, meta.operations?.workspace ?? meta.cwd]);
        if (!coordinatorConversations || !baseline.coordinatorConversations ||
            coordinatorConversations.get(owner) !== baseline.coordinatorConversations.get(owner)) affected.add(family(meta));
      }
      const project = createAssignmentProjector({ attempts, observe: (owner: any) => this.reader.read(owner) });
      const rows = [];
      for (const meta of attempts) {
        let row = baseline.projected.get(meta.id);
        if (row && row.assignment.verified && !affected.has(family(meta)) && (healthConfig.revision !== baseline.healthRevision || healthDeadlineExpired(row, now))) {
          this.counters.healthRecomputations++;
          const health = healthWithThresholds(row.health, healthConfig.config, meta);
          row = { ...row, health, sourceRevision: hash([meta, row.assignment.revision, row.display, health, row.recipientPending, row.failurePending, failureJournals.get(meta.id)]) };
        } else if (!row || !row.assignment.verified || affected.has(family(meta))) {
          this.counters.projections++;
          this.counters.healthRecomputations++;
          const assignment = project(meta, processes.get(meta.id) ?? meta.status);
          const parsed = logs.get(meta.id) && logs.get(meta.id) !== "missing" ? parseRun(meta.id, { logPath: join(this.runs, meta.id, "output.log") }) : undefined;
          const display = { spend: parsed ? fmtSpend(parsed.usage) : "", tool: parsed?.toolCalls.at(-1) ?? "" };
          const health = logs.has(meta.id) ? healthWithThresholds(extractChildEventFactsFromLog(meta.id, { logPath: join(this.runs, meta.id, "output.log") }), healthConfig.config, meta) : undefined;
          const outcome = meta.assignment ? this.reader.read({ ...meta.assignment.owner, assignmentId: meta.assignment.assignmentId }).outcome : undefined;
          const failurePending = meta.callback !== false && failureJournals.has(meta.id) && Boolean(pendingFailureAttention(
            readFailureStateReadOnly(join(this.runs, meta.id, "failures.jsonl")), Date.now(),
            { terminal: !["running", "orphaned"].includes(meta.status), deferObservationGaps: meta.status === "running" }));
          const recipientPending = Boolean(failurePending || meta.timing?.pendingWakes?.length
            || (meta.status === "orphaned" && meta.orphanedCallbackSentAt === undefined && meta.orphanedCallbackSuppressedAt === undefined)
            || (meta.status === "lost" && meta.lostCallbackSentAt === undefined && meta.lostCallbackSuppressedAt === undefined)
            || (meta.callback !== false && (meta.assignment ? outcome && !outcome.deliveryReceipt && !outcome.disposition
              : meta.completionCallbackPendingAt !== undefined && meta.completionCallbackSentAt === undefined && meta.completionCallbackSuppressedAt === undefined)));
          row = { meta, assignment, display, health, recipientPending, failurePending, sourceRevision: hash([meta, assignment.revision, display, health, recipientPending, failurePending, failureJournals.get(meta.id)]) };
        }
        rows.push(row);
        if (++batch % 256 === 0 || performance.now() - sliceStarted >= 8) {
          await yieldTurn(); sliceStarted = performance.now();
        }
      }
      let after: string;
      try { after = this.reader.revision(); } catch { after = "unknown"; }
      if (after !== coordinator) { this.state = "degraded"; this.reason = "Coordinator changed during observation; retrying."; this.dirty = true; this.publish(); return; }
      // Retry caches are never queryable. Validate all unpublished families again before committing them.
      this.staged = { files: next, projected: new Map(rows.map(row => [row.meta.id, row])), logs, failureJournals, processes,
        healthRevision: healthConfig.revision, coordinator, coordinatorConversations };
      const uncommitted = new Set(affected);
      for (const [path, entry] of [...this.files, ...next]) {
        if (this.files.get(path)?.signature !== next.get(path)?.signature) uncommitted.add(family(entry.meta));
      }
      const verify = [...next].filter(([, entry]) => uncommitted.has(family(entry.meta)));
      for (let offset = 0; offset < verify.length; offset += 32) {
        const group = verify.slice(offset, offset + 32);
        const observations = await Promise.all(group.map(async ([path]) => {
          try { return { info: await stat(path, { bigint: true }) }; }
          catch (error) { return { error }; }
        }));
        for (const [index, [, entry]] of group.entries()) {
          const observation = observations[index]!;
          if (!observation.info) throw observation.error;
          const info = observation.info;
          if (`${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` !== entry.signature) {
            this.dirty = true;
            throw new Error("Source changed during observation; retaining the previous snapshot while reconciling.");
          }
          if (++batch % 256 === 0 || performance.now() - sliceStarted >= 8) {
            await yieldTurn(); sliceStarted = performance.now();
          }
        }
      }
      if (this.closed) return;
      this.db.exec("BEGIN");
      const insert = this.db.prepare("INSERT OR REPLACE INTO rows VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      const remove = this.db.prepare("DELETE FROM rows WHERE id = ?");
      let semanticChange = false;
      try {
        for (const id of this.projected.keys()) if (!metas.has(id)) { remove.run(id); this.db.prepare("DELETE FROM terminal_log_folds WHERE id=?").run(id); semanticChange = true; }
        for (const id of terminalLogChanges) this.db.prepare("INSERT INTO terminal_log_folds VALUES (?, ?, 1, ?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, pending=1, queue_position=CASE WHEN terminal_log_folds.pending=0 THEN excluded.queue_position ELSE terminal_log_folds.queue_position END").run(id, hash([logs.get(id), metas.get(id)?.status]), ++this.foldQueueSequence);
        for (const row of rows) {
          if (this.projected.get(row.meta.id)?.sourceRevision === row.sourceRevision) continue;
          semanticChange = true;
          const m = row.meta;
          if (m.management?.root !== this.agentDir || m.status === "running") this.db.prepare("DELETE FROM terminal_log_folds WHERE id=?").run(m.id);
          insert.run(m.id, m.cwd, m.callbackOrigin?.cwd ?? m.cwd, m.callbackOrigin?.sessionId ?? null,
            m.startedAt, row.assignment.state, ["running", "waiting"].includes(row.assignment.state) ? 1 : 0, m.endedAt ?? m.lostAt ?? null, row.recipientPending ? 1 : 0, JSON.stringify(row));
        }
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      this.files = next; this.logs = logs; this.failureJournals = failureJournals; this.processes = processes; this.healthRevision = healthConfig.revision; this.coordinator = coordinator; this.inventory++;
      this.coordinatorConversations = coordinatorConversations;
      this.projected = new Map(rows.map(row => [row.meta.id, row]));
      this.staged = undefined;
      if (terminalLogChanges.length) this.onTerminalLogsChanged?.();
      const previousState = this.state;
      const previousReason = this.reason;
      this.state = healthConfig.reason || rows.some(row => !row.assignment.verified) ? "degraded" : "ready";
      this.reason = healthConfig.reason ?? (this.state === "degraded" ? "Some assignment sources could not be verified." : undefined);
      if (semanticChange || previousState !== this.state || previousReason !== this.reason) this.publish();
    } catch (error) {
      if (this.closed) return;
      this.state = "degraded"; this.reason = String(error).slice(0, 512); this.publish();
    } finally { releaseCoordinator?.(); }
  }

  /** Derived pending index: no unbounded JavaScript backlog and no dropped IDs. */
  terminalLogChanges(): Array<{id: string; revision: string}> {
    return this.db.prepare("SELECT id, revision FROM terminal_log_folds WHERE pending=1 ORDER BY queue_position, id LIMIT 128").all();
  }
  acknowledgeTerminalLogs(batch: Array<{id: string; revision: string}>) {
    const acknowledge = this.db.prepare("UPDATE terminal_log_folds SET pending=CASE WHEN revision=? THEN 0 ELSE 1 END, queue_position=? WHERE id=?");
    // A newer revision remains owed, but rejoins behind existing obligations.
    // Continuously changing low IDs cannot monopolize every subsequent batch.
    for (const entry of batch) acknowledge.run(entry.revision, ++this.foldQueueSequence, entry.id);
  }

  snapshot(scope: WorkScope = {}): WorkSnapshot {
    if (scope.background) {
      if (scope.backgroundHistory && this.background.refresh()) this.publish();
      const index = scope.backgroundHistory ? this.background.historyIndex(scope) : undefined;
      const tasks = this.background.read(scope, index);
      const status = this.background.status === "degraded" ? "degraded" : index ? this.background.historyStatus : this.background.status;
      const active = (index ? this.background.read({ ...scope, backgroundHistory: false, active: true }) : tasks).filter(task => task.durable ? task.active : task.status === "running").length;
      return { instanceId: this.instanceId, runtimeEpoch: this.instanceId, scopeRevision: hash([scope, tasks, status, index?.page, active]), seq: this.revision,
        observedRevisionVector: { inventory: this.inventory, coordinator: this.coordinator, healthConfig: this.healthRevision },
        status, reason: this.background.reason ?? (index ? this.background.historyReason : undefined),
        rows: tasks.map(meta => ({ meta, assignment: null, sourceRevision: hash(meta) })), totalMatching: index?.page.total ?? tasks.length,
        ...(index?.page.nextCursor ? { nextCursor: index.page.nextCursor } : {}),
        ...(index ? { backgroundIndex: index } : {}),
        activity: { active }, nextDeadline: null };
    }
    const clauses: string[] = [], args: any[] = [];
    if (scope.id) { clauses.push("id = ?"); args.push(scope.id); }
    if (scope.sessionId) { clauses.push("origin_session = ? AND origin_cwd = ?"); args.push(scope.sessionId, scope.cwd); }
    else if (scope.cwd) { const cwd = resolve(scope.cwd); clauses.push("(cwd = ? OR substr(cwd, 1, ?) = ?)"); args.push(cwd, (cwd.endsWith(sep) ? cwd : cwd + sep).length, cwd.endsWith(sep) ? cwd : cwd + sep); }
    // Activity describes the scope, independently of history filters and pagination.
    const active = Number(this.db.prepare(`SELECT count(*) AS n FROM rows WHERE ${[...clauses, "active = 1"].join(" AND ")}`).get(...args).n);
    if (scope.pendingRecipient !== undefined) {
      if (!scope.sessionId || !scope.cwd) throw new Error("Pending recipient query requires an exact conversation");
      clauses.push("recipient_pending = ?"); args.push(scope.pendingRecipient ? 1 : 0);
    }
    if (scope.active !== undefined) { clauses.push("active = ?"); args.push(scope.active ? 1 : 0); }
    if (scope.endedAfter !== undefined) { clauses.push("(ended IS NULL OR ended >= ?)"); args.push(scope.endedAfter); }
    if (scope.statuses?.length) { clauses.push(`state IN (${scope.statuses.map(() => "?").join(",")})`); args.push(...scope.statuses); }
    const key = hash({ ...scope, cursor: undefined });
    const totalMatching = Number(this.db.prepare(`SELECT count(*) AS n FROM rows ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""}`).get(...args).n);
    if (scope.cursor) {
      let cursor;
      try { cursor = JSON.parse(Buffer.from(scope.cursor, "base64url").toString()); } catch { throw new Error("Invalid runtime cursor"); }
      if (!Array.isArray(cursor) || cursor[0] !== key || cursor[1] !== this.instanceId || cursor[2] !== this.revision) throw new Error("resync_required: cursor snapshot changed");
      clauses.push("(started < ? OR (started = ? AND id < ?))"); args.push(cursor[3], cursor[3], cursor[4]);
    }
    const limit = Math.max(1, Math.min(200, Number.isSafeInteger(scope.limit) ? scope.limit! : 50));
    const records = this.db.prepare(`SELECT payload, started, id FROM rows ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""} ORDER BY started DESC, id DESC LIMIT ?`).all(...args, limit + 1);
    const page = records.slice(0, limit), last = page.at(-1);
    const now = Date.now();
    const rows = page.map((record: any) => {
      const row = JSON.parse(record.payload);
      if (row.health) row.health.nextDeadline = nextHealthDeadline(row.health, row.meta, now);
      return row;
    });
    const deadlines = rows.map((row: any) => row.health?.nextDeadline).filter((deadline: any) => typeof deadline === "number");
    return { instanceId: this.instanceId, runtimeEpoch: this.instanceId, scopeRevision: hash([key, this.revision]), seq: this.revision,
      observedRevisionVector: { inventory: this.inventory, coordinator: this.coordinator, healthConfig: this.healthRevision }, status: this.state, reason: this.reason,
      totalMatching,
      rows: page.map((record: any, index: number) => {
        const row = rows[index];
        if (scope.detail && scope.id) {
          let cached = this.details.get(row.meta.id);
          if (!cached || cached.revision !== row.sourceRevision) {
            const logPath = join(this.runs, row.meta.id, "output.log");
            const expectedLog = this.logs.get(row.meta.id) ?? "missing";
            const signature = () => {
              try { const info = statSync(logPath, { bigint: true }); return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`; }
              catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unverified"; }
            };
            if (signature() !== expectedLog) throw new Error("state-degraded: log changed since the indexed observation; resync required");
            const value = { parsed: parseRun(row.meta.id, { logPath }), transcript: readRunTranscript(row.meta.id, { logPath }) };
            if (signature() !== expectedLog) throw new Error("state-degraded: log changed during detail observation; resync required");
            if (Buffer.byteLength(JSON.stringify(value)) > 3 * 1024 * 1024) throw new Error("state-degraded: detail exceeds the bounded snapshot allowance");
            cached = { revision: row.sourceRevision, value }; this.details.set(row.meta.id, cached);
            if (this.details.size > 16) this.details.delete(this.details.keys().next().value!);
          }
          row.detail = cached.value;
        }
        return { ...row, cursor: Buffer.from(JSON.stringify([key, this.instanceId, this.revision, record.started, record.id])).toString("base64url") };
      }),
      ...(records.length > limit ? { nextCursor: Buffer.from(JSON.stringify([key, this.instanceId, this.revision, last.started, last.id])).toString("base64url") } : {}),
      activity: { active }, nextDeadline: deadlines.length ? Math.min(...deadlines) : null };
  }

  async close() {
    this.closed = true; if (this.timer) clearInterval(this.timer);
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear(); this.rootWatchIdentities.clear();
    for (const watcher of this.rootParents.values()) watcher.close();
    this.rootParents.clear();
    await this.pending; this.listeners.clear(); await this.background.close(); this.reader.close(); this.db.close();
  }
}
