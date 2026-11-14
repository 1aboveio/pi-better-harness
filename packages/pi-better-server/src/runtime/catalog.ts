import { realpathSync } from "node:fs";
import { loadCatalog, saveDefinition, resetRuntimeToBundled, resetUserDefinition } from "./domain/catalog/catalog-store.mjs";
import { withAgentSessionSettings, saveAgentSessionDefaults } from "./domain/catalog/agent-session-settings.mjs";
import { saveSkillExposure } from "./domain/catalog/catalog-skill-edits.mjs";
import { parseDefinition } from "./domain/catalog/catalog-schema.mjs";

/** One server-owned filesystem catalog; registrations belong to the live socket. */
export class SharedCatalog {
  private agentDir: string;
  private trusted: (cwd: string) => boolean;
  constructor(agentDir: string, trusted: (cwd: string) => boolean) { this.agentDir = agentDir; this.trusted = trusted; }

  connection() {
    let registration: { cwd: string; sessionId: string; projectAccess: boolean } | undefined;
    const location = () => {
      if (!registration) throw new Error("catalog-unregistered: register a workspace first");
      if (realpathSync(registration.cwd) !== registration.cwd) throw new Error("catalog-workspace-changed");
      return { cwd: registration.cwd, userRoot: this.agentDir, projectTrusted: registration.projectAccess && this.trusted(registration.cwd) };
    };
    return (command: Record<string, unknown>) => {
      if (command.type === "runtime_register_catalog") {
        if (typeof command.cwd !== "string" || typeof command.sessionId !== "string" || !command.sessionId) throw new Error("Invalid catalog registration");
        registration = { cwd: realpathSync(command.cwd), sessionId: command.sessionId, projectAccess: command.projectAccess !== "deny" };
        return { ...registration, projectTrusted: this.trusted(registration.cwd) };
      }
      const loc = location();
      const snapshot = loadCatalog(loc);
      if (command.type === "runtime_get_catalog") {
        const view = withAgentSessionSettings(snapshot, validateOverlay(command.overlay));
        return { ...view, roles: [...view.roles], agents: [...view.agents] };
      }
      if (command.type !== "runtime_edit_catalog") throw new Error("Unknown catalog command");
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
