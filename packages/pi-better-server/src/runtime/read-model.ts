import { processMatchesStart } from "../daemon-owner.ts";
import { createHash } from "node:crypto";
import { opendir, readFile, stat, writeFile, mkdir, rename } from "node:fs/promises";
import { watchSource, type SourceWatch, type SourceWatcher as FSWatcher } from "./source-watch.ts";
import { basename, dirname, relative, join, resolve, sep } from "node:path";
import { realpathSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { createAssignmentProjector } from "./domain/assignment-projection.mjs";
import { createAssignmentReader } from "./domain/assignment-observation.mjs";
import { parseArchivedAttempt, parseArchivedSessionState } from "./domain/session-store.mjs";
import { parseRun, parseRunDisplay, readRunTranscript, encodeParseLogState, decodeParseLogState } from "./domain/parse.mjs";
import { withLogReadBatch, logReadMetrics } from "./domain/log-cursor.mjs";
import { fmtSpend } from "./domain/widget.mjs";
import { effectiveStatus } from "./domain/process-status.mjs";
import { extractChildEventFactsFromLog, healthThresholdsForConfig, encodeHealthLogState, decodeHealthLogState } from "./domain/health-observation.mjs";
import { LogCheckpoints } from "./log-checkpoints.ts";
import { BackgroundObservation } from "./background.ts";
import { workPage, createWorkBudget } from "./work-budget.ts";
// @ts-expect-error Generated canonical read-only failure projection.
import { readFailureStateReadOnly, pendingFailureAttention } from "./domain/subagents/shared-failure-observations.domain.mjs";
import { readHealthConfig } from "./health-config.ts";

export interface WorkScope { processId?: number; backgroundAll?: boolean; background?: boolean; backgroundHistory?: boolean; cwd?: string; sessionId?: string; id?: string; statuses?: string[]; active?: boolean; pendingRecipient?: boolean; endedAfter?: number; detail?: boolean; limit?: number; cursor?: string }
export interface WorkSnapshot {
  instanceId: string; runtimeEpoch: string; scopeRevision: string; seq: number;
  observedRevisionVector: { inventory: number; coordinator: string; healthConfig: string };
  status: "ready" | "rebuilding" | "degraded"; reason?: string;
  rows: Array<{ meta: any; assignment: any; sourceRevision: string; recipientPending?: boolean }>;
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
  private budget: ReturnType<typeof createWorkBudget>;
  onTerminalLogsChanged?: () => void;
  private background: BackgroundObservation;
  private db: any;
  private reader: ReturnType<typeof createAssignmentReader>;
  private files = new Map<string, { signature: string; meta: any }>();
  private projected = new Map<string, { meta: any; assignment: any; sourceRevision: string; display?: { spend: string; tool: string; diagnostics?: string[]; coverage?: any }; health?: any; recipientPending?: boolean; failurePending?: boolean }>();
  private logs = new Map<string, string>();
  private parseStates = new Map();
  private healthStates = new Map();
  private checkpoints: LogCheckpoints;
  private checkpointAttemptAllowed = true;
  private checkpointFailure = false;
  private failureJournals = new Map<string, string>();
  private processes = new Map<string, string>();
  private staged?: {
    files: WorkReadModel["files"]; projected: WorkReadModel["projected"];
    logs: Map<string, string>; failureJournals: Map<string, string>; processes: Map<string, string>; healthRevision: string;
    coordinator: string;
    assignmentChanges?: Map<string, string>; assignmentGeneration: string;
  };
  private healthRevision = "";
  private details = new Map<string, { revision: string; value: any }>();
  private watchers = new Map<string, FSWatcher>();
  private rootParents = new Map<string, { path: string; identity: string; watcher: FSWatcher }>();
  private rootWatchIdentities = new Map<string, string>();
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private dirty = false;
  private hints = new Map<string, number>();
  private repair?: AsyncGenerator<string[]>;
  private repairOwed = false;
  private imported = false;
  private repairWrite: Promise<void> = Promise.resolve();
  private repairPersistencePending = false;
  private sourceErrors = new Map<string, string>();
  private sourceRace?: { reason: string; paths: Set<string>; rows: any[] };
  private sourceStats = 0;
  private sourceWork = { entity: { batches: 0, paths: 0, stats: 0, metadataReads: 0, logBytes: 0, logReads: 0 }, repair: { batches: 0, paths: 0, stats: 0, metadataReads: 0, logBytes: 0, logReads: 0 } };
  private scheduling = { entityBatches: 0, repairBatches: 0, repairEntries: 0, overflows: 0, maxQueueAgeMs: 0, maxPublicationMs: 0 };
  private closed = false;
  private inventory = 0;
  private coordinator = "unknown";
  private assignmentBaseline?: { key: string; seq: string };
  private assignmentFault?: { state: WorkSnapshot["status"]; reason?: string };
  private unsupportedAssignmentRevision?: string;
  private coordinatorConversations?: Map<string, string>;
  private revision = 0;
  private scopeSequence = 0;
  private scopes = new Map<string, { scope: WorkScope; token: number; revision: number; used: number; status: string }>();
  private changedRows: Array<{ before?: any; after?: any }> = [];
  private foldQueueSequence = 0;
  private state: WorkSnapshot["status"] = "rebuilding";
  private reason: string | undefined = "Initial source inventory is rebuilding.";
  private counters = { inventories: 0, metadataReads: 0, projections: 0, assignmentProjections: 0, logProjections: 0, healthProjections: 0, failureProjections: 0, healthRecomputations: 0, healthConfigInvalidations: 0 };
  private invalidations = { assignmentInput: 0, process: 0, log: 0, failureAttention: 0, healthConfig: 0, healthDeadline: 0, unverified: 0, initial: 0 };
  get metrics() {
    return { ...this.counters, checkpoints: { ...this.checkpoints.metrics, hotDisplay: this.parseStates.size, hotHealth: this.healthStates.size }, assignments: this.reader.changeMetrics, sourceWork: structuredClone(this.sourceWork), scheduling: { ...this.scheduling, queued: this.hints.size }, invalidations: { ...this.invalidations }, logReads: { ...logReadMetrics }, coordinatorConnections: Number(Boolean(this.reader.connection(false))) + this.background.connectionCount,
      indexConnections: this.closed ? 0 : 1, sourceWatchers: this.watchers.size, sourceParentWatchers: this.rootParents.size, rootParentWatchers: this.rootParents.size };
  }
  readonly runs: string;
  readonly archives: string;
  readonly markers: string;
  readonly agentDir: string;
  readonly instanceId: string;

  private watch: SourceWatch;
  constructor(agentDir: string, instanceId: string, options: { supervisorDirectory?: string; baseDir?: string; durableDir?: string; intervalMs?: number; watch?: SourceWatch; budgetBuffer?: SharedArrayBuffer } = {}) {
    this.budget = createWorkBudget(options.budgetBuffer);
    this.watch = options.watch ?? watchSource;
    this.agentDir = agentDir; this.instanceId = instanceId;
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
    this.db = new DatabaseSync(":memory:");
    try { this.checkpoints = new LogCheckpoints(join(agentDir, "runtime-log-checkpoints.sqlite"), this.db, { defer: true }); }
    catch (error) {
      try { this.db.close(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Checkpoint initialization and derived owner cleanup failed", { cause: error }); }
      throw error;
    }
    mkdirSync(join(agentDir, "runtime-read-repair"), { recursive: true });
    this.reader = createAssignmentReader(join(agentDir, "operation-coordinator.sqlite"), join(agentDir, "runtime-read-repair", "assignments.sqlite"), this.db, { composed: true });
    this.background = new BackgroundObservation(agentDir, options.supervisorDirectory, this.db, () => this.publish(true), refresh => this.reader.connection(refresh));
    this.db.exec(`CREATE TABLE rows (id TEXT PRIMARY KEY, cwd TEXT, origin_cwd TEXT, origin_session TEXT,
      started REAL, state TEXT, active INTEGER, ended REAL, recipient_pending INTEGER, payload TEXT);
      CREATE INDEX work_folder ON rows(cwd, started DESC, id DESC);
      CREATE INDEX work_origin ON rows(origin_cwd, origin_session, started DESC, id DESC);
      CREATE INDEX work_active ON rows(active, started DESC, id DESC);
      CREATE INDEX work_terminal ON rows(active, ended, started DESC, id DESC);
      CREATE INDEX work_recipient_pending ON rows(origin_cwd, origin_session, recipient_pending, started DESC, id DESC);
      CREATE INDEX work_state ON rows(state, started DESC, id DESC);
      CREATE TABLE assignment_members (scope TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(scope,id));
      CREATE INDEX assignment_member_id ON assignment_members(id);
      CREATE TABLE terminal_log_folds (id TEXT PRIMARY KEY, revision TEXT NOT NULL, pending INTEGER NOT NULL, queue_position INTEGER NOT NULL);
      CREATE INDEX pending_terminal_log_folds ON terminal_log_folds(pending, queue_position, id);`);
    this.runs = join(options.baseDir ?? join(realpathSync(tmpdir()), "pi-better-subagents"), "runs");
    this.archives = join(options.durableDir ?? process.env.PI_SUBAGENT_DURABLE_DIR ?? join(agentDir, "subagents"), "attempts");
    this.markers = join(this.archives, "../session-state");
    // Watch directory entries, not file inodes. Node's Linux recursive watcher
    // can retain a replaced file's old inode after atomic rename and miss later
    // commits. Flat archives need one watcher; raw runs use one per directory.
    for (const path of [this.runs, this.archives, this.markers]) { this.watchRootParent(path); this.watchDirectory(path); }
    this.timer = setInterval(() => { this.checkpointAttemptAllowed = true; this.repairOwed = true; if (!this.pending) void this.reconcile(false); }, options.intervalMs ?? 1000);
    this.timer.unref();
  }

  private unwatchDirectory(path: string) {
    this.watchers.get(path)?.close(); this.watchers.delete(path);
  }
  private watchRootParent(root: string) {
    if (this.closed) return;
    // A watch follows an inode, not the source pathname. Keep an independent
    // parent entry watch so recreation after an observed ENOENT remains visible.
    for (let parent = dirname(root); ; parent = dirname(parent)) {
      const previous = this.rootParents.get(root);
      try {
        const info = statSync(parent, { bigint: true });
        const identity = `${info.dev}:${info.ino}`;
        if (previous?.path === parent && previous.identity === identity) return;
        const entry = relative(parent, root).split(sep)[0];
        const watcher = this.watch(parent, (_event, filename) => {
          if (this.closed || this.rootParents.get(root)?.watcher !== watcher) return;
          if (!filename || String(filename) === entry || String(filename) === relative(dirname(parent), parent)) void this.reconcile();
        });
        watcher.on("error", () => {
          if (this.rootParents.get(root)?.watcher !== watcher) return;
          watcher.close(); this.rootParents.delete(root);
          this.invalidate("Source parent watcher failed; reconciling source inventory.");
        });
        previous?.watcher.close();
        this.rootParents.set(root, { path: parent, identity, watcher });
        return;
      } catch { /* Missing source ancestors are watched from their nearest existing parent. */ }
      if (dirname(parent) === parent) return;
    }
  }
  private watchDirectory(path: string) {
    if (this.closed) return;
    let identity: string | undefined;
    if ([this.runs, this.archives, this.markers].includes(path)) {
      try {
        const info = statSync(path, { bigint: true });
        identity = `${info.dev}:${info.ino}`;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
      }
      if (!identity || this.rootWatchIdentities.get(path) !== identity) {
        this.unwatchDirectory(path); this.rootWatchIdentities.delete(path);
        if (path === this.runs) for (const child of this.watchers.keys()) if (child.startsWith(this.runs + sep)) this.unwatchDirectory(child);
      }
      if (!identity) return;
    }
    if (this.watchers.has(path)) return;
    try {
      const watcher = this.watch(path, (_event, filename) => {
        if (this.closed || this.watchers.get(path) !== watcher) return;
        if (path === this.runs) {
          // A raw directory may itself have been removed/replaced. Reattach
          // from the shared inventory, never retain its preceding inode.
          if (filename && safeId.test(String(filename))) this.unwatchDirectory(join(this.runs, String(filename)));
          else for (const watched of this.watchers.keys()) if (watched.startsWith(this.runs + sep)) this.unwatchDirectory(watched);
        }
        this.fileHint(path, filename ? String(filename) : undefined);
      });
      watcher.on("error", () => {
        if (this.watchers.get(path) !== watcher) return;
        this.unwatchDirectory(path);
        this.invalidate("Watcher overflow or failure; reconciling source inventory.");
      });
      this.watchers.set(path, watcher);
      if (identity) this.rootWatchIdentities.set(path, identity);
    } catch { /* Missing roots are discovered by the existing compatibility inventory. */ }
  }

  /** File notifications are hints, never authority. Unknown names owe scoped repair. */
  fileHint(directory: string, name?: string) {
    // Some fs.watch backends report the watched directory's own name for a
    // contained write. It identifies a source to verify, not a child entry.
    if (name === basename(directory)) {
      name = directory.startsWith(this.runs + sep) ? "meta.json" : undefined;
    }
    let path: string | undefined;
    if (directory === this.runs && name && safeId.test(name)) path = join(directory, name, "meta.json");
    else if ([this.archives, this.markers].includes(directory) && name && /^[A-Za-z0-9_-]+\.json$/.test(name)) path = join(directory, name);
    else if (directory.startsWith(this.runs + sep) && name && ["meta.json", "output.log", "failures.jsonl", "failures.jsonl.observed"].includes(name)) path = join(directory, "meta.json");
    else if (name) return; // Locks, temporary files and coordinator controls are not task inputs.
    if (!path) { this.repairOwed = true; void this.reconcile(false); return; }
    if (!this.hints.has(path)) {
      if (this.hints.size >= 256) {
        this.scheduling.overflows++; this.repairOwed = true;
        // Persist the bounded source scope before discarding the individual hint.
        if (!this.repairPersistencePending) {
          this.repairPersistencePending = true;
          this.repairWrite = this.persistRepair().finally(() => { this.repairPersistencePending = false; });
          void this.repairWrite.then(() => this.reconcile(false)).catch(error => this.invalidate(String(error)));
        }
        return;
      }
      this.hints.set(path, Date.now());
    }
    void this.reconcile(false);
  }

  private async persistRepair() {
    const directory = join(this.agentDir, "runtime-read-repair");
    await mkdir(directory, { recursive: true });
    const path = join(directory, "subagents.json");
    await writeFile(path + ".tmp", JSON.stringify({ version: 1, roots: [this.runs, this.archives, this.markers] }));
    await rename(path + ".tmp", path);
  }

  private async *repairPaths(): AsyncGenerator<string[]> {
    // Check known paths too: an incomplete walk never deletes unseen records.
    // Discovery and failed-source repair can overlap these paths. Retry each
    // source once per pass, not once per inventory route.
    const seen = new Set<string>();
    let batch: string[] = [];
    for (const path of this.files.keys()) {
      seen.add(path);
      batch.push(path);
      if (batch.length === 128) { yield batch; batch = []; }
    }
    // Failed first reads have no verified file entry, but still owe repair.
    for (const path of this.sourceErrors.keys()) {
      if (seen.has(path)) continue;
      seen.add(path);
      batch.push(path);
      if (batch.length === 128) { yield batch; batch = []; }
    }
    for (const directory of [this.markers, this.archives, this.runs]) {
      this.watchRootParent(directory);
      let handle;
      try {
        const info = await stat(directory, { bigint: true });
        const identity = `${info.dev}:${info.ino}`;
        if (this.rootWatchIdentities.get(directory) !== identity) {
          this.unwatchDirectory(directory);
          if (directory === this.runs) for (const path of this.watchers.keys()) if (path.startsWith(this.runs + sep)) this.unwatchDirectory(path);
        }
        this.watchDirectory(directory);
        handle = await opendir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        this.unwatchDirectory(directory);
        this.rootWatchIdentities.delete(directory);
        if (directory === this.runs) for (const path of this.watchers.keys()) if (path.startsWith(this.runs + sep)) this.unwatchDirectory(path);
        continue;
      }
      for await (const entry of handle) {
        if (directory === this.runs ? safeId.test(entry.name) : /^[A-Za-z0-9_-]+\.json$/.test(entry.name)) {
          const path = directory === this.runs ? join(directory, entry.name, "meta.json") : join(directory, entry.name);
          if (seen.has(path)) continue;
          seen.add(path);
          batch.push(path);
          if (batch.length === 128) { yield batch; batch = []; }
        }
      }
    }
    if (batch.length) yield batch;
  }

  onChange(listener: () => void, scope?: WorkScope) {
    if (scope) scope = { ...scope, cursor: undefined };
    const release = scope?.background ? this.background.retain(scope) : undefined;
    let revision = scope ? this.contentRevision(scope) : undefined;
    const notify = () => {
      const next = scope ? this.contentRevision(scope) : undefined;
      if (scope && next === revision) return;
      revision = next; listener();
    };
    this.listeners.add(notify);
    return () => { this.listeners.delete(notify); release?.(); };
  }
  get backgroundMetrics() { return { ...this.background.metrics, registry: this.background.registryMetrics, changes: this.background.changeMetrics, scopes: this.background.scopeCount, history: this.background.historyMetrics }; }
  observation(reasons = this.checkpoints.ready ? this.livenessReasons({ refresh: false }) : []) {
    return { status: this.state, reason: this.reason, observedAt: Date.now(), reasons };
  }
  livenessReasons(options: { refresh?: boolean } = {}) {
    if (!this.checkpoints.ready) throw new Error(`Runtime observation ${this.state}: checkpoint coverage is unverified`);
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
        (this.fileHint(this.runs, id), this.pending ?? Promise.resolve()).then(() => !!this.db.prepare("SELECT id FROM rows WHERE id = ?").get(id)),
        new Promise<false>(resolve => { timeout = setTimeout(() => resolve(false), 100); }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
  invalidate(reason: string) {
    const changed = this.state !== "degraded" || this.reason !== reason;
    this.state = "degraded"; this.reason = reason;
    if (changed) this.publish();
    void this.reconcile();
  }
  private scopeKey(scope: WorkScope) { return hash({ ...scope, cursor: undefined }); }
  private scopeEntry(scope: WorkScope) {
    const key = this.scopeKey(scope), now = Date.now();
    for (const [id, entry] of this.scopes) if (now - entry.used >= 300000) this.scopes.delete(id);
    let entry = this.scopes.get(key);
    if (!entry) {
      if (scope.cursor) throw new Error("resync_required: cursor retention expired");
      if (this.scopes.size >= 128) this.scopes.delete(this.scopes.keys().next().value!);
      entry = { scope: { ...scope, cursor: undefined }, token: ++this.scopeSequence, revision: 0, used: now, status: hash(this.scopeStatus(scope)) };
      this.scopes.set(key, entry);
    }
    entry.used = now;
    return entry;
  }
  contentRevision(scope: WorkScope = {}) {
    if (scope.background) {
      if (scope.backgroundHistory) return String(this.revision);
      this.background.prepareQuery();
      return hash([this.revision, this.background.sourceRevision(scope)]);
    }
    const entry = this.scopeEntry(scope);
    return `${entry.token}:${entry.revision}`;
  }
  private matchesScope(scope: WorkScope, row: any, activity = false) {
    if (!row) return false;
    const m = row.meta;
    if (scope.id && scope.id !== m.id) return false;
    if (scope.sessionId) {
      if (scope.sessionId !== m.callbackOrigin?.sessionId || scope.cwd !== (m.callbackOrigin?.cwd ?? m.cwd)) return false;
    } else if (scope.cwd) {
      const cwd = resolve(scope.cwd), prefix = cwd.endsWith(sep) ? cwd : cwd + sep;
      if (m.cwd !== cwd && !m.cwd.startsWith(prefix)) return false;
    }
    const active = ["running", "waiting"].includes(row.assignment.state);
    if (activity) return active;
    return (scope.active === undefined || scope.active === active)
      && (scope.pendingRecipient === undefined || scope.pendingRecipient === !!row.recipientPending)
      && (scope.endedAfter === undefined || (m.endedAt ?? m.lostAt ?? Infinity) >= scope.endedAfter)
      && (!scope.statuses?.length || scope.statuses.includes(row.assignment.state));
  }
  private publish(backgroundOnly = false) {
    this.revision++;
    for (const entry of this.scopes.values()) {
      if (backgroundOnly) continue;
      const status = hash(this.scopeStatus(entry.scope));
      if (entry.status !== status || this.changedRows.some(({ before, after }) =>
        this.matchesScope(entry.scope, before) || this.matchesScope(entry.scope, after)
        || this.matchesScope(entry.scope, before, true) !== this.matchesScope(entry.scope, after, true))) entry.revision++;
      entry.status = status;
    }
    this.changedRows = [];
    for (const listener of this.listeners) listener();
  }

  /** Ordinary coordinator commits use the reverse scope index, not the source inventory. */
  private refreshAssignments(baselineOnly = false) {
    if ((!this.imported && !baselineOnly) || this.staged || this.reader.snapshotActive) return;
    let release: (() => void) | undefined;
    let revision: string | undefined;
    try {
      if (this.unsupportedAssignmentRevision && this.unsupportedAssignmentRevision === this.reader.revision()) return;
      this.unsupportedAssignmentRevision = undefined;
      const changes = this.reader.changes();
      const snapshot = this.reader.beginSnapshot(); release = snapshot.release;
      revision = snapshot.revision;
      if (changes.has("*")) {
        const key = `${this.reader.changeMetrics.generation}:${changes.get("*")}`;
        if (baselineOnly) {
          this.assignmentBaseline = { key, seq: changes.get("*")! };
          this.coordinator = snapshot.revision;
          return;
        }
        if (this.assignmentBaseline?.key === key) return;
        this.imported = false; this.repairOwed = true;
        if (!this.sourceErrors.size) { this.state = "rebuilding"; this.reason = "Assignment source baseline is rebuilding."; }
        this.publish(); return;
      }
      const selected = new Map<string, any>();
      const select = this.db.prepare("SELECT r.payload FROM assignment_members m JOIN rows r ON r.id=m.id WHERE m.scope=?");
      for (const scope of changes.keys()) for (const record of select.all(scope)) {
        const row = JSON.parse(record.payload); selected.set(row.meta.id, row);
      }
      const project = createAssignmentProjector({ attempts: [...selected.values()].map(row => row.meta), observe: (owner: any) => this.reader.read(owner) });
      const updated: any[] = [];
      for (const row of selected.values()) {
        const meta = row.meta;
        const assignment = project(meta, this.processes.get(meta.id) ?? meta.status);
        if (!assignment.verified) throw new Error(`Assignment observation is unverified: ${meta.id}`);
        const outcome = meta.assignment ? this.reader.read({ ...meta.assignment.owner, assignmentId: meta.assignment.assignmentId }).outcome : undefined;
        const recipientPending = Boolean(row.failurePending || meta.timing?.pendingWakes?.length
          || (meta.status === "orphaned" && meta.orphanedCallbackSentAt === undefined && meta.orphanedCallbackSuppressedAt === undefined)
          || (meta.status === "lost" && meta.lostCallbackSentAt === undefined && meta.lostCallbackSuppressedAt === undefined)
          || (meta.callback !== false && (meta.assignment ? outcome && !outcome.deliveryReceipt && !outcome.disposition
            : meta.completionCallbackPendingAt !== undefined && meta.completionCallbackSentAt === undefined && meta.completionCallbackSuppressedAt === undefined)));
        updated.push({ ...row, assignment, recipientPending, sourceRevision: hash([meta, assignment.revision, row.display, row.health, recipientPending, row.failurePending, this.failureJournals.get(meta.id)]) });
      }
      let changed = false;
      const changedRows: WorkReadModel["changedRows"] = [];
      this.db.exec("SAVEPOINT assignment_refresh");
      try {
        const update = this.db.prepare("UPDATE rows SET state=?, active=?, recipient_pending=?, payload=? WHERE id=?");
        for (const row of updated) {
          if (row.sourceRevision === this.projected.get(row.meta.id)?.sourceRevision) continue;
          update.run(row.assignment.state, ["running", "waiting"].includes(row.assignment.state) ? 1 : 0, row.recipientPending ? 1 : 0, JSON.stringify(row), row.meta.id);
          changedRows.push({ before: this.projected.get(row.meta.id), after: row });
          changed = true;
        }
        this.db.exec("RELEASE assignment_refresh");
      } catch (error) { this.db.exec("ROLLBACK TO assignment_refresh; RELEASE assignment_refresh"); throw error; }
      // A crash after application but before acknowledgement safely repeats this batch.
      this.reader.acknowledgeChanges(changes, false);
      snapshot.commit();
      for (const row of updated) this.projected.set(row.meta.id, row);
      if (this.reader.changeMetrics.more || this.reader.changeMetrics.pending) this.dirty = true;
      this.coordinator = snapshot.revision;
      this.counters.assignmentProjections += updated.length; this.counters.projections += updated.length;
      this.invalidations.assignmentInput += updated.length;
      this.changedRows = changedRows;
      if (this.assignmentFault) {
        this.state = this.assignmentFault.state; this.reason = this.assignmentFault.reason;
        this.assignmentFault = undefined; this.changedRows = []; changed = true;
      }
      if (changed) this.publish();
    } catch (error) {
      release?.(); release = undefined;
      if (!this.projected.size) return;
      // A coordinator has never been required for plain archived/log-only runs.
      // Losing an already observed database still degrades the existing coverage.
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && this.coordinator === "unknown") return;
      if (error instanceof Error && error.message === "Unsupported assignment source schema") this.unsupportedAssignmentRevision = revision;
      this.assignmentFault ??= { state: this.state, reason: this.reason };
      if (String(error).includes("no such table: assignment_change_source")) {
        // Old sources have no feed. Finish one budgeted compatibility pass;
        // continuous legacy writes do not restart a pass already in progress.
        this.imported = false; this.repairOwed = true; this.state = "rebuilding";
      } else this.state = "degraded";
      this.reason = String(error).slice(0, 512); this.publish();
    } finally { release?.(); }
  }

  private scopeStatus(scope: WorkScope): { status: WorkSnapshot["status"]; reason?: string } {
    const race = this.sourceRace;
    // Only a validated, entity-attributed retry can leave another scope ready.
    // Root, coordinator, unattributed and initial-import failures stay global.
    if (this.imported && this.state === "degraded" && race && this.reason === race.reason
        && [...this.sourceErrors.keys()].every(path => race.paths.has(path))
        && !race.rows.some(row => this.matchesScope({ id: scope.id, cwd: scope.cwd, sessionId: scope.sessionId }, row))) {
      return { status: "ready" };
    }
    return { status: this.state, reason: this.reason };
  }

  private rejectUnsupportedAssignmentRevision(): boolean {
    let release: (() => void) | undefined;
    try {
      if (this.unsupportedAssignmentRevision) {
        if (this.unsupportedAssignmentRevision === this.reader.revision()) return true;
        this.unsupportedAssignmentRevision = undefined;
      }
      const connection = this.reader.connection(false);
      const supported = (version: unknown) => version === undefined || (typeof version === "string" && ["1", "2", "3", "4"].includes(version));
      if (!connection || supported(connection.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()?.value)) return false;
      const snapshot = this.reader.beginSnapshot(); release = snapshot.release;
      const version = this.reader.connection(false).prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()?.value;
      if (!supported(version)) {
        this.unsupportedAssignmentRevision = snapshot.revision;
        const reason = "Unsupported assignment source schema";
        const changed = this.state !== "degraded" || this.reason !== reason;
        this.state = "degraded"; this.reason = reason;
        if (changed) this.publish();
        return true;
      }
    } catch {
      // Missing/initializing sources still follow the ordinary verification path.
      this.unsupportedAssignmentRevision = undefined;
    } finally { release?.(); }
    return false;
  }

  reconcile(drain = true): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pending) {
      return drain && this.checkpoints.ready ? this.pending.then(() => this.reconcile()) : this.pending;
    }
    const release = this.budget.enter("repair");
    if (!release) return Promise.resolve();
    this.pending = (async () => {
      for (const root of [this.runs, this.archives, this.markers]) this.watchRootParent(root);
      await this.watchRegistrations();
      if (this.closed) return;
      if (!this.checkpoints.ready) {
        if (!this.checkpointAttemptAllowed || this.checkpointFailure) return;
        this.checkpointAttemptAllowed = false;
        let initialized: boolean;
        try { initialized = this.checkpoints.initialize(); }
        catch (error) { this.checkpointFailure = true; throw error; }
        if (!initialized) {
          const reason = "Checkpoint acquisition is contended; source coverage remains unverified.";
          if (this.reason !== reason) { this.state = "rebuilding"; this.reason = reason; this.publish(); }
          return;
        }
      }
      let resetRepair = drain;
      do {
        this.dirty = false;
        // Background progress is independent of whether Subagent repair finds files.
        if (this.background.refresh()) this.publish(true);
        this.refreshAssignments();
        // Metadata repair cannot verify an incompatible coordinator. Keep its
        // obligations and last verified rows until a different source revision.
        if (this.unsupportedAssignmentRevision || this.rejectUnsupportedAssignmentRevision()) break;
        if (resetRepair && this.repair) { await this.repair.return(undefined); this.repair = undefined; }
        resetRepair = false;
        if (this.hints.size) {
          const entries = workPage(this.hints);
          for (const [path, queued] of entries) { this.hints.delete(path); this.scheduling.maxQueueAgeMs = Math.max(this.scheduling.maxQueueAgeMs, Date.now() - queued); }
          this.scheduling.entityBatches++;
          const started = performance.now();
          await this.measuredScan("entity", entries.map(([path]) => path));
          this.scheduling.maxPublicationMs = Math.max(this.scheduling.maxPublicationMs, performance.now() - started);
        }
        if (!this.repair && this.imported && !drain && !this.repairOwed) {
          if (this.hints.size) { await yieldTurn(); continue; }
          break;
        }
        this.repair ??= this.repairPaths();
        const next = await this.repair.next();
        if (next.done) {
          await this.watchRegistrations();
          this.repair = undefined; this.repairOwed = false;
          // An empty metadata inventory still needs a journal baseline before
          // later exact hints can be treated as incremental updates.
          if (!this.imported && !this.assignmentBaseline && !this.files.size && !this.sourceErrors.size) this.refreshAssignments(true);
          if (this.assignmentBaseline && !this.sourceErrors.size && ![...this.projected.values()].some(row => !row.assignment.verified)) this.reader.acknowledgeChanges(new Map([["*", this.assignmentBaseline.seq]]), true);
          if (!this.imported) {
            this.imported = true;
            const degraded = this.state === "degraded" || this.sourceErrors.size || [...this.projected.values()].some(row => !row.assignment.verified);
            this.state = degraded ? "degraded" : "ready";
            this.reason = this.state === "ready" ? undefined : this.sourceErrors.values().next().value ?? this.reason ?? "Some assignment sources could not be verified.";
            this.publish();
          }
        }
        else { this.scheduling.repairBatches++; this.scheduling.repairEntries += next.value.length; await this.measuredScan("repair", next.value); }
        await yieldTurn();
        if (this.closed || (!drain && !this.hints.size)) break;
      } while (this.repair || this.hints.size);
    })().catch(error => {
      this.repair = undefined; this.state = "degraded"; this.reason = String(error).slice(0, 512); this.publish();
    }).finally(() => {
      release();
      this.pending = undefined;
      if (this.checkpoints.ready && (this.hints.size || this.dirty) && !this.closed && !this.unsupportedAssignmentRevision) { this.dirty = false; void this.reconcile(false); }
    });
    return this.pending;
  }

  private async measuredScan(kind: "entity" | "repair", paths: string[]) {
    const before = { stats: this.sourceStats, metadataReads: this.counters.metadataReads };
    await this.scan(paths, kind);
    const counter = this.sourceWork[kind]; counter.batches++; counter.paths += paths.length;
    counter.stats += this.sourceStats - before.stats; counter.metadataReads += this.counters.metadataReads - before.metadataReads;
  }

  private measuredLogRead<T>(kind: "entity" | "repair", read: () => T): T {
    const bytes = logReadMetrics.bytes, reads = logReadMetrics.reads;
    try { return read(); }
    finally {
      this.sourceWork[kind].logBytes += logReadMetrics.bytes - bytes;
      this.sourceWork[kind].logReads += logReadMetrics.reads - reads;
    }
  }

  private async watchRegistrations() {
    await Promise.all([...this.watchers.values(), ...[...this.rootParents.values()].map(value => value.watcher)].map(watcher => watcher.ready));
  }

  private async scan(paths: string[], kind: "entity" | "repair" = "repair") {
    this.assignmentFault = undefined;
    const sourceStat: typeof stat = ((...args: any[]) => { this.sourceStats++; return (stat as any)(...args); }) as typeof stat;
    this.counters.inventories++;
    let releaseCoordinator: (() => void) | undefined;
    let commitCoordinator: (() => void) | undefined;
    const checkpointWrites: Array<[string, unknown]> = [];
    const parseBefore = new Map(this.parseStates), healthBefore = new Map(this.healthStates);
    let sourceRace: WorkReadModel["sourceRace"];
    const baseline = this.staged ?? { files: this.files, projected: this.projected, logs: this.logs, failureJournals: this.failureJournals, processes: this.processes,
      healthRevision: this.healthRevision, coordinator: this.coordinator };
    try {
      const next = new Map(baseline.files);
      const failedPaths = new Map<string, string>();
      const malformedPaths = new Set<string>();
      let batch = 0;
      let sliceStarted = performance.now();
      for (const [directory, archived] of [[this.markers, true], [this.archives, true], [this.runs, false]] as const) {
        const names = paths.filter(path => archived ? path.startsWith(directory + sep) && !path.slice(directory.length + 1).includes(sep)
          : path.startsWith(directory + sep)).map(path => archived ? path.slice(directory.length + 1) : path.slice(directory.length + 1).split(sep)[0]!);
        // Bound filesystem concurrency without serializing every archive round trip.
        const candidates = names.filter(name => safeId.test(archived ? name.replace(/\.json$/, "") : name)
          && (!archived || name.endsWith(".json")));
        for (let offset = 0; offset < candidates.length; offset += 32) {
          const group = candidates.slice(offset, offset + 32);
          const observations = await Promise.all(group.map(async name => {
            if (!archived) this.watchDirectory(join(directory, name));
            const path = archived ? join(directory, name) : join(directory, name, "meta.json");
            try { return { info: await sourceStat(path, { bigint: true }) }; }
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
              let entry = next.get(path);
              if (entry?.signature !== signature) {
                if (info.size > 1024n * 1024n) throw new Error(`Run metadata exceeds the 1 MiB observation budget: ${id}`);
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
              if (!archived && error instanceof SyntaxError && this.files.has(path)) malformedPaths.add(path);
              if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                try {
                  await sourceStat(directory);
                  next.delete(path);
                  if (!archived) {
                    // A mkdir notification can arrive before its metadata commit.
                    // Retire the inode watcher only when the directory is gone.
                    try { await sourceStat(join(directory, name)); }
                    catch (error) {
                      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                      this.unwatchDirectory(join(directory, name));
                    }
                  }
                } catch {
                  failedPaths.set(path, `Source directory unavailable; retaining verified records: ${directory}`);
                }
              } else failedPaths.set(path, String(error).slice(0, 512));
              if (failedPaths.has(path)) {
                const verified = this.files.get(path);
                if (verified) next.set(path, verified);
                else next.delete(path);
              }
            }
            if (++batch % 256 === 0 || performance.now() - sliceStarted >= 8) {
              await yieldTurn(); sliceStarted = performance.now();
            }
            if (this.closed) return;
          }
        }
      }
      let assignmentChanges: Map<string, string> | undefined;
      try { assignmentChanges = this.reader.changes(); } catch { /* Legacy sources retain bounded repair. */ }
      let coordinator: string;
      try {
        const snapshot = this.reader.beginSnapshot();
        coordinator = snapshot.revision; releaseCoordinator = snapshot.release; commitCoordinator = snapshot.commit;
      } catch { coordinator = "unknown"; }
      if (assignmentChanges?.has("*")) {
        const seq = assignmentChanges.get("*")!;
        const key = `${this.reader.changeMetrics.generation}:${seq}`;
        if (this.assignmentBaseline?.key !== key) {
          this.assignmentBaseline = { key, seq };
          if (this.imported) {
            this.imported = false; this.repairOwed = true;
            await this.repair?.return(undefined); this.repair = undefined;
          }
        }
      }
      const logs = new Map<string, string>();
      const failureJournals = new Map<string, string>();
      const processes = new Map<string, string>();
      const logFamilies = new Set<string>();
      const terminalLogChanges: string[] = [];
      for (const [path, entry] of next) {
        if (!path.startsWith(this.runs + sep)) continue;
        if (failedPaths.has(path)) {
          const id = entry.meta.id;
          if (this.logs.has(id)) logs.set(id, this.logs.get(id)!);
          if (this.failureJournals.has(id)) failureJournals.set(id, this.failureJournals.get(id)!);
          if (this.processes.has(id)) processes.set(id, this.processes.get(id)!);
          continue;
        }
        if (!paths.includes(path)) {
          const id = entry.meta.id;
          if (baseline.logs.has(id)) logs.set(id, baseline.logs.get(id)!);
          if (baseline.failureJournals.has(id)) failureJournals.set(id, baseline.failureJournals.get(id)!);
          if (baseline.processes.has(id)) processes.set(id, baseline.processes.get(id)!);
          continue;
        }
        let signature = baseline.logs.get(entry.meta.id);
        {
          try {
            const info = await sourceStat(join(this.runs, entry.meta.id, "output.log"), { bigint: true });
            signature = `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
          } catch (error) { signature = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unverified"; }
        }
        logs.set(entry.meta.id, signature);
        if ((signature !== this.logs.get(entry.meta.id) || this.files.get(path)?.meta.status !== entry.meta.status) && entry.meta.status !== "running"
            && entry.meta.management?.root === this.agentDir) terminalLogChanges.push(entry.meta.id);
        if (signature !== baseline.logs.get(entry.meta.id)) logFamilies.add(entry.meta.id);
        const failureSignature = (await Promise.all(["failures.jsonl", "failures.jsonl.observed"].map(async name => {
          try { const info = await sourceStat(join(this.runs, entry.meta.id, name), { bigint: true }); return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`; }
          catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unverified"; }
        }))).join(":");
        failureJournals.set(entry.meta.id, failureSignature);
        if (failureSignature !== baseline.failureJournals.get(entry.meta.id)) logFamilies.add(entry.meta.id);

        const status = effectiveStatus(entry.meta); processes.set(entry.meta.id, status);
        if (status !== baseline.processes.get(entry.meta.id)) logFamilies.add(entry.meta.id);
        if (performance.now() - sliceStarted >= 8) { await yieldTurn(); sliceStarted = performance.now(); }
      }
      const healthConfig = await readHealthConfig(this.agentDir, next.size > 0);
      if (healthConfig.revision !== baseline.healthRevision) this.counters.healthConfigInvalidations++;
      const changed = next.size !== baseline.files.size || [...next].some(([path, entry]) => baseline.files.get(path)?.signature !== entry.signature);
      const now = Date.now();
      const deadlineExpired = [...baseline.projected.values()].some(row => healthDeadlineExpired(row, now));
      const rawDirectories = [...new Set(paths.filter(path => path.startsWith(this.runs + sep) && next.has(path)).map(path => dirname(path)))];
      const rearmRawDirectories = () => {
        if (!rawDirectories.length) return;
        this.watchDirectory(this.runs);
        for (const directory of rawDirectories) this.watchDirectory(directory);
      };
      // A delayed mkdir notification may retire a watch during the awaited reads.
      rearmRawDirectories();
      await this.watchRegistrations();
      if (!this.staged && !changed && !failedPaths.size && !this.sourceErrors.size && !logFamilies.size && !assignmentChanges?.size && !deadlineExpired && coordinator === this.coordinator && healthConfig.revision === this.healthRevision && !healthConfig.reason && this.state === "ready") return;
      const metas = new Map<string, any>();
      const markers = new Map([...next].filter(([path]) => path.startsWith(this.markers + sep)).map(([, entry]) => [entry.meta.sessionId, entry.meta]));
      for (const [path, entry] of next) {
        if (path.startsWith(this.markers + sep)) continue;
        // Compact archives omit volatile delivery markers. A verified live
        // record wins independently of which source was discovered last.
        if (path.startsWith(this.archives + sep) && next.has(join(this.runs, entry.meta.id, "meta.json"))) continue;
        const marker = markers.get(entry.meta.sessionId);
        if (path.startsWith(this.archives + sep) && marker && marker.attemptId !== entry.meta.id && marker.startedAt >= entry.meta.startedAt) continue;
        metas.set(entry.meta.id, entry.meta);
      }
      const attempts = [...metas.values()];
      const affected = new Set<string>();
      const family = (meta: any) => JSON.stringify([meta.sessionId, meta.cwd]);
      const lineage = new Map<string, any[]>();
      for (const candidate of [...baseline.projected.values()].map(row => row.meta).concat(attempts)) {
        if (!candidate.operations?.resumeLaunchToken) continue;
        const key = family(candidate), group = lineage.get(key) ?? [];
        group.push(candidate); lineage.set(key, group);
      }
      const invalidateAttempt = (meta: any) => {
        const related = lineage.get(family(meta)) ?? [];
        const ids = new Set([meta.id]);
        let grew = true;
        while (grew) {
          grew = false;
          for (const candidate of related) {
            if (!candidate.operations?.resumeLaunchToken || family(candidate) !== family(meta)
                || (meta.assignment && candidate.assignment?.assignmentId !== meta.assignment.assignmentId)) continue;
            if (ids.has(candidate.id) || ids.has(candidate.resumedFrom)) {
              for (const id of [candidate.id, candidate.resumedFrom]) if (id && !ids.has(id)) { ids.add(id); grew = true; }
            }
          }
        }
        for (const id of ids) affected.add(id);
      };
      for (const [path, entry] of [...baseline.files, ...next]) {
        if (baseline.files.get(path)?.signature !== next.get(path)?.signature) {
          if (path.startsWith(this.markers + sep)) {
            for (const meta of attempts) if (meta.sessionId === entry.meta.sessionId) invalidateAttempt(meta);
          } else invalidateAttempt(entry.meta);
        }
      }
      const assignmentGeneration = this.reader.changeMetrics.generation;
      // An unpublished retry may reuse a verified projection only at the same
      // durable source generation and per-scope position. Receipt stays pending.
      const changedScope = (scope: string) => assignmentChanges?.has(scope)
        && (!this.staged || this.staged.assignmentGeneration !== assignmentGeneration
          || this.staged.assignmentChanges?.get(scope) !== assignmentChanges.get(scope));
      for (const meta of attempts) {
        if (!(meta.assignment || meta.operations || meta.park)) continue;
        const session = meta.assignment?.owner?.sessionId ?? meta.operations?.conversationId ?? meta.sessionId;
        const workspace = meta.assignment?.owner?.workspace ?? meta.operations?.workspace ?? meta.cwd;
        if ((changedScope("*") && paths.some(path => next.get(path)?.meta.id === meta.id))
            || changedScope(JSON.stringify([session, workspace, meta.assignment?.assignmentId ?? null]))
            || changedScope(JSON.stringify([session, workspace, null]))
            || (!assignmentChanges && paths.some(path => next.get(path)?.meta.id === meta.id))) invalidateAttempt(meta);
      }
      const project = createAssignmentProjector({ attempts, observe: (owner: any) => this.reader.read(owner) });
      const touched = new Set(paths.map(path => next.get(path)?.meta.id));
      const rows = [];
      let logError: string | undefined;
      for (const meta of attempts) {
        let row = baseline.projected.get(meta.id);
        const assignmentChanged = !row || (!row.assignment.verified && touched.has(meta.id)) || affected.has(meta.id) || processes.get(meta.id) !== baseline.processes.get(meta.id);
        const logChanged = !row || logs.get(meta.id) !== baseline.logs.get(meta.id);
        const failureChanged = !row || failureJournals.get(meta.id) !== baseline.failureJournals.get(meta.id);
        const deadlineChanged = row && healthDeadlineExpired(row, now);
        if (row && !assignmentChanged && !logChanged && !failureChanged && (healthConfig.revision !== baseline.healthRevision || deadlineChanged)) {
          if (healthConfig.revision !== baseline.healthRevision) this.invalidations.healthConfig++;
          if (deadlineChanged) this.invalidations.healthDeadline++;
          this.counters.healthRecomputations++;
          const health = healthWithThresholds(row.health, healthConfig.config, meta);
          row = { ...row, health, sourceRevision: hash([meta, row.assignment.revision, row.display, health, row.recipientPending, row.failurePending, failureJournals.get(meta.id)]) };
        } else if (assignmentChanged || logChanged || failureChanged) {
          if (!row) this.invalidations.initial++;
          else {
            if (affected.has(meta.id)) this.invalidations.assignmentInput++;
            if (!row.assignment.verified) this.invalidations.unverified++;
            if (processes.get(meta.id) !== baseline.processes.get(meta.id)) this.invalidations.process++;
            if (logChanged) this.invalidations.log++;
            if (failureChanged) this.invalidations.failureAttention++;
            if (healthConfig.revision !== baseline.healthRevision) this.invalidations.healthConfig++;
            if (deadlineChanged) this.invalidations.healthDeadline++;
          }
          this.counters.projections++;
          if (assignmentChanged) this.counters.assignmentProjections++;
          const assignment = assignmentChanged ? project(meta, processes.get(meta.id) ?? meta.status) : row!.assignment;
          let display = row?.display, health = row?.health;
          if (logChanged) this.measuredLogRead(kind, () => withLogReadBatch(() => {
            this.counters.logProjections++; this.counters.healthProjections++;
            const logPath = join(this.runs, meta.id, "output.log");
            const unavailable = (reason: string) => {
              const verified = this.projected.get(meta.id);
              const error = `Log source unavailable: ${reason}`;
              display = { ...(verified?.display ?? { spend: "", tool: "" }),
                diagnostics: [...(verified?.display?.diagnostics ?? []).filter(value => value !== verified?.display?.coverage?.error), error],
                coverage: { ...verified?.display?.coverage, complete: false, error } };
              health = verified?.health ?? health ?? extractChildEventFactsFromLog(meta.id, { logPath, states: this.healthStates });
              if (health) health = { ...health, rawLog: { ...health.rawLog, error }, coverage: { ...health.coverage, complete: false, error } };
              // Failed transient folds must not replace durable verified state or
              // accumulate beyond the normal hot-cache budget.
              this.parseStates.delete(logPath); this.healthStates.delete(logPath);
            };
            // Archive-only records do not promise raw-log coverage. A raw record
            // with an unavailable source retains verified facts, not a zero fold.
            if (!logs.has(meta.id)) { display = { spend: "", tool: "" }; health = undefined; return; }
            if (["missing", "unverified"].includes(logs.get(meta.id)!)) { unavailable(`${logs.get(meta.id)}: ${logPath}`); return; }
            const priorDisplay = parseBefore.get(logPath), priorHealth = healthBefore.get(logPath);
            if (priorDisplay && this.parseStates.get(logPath) === priorDisplay)
              this.parseStates.set(logPath, decodeParseLogState(structuredClone(encodeParseLogState(priorDisplay))));
            if (priorHealth && this.healthStates.get(logPath) === priorHealth)
              this.healthStates.set(logPath, decodeHealthLogState(structuredClone(encodeHealthLogState(priorHealth))));
            if (!this.parseStates.has(logPath) || !this.healthStates.has(logPath)) {
              const saved = this.checkpoints.load(logPath);
              if (saved) {
                try {
                  if (!Number.isSafeInteger(saved.display.cursor.offset) || !Number.isSafeInteger(saved.health.cursor.offset)) throw new Error("Invalid checkpoint offset");
                  this.parseStates.set(logPath, decodeParseLogState(saved.display));
                  this.healthStates.set(logPath, decodeHealthLogState(saved.health));
                } catch { this.parseStates.delete(logPath); this.healthStates.delete(logPath); }
              }
            }
            const parsed = logs.get(meta.id) && logs.get(meta.id) !== "missing" ? parseRunDisplay(meta.id, { logPath, states: this.parseStates, summaryOnly: true }) : undefined;
            display = { spend: parsed ? fmtSpend(parsed.usage) : "", tool: parsed?.tool ?? "" };
            health = logs.has(meta.id) ? extractChildEventFactsFromLog(meta.id, { logPath, states: this.healthStates }) : undefined;
            const displayState = this.parseStates.get(logPath), healthState = this.healthStates.get(logPath);
            const readError = displayState?.error ?? health?.rawLog?.error;
            if (readError) { unavailable(readError); return; }
            display = { ...display!, diagnostics: parsed?.diagnostics, coverage: displayState ? {
              start: displayState.cursor.coverageStart ?? 0, offset: displayState.cursor.offset,
              totalBytes: displayState.totalBytes, missing: displayState.cursor.missing,
              complete: !displayState.error && !displayState.cursor.missing && !displayState.catchingUp && !displayState.windowTruncated && displayState.cursor.offset === displayState.totalBytes,
            } : undefined };
            if (health && healthState) health = { ...health, coverage: { start: healthState.cursor.coverageStart ?? 0,
              offset: healthState.cursor.offset, missing: healthState.cursor.missing } };
            if (displayState?.catchingUp) logs.set(meta.id, `${logs.get(meta.id)}:catching-up`);
            if (displayState && healthState) checkpointWrites.push([logPath, {
              display: encodeParseLogState(displayState), health: encodeHealthLogState(healthState),
            }]);
            while (this.parseStates.size > 64) this.parseStates.delete(this.parseStates.keys().next().value);
            while (this.healthStates.size > 64) this.healthStates.delete(this.healthStates.keys().next().value);
          }));
          if (logChanged || assignmentChanged || deadlineChanged || healthConfig.revision !== baseline.healthRevision) {
            this.counters.healthRecomputations++;
            health = healthWithThresholds(health, healthConfig.config, meta);
          }
          const outcome = meta.assignment ? this.reader.read({ ...meta.assignment.owner, assignmentId: meta.assignment.assignmentId }).outcome : undefined;
          if (failureChanged || assignmentChanged) this.counters.failureProjections++;
          const failurePending = !failureChanged && !assignmentChanged ? row!.failurePending : meta.callback !== false && failureJournals.has(meta.id) && Boolean(pendingFailureAttention(
            readFailureStateReadOnly(join(this.runs, meta.id, "failures.jsonl")), Date.now(),
            { terminal: !["running", "orphaned"].includes(meta.status), deferObservationGaps: meta.status === "running" }));
          const recipientPending = Boolean(failurePending || meta.timing?.pendingWakes?.length
            || (meta.status === "orphaned" && meta.orphanedCallbackSentAt === undefined && meta.orphanedCallbackSuppressedAt === undefined)
            || (meta.status === "lost" && meta.lostCallbackSentAt === undefined && meta.lostCallbackSuppressedAt === undefined)
            || (meta.callback !== false && (meta.assignment ? outcome && !outcome.deliveryReceipt && !outcome.disposition
              : meta.completionCallbackPendingAt !== undefined && meta.completionCallbackSentAt === undefined && meta.completionCallbackSuppressedAt === undefined)));
          row = { meta, assignment, display, health, recipientPending, failurePending, sourceRevision: hash([meta, assignment.revision, display, health, recipientPending, failurePending, failureJournals.get(meta.id)]) };
        }
        rows.push(row!);
        logError ??= row?.display?.coverage?.error;
        if (++batch % 256 === 0 || performance.now() - sliceStarted >= 8) {
          await yieldTurn(); sliceStarted = performance.now();
        }
      }
      const globallyUnverified = !!healthConfig.reason || rows.some(row => !row.assignment.verified);
      // The pinned source snapshot is a valid baseline even while writers advance.
      // Subsequent commits remain beyond the durable received position.
      // revision() validates the source inode while the transaction pins data_version.
      // Ignore unrelated later commits, but never publish a replaced coordinator.
      if (coordinator !== "unknown") this.reader.revision();
      // Retry caches are never queryable. Validate all unpublished families again before committing them.
      this.staged = { files: next, projected: new Map(rows.map(row => [row.meta.id, row])), logs, failureJournals, processes,
        healthRevision: healthConfig.revision, coordinator, assignmentChanges: assignmentChanges && new Map(assignmentChanges),
        assignmentGeneration };
      const uncommitted = new Set(affected);
      for (const [path, entry] of [...this.files, ...next]) {
        if (this.files.get(path)?.signature !== next.get(path)?.signature) uncommitted.add(entry.meta.id);
      }
      const verify = [...next].filter(([path, entry]) => !failedPaths.has(path) && uncommitted.has(entry.meta.id));
      for (let offset = 0; offset < verify.length; offset += 32) {
        const group = verify.slice(offset, offset + 32);
        const observations = await Promise.all(group.map(async ([path]) => {
          try { return { info: await sourceStat(path, { bigint: true }) }; }
          catch (error) { return { error }; }
        }));
        for (const [index, [path, entry]] of group.entries()) {
          const observation = observations[index]!;
          if (!observation.info) {
            if ((observation.error as NodeJS.ErrnoException)?.code === "ENOENT") {
              this.dirty = true;
              // The source may have moved to an archive whose hint was lost.
              // Reobserve the batch and owe existing bounded discovery without
              // resetting an in-progress repair cursor or inventing membership.
              this.repairOwed = true;
            }
            throw observation.error;
          }
          const info = observation.info;
          if (`${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` !== entry.signature) {
            this.dirty = true;
            const error = new Error("Source changed during observation; retaining the previous snapshot while reconciling.");
            if (!globallyUnverified && (this.state === "ready" || this.sourceRace && this.reason === this.sourceRace.reason)
                && path.startsWith(this.runs + sep) && info.size <= 1024n * 1024n && !failedPaths.size && [...this.sourceErrors].every(([path, reason]) =>
              this.sourceRace?.paths.has(path) && reason === this.sourceRace.reason)) {
              // Recheck only for error routing: a concurrent move can affect a
              // new workspace/recipient. Never publish this uncommitted row.
              try {
                this.counters.metadataReads++;
                const current = JSON.parse(await readFile(path, "utf8"));
                const checked = await sourceStat(path, { bigint: true });
                if (current?.id === entry.meta.id && typeof current.cwd === "string" && Number.isFinite(current.startedAt)
                    && typeof current.status === "string" && checked.size <= 1024n * 1024n
                    && `${checked.dev}:${checked.ino}:${checked.size}:${checked.mtimeNs}:${checked.ctimeNs}` === `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`) {
                  sourceRace = { reason: String(error), paths: new Set(paths), rows: [
                    ...[...uncommitted].flatMap(id => [this.projected.get(id), this.staged?.projected.get(id)].filter(Boolean)),
                    { meta: current, assignment: { state: current.status } }] };
                }
              } catch { /* Unreadable/unstable routing evidence keeps degradation global. */ }
            }
            throw error;
          }
          if (++batch % 256 === 0 || performance.now() - sliceStarted >= 8) {
            await yieldTurn(); sliceStarted = performance.now();
          }
        }
      }
      if (this.closed) return;
      rearmRawDirectories();
      await this.watchRegistrations();
      if (!commitCoordinator) this.db.exec("BEGIN");
      const insert = this.db.prepare("INSERT OR REPLACE INTO rows VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      const remove = this.db.prepare("DELETE FROM rows WHERE id = ?");
      let semanticChange = false;
      const changedRows: WorkReadModel["changedRows"] = [];
      const publishCheckpoints: Array<() => void> = [];
      try {
        for (const id of this.projected.keys()) if (!metas.has(id)) { changedRows.push({ before: this.projected.get(id) }); remove.run(id); this.db.prepare("DELETE FROM assignment_members WHERE id=?").run(id); this.db.prepare("DELETE FROM terminal_log_folds WHERE id=?").run(id); semanticChange = true; }
        for (const id of terminalLogChanges) this.db.prepare("INSERT INTO terminal_log_folds VALUES (?, ?, 1, ?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, pending=1, queue_position=CASE WHEN terminal_log_folds.pending=0 THEN excluded.queue_position ELSE terminal_log_folds.queue_position END").run(id, hash([logs.get(id), metas.get(id)?.status]), ++this.foldQueueSequence);
        for (const row of rows) {
          if (this.projected.get(row.meta.id)?.sourceRevision === row.sourceRevision) continue;
          semanticChange = true;
          changedRows.push({ before: this.projected.get(row.meta.id), after: row });
          const m = row.meta;
          if (m.management?.root !== this.agentDir || m.status === "running") this.db.prepare("DELETE FROM terminal_log_folds WHERE id=?").run(m.id);
          insert.run(m.id, m.cwd, m.callbackOrigin?.cwd ?? m.cwd, m.callbackOrigin?.sessionId ?? null,
            m.startedAt, row.assignment.state, ["running", "waiting"].includes(row.assignment.state) ? 1 : 0, m.endedAt ?? m.lostAt ?? null, row.recipientPending ? 1 : 0, JSON.stringify(row));
          this.db.prepare("DELETE FROM assignment_members WHERE id=?").run(m.id);
          const session = m.assignment?.owner?.sessionId ?? m.operations?.conversationId ?? m.sessionId;
          const workspace = m.assignment?.owner?.workspace ?? m.operations?.workspace ?? m.cwd;
          for (const assignmentId of new Set([m.assignment?.assignmentId ?? null, null])) this.db.prepare("INSERT INTO assignment_members VALUES(?,?)").run(JSON.stringify([session, workspace, assignmentId]), m.id);
        }
        for (const [path, checkpoint] of checkpointWrites) publishCheckpoints.push(this.checkpoints.save(path, checkpoint, true));
        // Application and its exact acknowledgement share the owner commit.
        if (assignmentChanges && rows.every(row => row.assignment.verified)) this.reader.acknowledgeChanges(assignmentChanges, false);
        if (commitCoordinator) commitCoordinator(); else this.db.exec("COMMIT");
      } catch (error) {
        if (releaseCoordinator) releaseCoordinator(); else this.db.exec("ROLLBACK");
        throw error;
      }
      for (const publish of publishCheckpoints) publish();
      this.files = next; this.logs = logs; this.failureJournals = failureJournals; this.processes = processes; this.healthRevision = healthConfig.revision; this.coordinator = coordinator; this.inventory++;
      this.projected = new Map(rows.map(row => [row.meta.id, row]));
      for (const states of [this.parseStates, this.healthStates]) for (const path of states.keys()) {
        if (!metas.has(path.slice(this.runs.length + 1).split(sep)[0])) states.delete(path);
      }
      this.staged = undefined;
      if (terminalLogChanges.length) this.onTerminalLogsChanged?.();
      const previousState = this.state;
      const previousReason = this.reason;
      for (const path of paths) {
        const error = failedPaths.get(path);
        if (error) this.sourceErrors.set(path, error);
        else this.sourceErrors.delete(path);
      }
      // Incomplete raw writes retain their verified namespace, not partial JSON.
      // New/unknown records and mixed failures cannot be narrowed this way.
      if (globallyUnverified) this.sourceRace = undefined;
      if (!globallyUnverified && failedPaths.size && failedPaths.size === malformedPaths.size
          && (previousState === "ready" || this.sourceRace && previousReason === this.sourceRace.reason)
          && [...this.sourceErrors.keys()].every(path => malformedPaths.has(path))) {
        this.sourceRace = { reason: failedPaths.values().next().value!, paths: malformedPaths,
          rows: [...malformedPaths].map(path => this.projected.get(this.files.get(path)!.meta.id)) };
      }
      if (!this.sourceErrors.size) this.sourceRace = undefined;
      this.state = this.sourceErrors.size || healthConfig.reason || logError ? "degraded" : !this.imported ? "rebuilding" : rows.some(row => !row.assignment.verified) ? "degraded" : "ready";
      this.reason = this.sourceErrors.values().next().value ?? healthConfig.reason ?? logError ?? (this.state === "rebuilding" ? "Initial source inventory is rebuilding." : this.state === "degraded" ? "Some assignment sources could not be verified." : undefined);
      if ((this.imported || paths.length === 128) && (semanticChange || previousState !== this.state || previousReason !== this.reason)) {
        this.changedRows = changedRows;
        this.publish();
      }
    } catch (error) {
      releaseCoordinator?.(); releaseCoordinator = undefined;
      this.parseStates = parseBefore; this.healthStates = healthBefore;
      if (this.closed) return;
      const reason = String(error).slice(0, 512);
      this.sourceRace = sourceRace;
      if (this.dirty) for (const path of paths) if (!this.hints.has(path)) this.hints.set(path, Date.now());
      for (const path of paths) this.sourceErrors.set(path, reason);
      const changed = this.state !== "degraded" || this.reason !== reason;
      this.state = "degraded"; this.reason = reason;
      if (changed) this.publish();
    } finally { releaseCoordinator?.(); }
  }

  /** Derived pending index: no unbounded JavaScript backlog and no dropped IDs. */
  terminalLogChanges(): Array<{id: string; revision: string}> {
    return this.db.prepare("SELECT id, revision FROM terminal_log_folds WHERE pending=1 ORDER BY queue_position, id LIMIT 128").all();
  }
  acknowledgeTerminalLogs(batch: Array<{id: string; revision: string}>) {
    if (this.closed) return;
    if (this.reader.snapshotActive && this.pending) {
      void this.pending.then(() => this.acknowledgeTerminalLogs(batch));
      return;
    }
    const acknowledge = this.db.prepare("UPDATE terminal_log_folds SET pending=CASE WHEN revision=? THEN 0 ELSE 1 END, queue_position=? WHERE id=?");
    // A newer revision remains owed, but rejoins behind existing obligations.
    // Continuously changing low IDs cannot monopolize every subsequent batch.
    for (const entry of batch) acknowledge.run(entry.revision, ++this.foldQueueSequence, entry.id);
  }

  snapshot(scope: WorkScope = {}): WorkSnapshot {
    if (scope.background) {
      if (scope.backgroundHistory && this.background.refresh()) this.publish(true);
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
        activity: { active }, nextDeadline: scope.backgroundHistory ? null : this.background.nextDeadline(scope) };
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
    const key = this.scopeKey(scope);
    const entry = this.scopeEntry(scope);
    const totalMatching = Number(this.db.prepare(`SELECT count(*) AS n FROM rows ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""}`).get(...args).n);
    if (scope.cursor) {
      let cursor;
      try { cursor = JSON.parse(Buffer.from(scope.cursor, "base64url").toString()); } catch { throw new Error("Invalid runtime cursor"); }
      if (!Array.isArray(cursor) || cursor[0] !== key || cursor[1] !== this.instanceId || cursor[2] !== `${entry.token}:${entry.revision}`) throw new Error("resync_required: cursor snapshot changed");
      clauses.push("(started < ? OR (started = ? AND id < ?))"); args.push(cursor[3], cursor[3], cursor[4]);
    }
    const limit = Math.max(1, Math.min(200, Number.isSafeInteger(scope.limit) ? scope.limit! : 50));
    const records = this.db.prepare(`SELECT payload, started, id FROM rows ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""} ORDER BY started DESC, id DESC LIMIT ?`).all(...args, limit + 1);
    const page = records.slice(0, limit), last = page.at(-1);
    const now = Date.now();
    const rows = page.map((record: any) => {
      const row = JSON.parse(record.payload);
      if (this.unsupportedAssignmentRevision) row.assignment = { ...row.assignment, verified: false, reason: this.reason };
      if (row.health) row.health.nextDeadline = nextHealthDeadline(row.health, row.meta, now);
      return row;
    });
    const deadlines = rows.map((row: any) => row.health?.nextDeadline).filter((deadline: any) => typeof deadline === "number");
    return { instanceId: this.instanceId, runtimeEpoch: this.instanceId, scopeRevision: hash([key, entry.token, entry.revision]), seq: this.revision,
      observedRevisionVector: { inventory: this.inventory, coordinator: this.coordinator, healthConfig: this.healthRevision }, ...this.scopeStatus(scope),
      totalMatching,
      rows: page.map((record: any, index: number) => {
        const row = rows[index];
        if (scope.detail && scope.id) {
          let cached = this.details.get(row.meta.id);
          if (!cached || cached.revision !== row.sourceRevision) {
            this.sourceWork.entity.batches++; this.sourceWork.entity.paths++;
            const logPath = join(this.runs, row.meta.id, "output.log");
            const expectedLog = this.logs.get(row.meta.id) ?? "missing";
            const signature = () => {
              this.sourceWork.entity.stats++;
              try { const info = statSync(logPath, { bigint: true }); return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`; }
              catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unverified"; }
            };
            if (signature() !== expectedLog) throw new Error("state-degraded: log changed since the indexed observation; resync required");
            const value = this.measuredLogRead("entity", () => ({ parsed: parseRun(row.meta.id, { logPath }), transcript: readRunTranscript(row.meta.id, { logPath }) }));
            if (signature() !== expectedLog) throw new Error("state-degraded: log changed during detail observation; resync required");
            if (Buffer.byteLength(JSON.stringify(value)) > 3 * 1024 * 1024) throw new Error("state-degraded: detail exceeds the bounded snapshot allowance");
            cached = { revision: row.sourceRevision, value }; this.details.set(row.meta.id, cached);
            if (this.details.size > 16) this.details.delete(this.details.keys().next().value!);
          }
          row.detail = cached.value;
        }
        return { ...row, cursor: Buffer.from(JSON.stringify([key, this.instanceId, `${entry.token}:${entry.revision}`, record.started, record.id])).toString("base64url") };
      }),
      ...(records.length > limit ? { nextCursor: Buffer.from(JSON.stringify([key, this.instanceId, `${entry.token}:${entry.revision}`, last.started, last.id])).toString("base64url") } : {}),
      activity: { active }, nextDeadline: deadlines.length ? Math.min(...deadlines) : null };
  }

  async close() {
    this.closed = true; if (this.timer) clearInterval(this.timer);
    for (const watcher of this.watchers.values()) watcher.close();
    for (const { watcher } of this.rootParents.values()) watcher.close();
    this.rootParents.clear();
    this.watchers.clear(); this.rootWatchIdentities.clear();
    await this.pending; await this.repairWrite; this.listeners.clear(); await this.background.close(); this.reader.close(); this.checkpoints.close(); this.db.close();
    await this.repair?.return(undefined);
  }
}
