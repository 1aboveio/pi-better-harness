import { realpathSync } from "node:fs";
import { saveDefinition, resetRuntimeToBundled, resetUserDefinition, listScopedAgents } from "./domain/catalog/catalog-store.mjs";
import { withAgentSessionSettings, saveAgentSessionDefaults } from "./domain/catalog/agent-session-settings.mjs";
import { saveSkillExposure } from "./domain/catalog/catalog-skill-edits.mjs";
import { parseDefinition } from "./domain/catalog/catalog-schema.mjs";
import { CatalogAdmission } from "./catalog-admission.ts";
import { overlayDigest } from "./domain/catalog/catalog-overlay.mjs";
import { watch, lstatSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { supervisorDecision } from "./supervisor-decisions.ts";
import { SharedReadDiagnosis, type ReadHealth } from "./shared-read-diagnosis.ts";
import { SupervisorAdmission, reviewEnabled } from "./supervisor-admission.ts";
import { CatalogSources } from "./catalog-sources.ts";

/** One server-owned filesystem catalog; registrations belong to the live socket. */
export class SharedCatalog {
  private readonly readDiagnosis = new SharedReadDiagnosis();
  private readonly readHealth?: () => { state: ReadHealth; generation: number } | undefined;
  private readonly supervisor: SupervisorAdmission;
  readonly sources = new CatalogSources();
  private agentDir: string;
  readonly admission: CatalogAdmission;
  private observers = new Set<() => void>();
  private timer?: ReturnType<typeof setInterval>;
  private pending?: ReturnType<typeof setTimeout>;
  private watchers = new Map<string, { watcher: FSWatcher; identity: string }>();
  constructor(agentDir: string, instanceId: string, readHealth?: () => { state: ReadHealth; generation: number } | undefined) {
    this.readHealth = readHealth;
    this.agentDir = agentDir;
    this.supervisor = new SupervisorAdmission(scenario => reviewEnabled(agentDir, scenario));
    this.admission = new CatalogAdmission(agentDir, instanceId);
  }

  observe(read: () => any, emit: (snapshot: any) => void) {
    if (this.observers.size >= 64) throw new Error("catalog-subscription-limit");
    let revision: string | undefined, seq = 0;
    const initial = read();
    const reconcile = () => {
      let snapshot;
      try { snapshot = read(); } catch { snapshot = { revision: "revoked", status: "revoked", roles: [], agents: [], diagnostics: [] }; }
      if (snapshot.revision === revision) return;
      revision = snapshot.revision;
      this.sources.metrics.notifications++;
      emit({ ...snapshot, seq: ++seq });
    };
    revision = initial.revision;
    this.observers.add(reconcile);
    this.cycle();
    this.timer ??= setInterval(() => this.cycle(), 1000);
    this.timer.unref();
    return { snapshot: { ...initial, seq }, close: () => {
      if (!this.observers.delete(reconcile)) return;
      if (!this.observers.size) {
        clearInterval(this.timer); this.timer = undefined; clearTimeout(this.pending); this.pending = undefined;
        for (const { watcher } of this.watchers.values()) watcher.close();
        this.watchers.clear(); this.sources.clear();
      } else this.cycle();
    } };
  }

  private cycle() {
    this.sources.beginObservation();
    try {
      // Verify every live grant before any project reconciliation work.
      for (const reconcile of this.observers) reconcile();
      if (this.sources.repair(128)) for (const reconcile of this.observers) reconcile();
      const paths = this.sources.watchPaths();
      for (const [path, entry] of this.watchers) {
        let identity = "";
        try { const stat = lstatSync(path); identity = `${stat.dev}:${stat.ino}`; } catch { /* Replaced/missing root. */ }
        if (!paths.has(path) || identity !== entry.identity) { entry.watcher.close(); this.watchers.delete(path); }
      }
      for (const path of paths) {
        if (this.watchers.has(path)) continue;
        try {
          const stat = lstatSync(path);
          if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
          const watcher = watch(path, { persistent: false }, (_event, name) => {
            this.sources.hint(name ? join(path, name.toString()) : path);
            this.schedule();
          });
          watcher.on("error", () => { watcher.close(); this.watchers.delete(path); this.schedule(); });
          this.watchers.set(path, { watcher, identity: `${stat.dev}:${stat.ino}` });
        } catch { /* Repair discovers missing and rebuilt directories without a watcher. */ }
      }
    } finally { this.sources.endObservation(); }
  }

  private schedule() {
    if (!this.observers.size || this.pending) return;
    this.pending = setTimeout(() => { this.pending = undefined; this.cycle(); }, 50);
    this.pending.unref();
  }

  get observationResources() { return { observers: this.observers.size, watchers: this.watchers.size, timer: !!this.timer, pending: !!this.pending }; }

  connection() {
    let registration: { cwd: string; sessionId: string; projectAccess: boolean; authority?: unknown } | undefined;
    const location = () => {
      if (!registration) throw new Error("catalog-unregistered: register a workspace first");
      if (realpathSync(registration.cwd) !== registration.cwd) throw new Error("catalog-workspace-changed");
      if (!registration.authority) throw new Error("catalog-authority-refused: register through the Pi host adapter");
      const grant = this.admission.verify(registration.authority);
      if (grant && (grant.cwd !== registration.cwd || grant.sessionId !== registration.sessionId)) throw new Error("catalog-scope-refused");
      return { cwd: registration.cwd, userRoot: this.agentDir, projectTrusted: registration.projectAccess && grant.projectTrusted === true };
    };
    return (command: Record<string, unknown>) => {
      if (command.type === "runtime_register_catalog") {
        if (typeof command.cwd !== "string" || typeof command.sessionId !== "string" || !command.sessionId) throw new Error("Invalid catalog registration");
        registration = { cwd: realpathSync(command.cwd), sessionId: command.sessionId, projectAccess: command.projectAccess !== "deny", authority: command.authority };
        location();
        return { cwd: registration.cwd, sessionId: registration.sessionId, projectTrusted: location().projectTrusted };
      }
      const loc = location();
      if (command.type === "runtime_supervisor_review" && typeof command.action === "string" && command.action.startsWith("decision-")) {
        if (!reviewEnabled(this.agentDir, "shared-decisions")) return { status: "disabled" };
        const grant = this.admission.verify(registration!.authority);
        return supervisorDecision(this.agentDir, { ...grant, projectTrusted: loc.projectTrusted }, command);
      }
      if (command.type === "runtime_supervisor_review" && command.action === "read-health") {
        if (!reviewEnabled(this.agentDir, "shared-fault")) return { status: "disabled" };
        const health = this.readHealth?.();
        const incident = health && this.readDiagnosis.inspect(health.state, health.generation);
        return incident ? { status: "diagnosed", incident } : { status: "unconfirmed" };
      }
      if (command.type === "runtime_supervisor_review") {
        const grant = this.admission.verify(registration!.authority);
        return this.supervisor.request(JSON.stringify([grant.cwd, grant.sessionId]), command);
      }
      if (command.type === "runtime_get_catalog_scope") {
        if (command.scope !== "user" && command.scope !== "project") throw new Error("Invalid catalog scope");
        return listScopedAgents({ ...loc, sources: this.sources }, command.scope);
      }
      const snapshot = this.sources.load(loc, command.type === "runtime_edit_catalog" || command.fresh === true);
      if (command.type === "runtime_get_catalog") {
        const overlay = validateOverlay(command.overlay);
        if (registration?.authority && command.overlay !== undefined) {
          const grant = this.admission.verify(registration.authority);
          const digest = overlayDigest(overlay);
          if (digest !== grant.overlayDigest) throw new Error("catalog-overlay-refused");
        }
        const view = withAgentSessionSettings(snapshot, overlay);
        return { ...view, roles: [...view.roles], agents: [...view.agents] };
      }
      if (command.type !== "runtime_edit_catalog") throw new Error("Unknown catalog command");
      if (!registration?.authority) throw new Error("catalog-authority-refused: edits require a live host grant");
      // No await between comparison and atomic domain write: cooperating clients
      // serialize here. External writers do not participate in this transaction.
      if (typeof command.expectedRevision !== "string" || command.expectedRevision !== snapshot.revision) throw new Error("catalog-conflict: content revision changed; reload before editing");
      const id = command.catalogId;
      if (typeof id !== "string") throw new Error("Invalid catalog id");
      const entry = snapshot.roles.get(id) ?? snapshot.agents.get(id);
      if (command.action === "reset-runtime" || command.action === "reset-definition") {
        if (!entry) throw new Error("Catalog definition not found");
        const reset = command.action === "reset-runtime" ? resetRuntimeToBundled : resetUserDefinition;
        return reset({ ...loc, id, expectedPath: entry.path, expectedDigest: entry.contentDigest });
      }
      if (command.action === "preferences") {
        return saveAgentSessionDefaults(snapshot, id, validateOverlay({ [id]: command.preferences }), loc);
      }
      if (command.action === "skills") {
        if (!entry) throw new Error("Catalog definition not found");
        const edit = command.edit as { mode?: string; paths?: unknown } | undefined;
        if (!edit || !["inherit", "none", "explicit"].includes(edit.mode ?? "") || edit.mode === "explicit" && (!Array.isArray(edit.paths) || !edit.paths.every(p => typeof p === "string"))) throw new Error("Invalid skill edit");
        return saveSkillExposure({ ...loc, entry: { id, winningSource: { path: entry.path, contentDigest: entry.contentDigest } } }, edit as import("./domain/catalog/catalog-schema.mjs").SkillExposureEdit);
      }
      if (command.action === "definition") {
        if (command.scope !== "user" && command.scope !== "project") throw new Error("Catalog scope must be user or project; builtins are read-only");
        if (command.scope === "project" && !loc.projectTrusted) throw new Error("catalog-untrusted: project writes refused");
        if (typeof command.markdown !== "string") throw new Error("Definition must be Markdown");
        const parsed = parseDefinition(command.markdown);
        if (!parsed.definition || parsed.diagnostics.some(d => d.blocking) || parsed.definition.id !== id) throw new Error("Invalid catalog definition: " + parsed.diagnostics.map(d => d.message).join(" "));
        return saveDefinition({ ...loc, definition: parsed.definition, scope: command.scope, replace: command.replace === true });
      }
      throw new Error("Unknown catalog edit action");
    };
  }
}

function validateOverlay(value: unknown): import("./domain/catalog/agent-session-settings.mjs").AgentSessionOverrides {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid catalog overlay");
  for (const [id, patch] of Object.entries(value)) {
    if (!/^(role|agent)\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id) || !patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Invalid catalog overlay");
    for (const [key, item] of Object.entries(patch)) {
      if (key === "model" ? item !== null && (typeof item !== "string" || !/^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(item))
        : key !== "effort" || item !== null && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(item as string)) throw new Error("Invalid catalog preference");
    }
  }
  return value as import("./domain/catalog/agent-session-settings.mjs").AgentSessionOverrides;
}
