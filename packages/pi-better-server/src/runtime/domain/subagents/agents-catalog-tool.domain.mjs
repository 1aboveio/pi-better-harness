// Generated fixed launch domain from packages/pi-better-subagents/agents-catalog-tool.ts. Do not edit directly.
/**
 * Read-only `agents_catalog` tool. List and inspect are the only actions.
 * Creation, import, and reload stay on `/agents`, where confirmation can be
 * collected. This module does not write files.
 */
import { presentCatalog, presentCatalogEntry } from "./agent-inspection.domain.mjs";
import { canonicalCatalogId } from "./catalog-schema.domain.mjs";
import { defaultUserRoot, loadCatalog } from "./catalog-store.domain.mjs";
import { withAgentSessionSettings } from "./agent-session-settings.domain.mjs";
import { openSharedCatalog } from "./shared-catalog.domain.mjs";
export function agentsCatalogTool(Type, deps = {}) {
    return {
        name: "agents_catalog",
        label: "Agents catalog",
        description: "List or inspect role and named-agent definitions, including inheritance, default model and effort, diagnostics, restrictions, and whether launchability is actually known. This tool does not create, import, or edit definitions.",
        promptSnippet: "List and inspect catalog roles and named agents, including inheritance and whether launchability is known.",
        promptGuidelines: [
            "Use agents_catalog to discover roles and named agents before subagent_spawn. It is read-only.",
            "Roles are listed by short name. Pass that name as role (role: \"developer\"). Pass a named agent by its full id (agent: \"agent.payments\").",
            "Do not treat a valid definition as launchable. definitionValid and catalogLaunchable do not select a model or start a child.",
            "A role name or instruction that says read-only is not enforcement. Unsupported execution restrictions stay blocking.",
            "Ask the user to run /agents create or /agents import-codex for writes. Those commands confirm role, scope, and import replacement.",
            "Launch with the existing subagent_spawn or batch tool. Pass one agent or one role, not both. Two roles for one run need the user to choose one or split the work.",
            "Put an authoritative model or effort on the structured invocation. Do not rely on copying a model name into the child prompt. Explicit invocation and workflow choices override definition defaults.",
            "Each entry shows its default model@effort when set. Omit model and thinking on the spawn to use it; name one only for a stated reason.",
        ],
        parameters: Type.Object({
            action: Type.String({ description: "list or inspect. No other action is accepted." }),
            id: Type.Optional(Type.String({ description: "What to inspect: a role's short name (developer) or a named agent's id (agent.payments). The prefixed role id (role.developer) also works. Display names and filenames are not ids." })),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            if (!ctx)
                return toolError("agents_catalog needs the extension context. Nothing was written.");
            const action = params?.action;
            if (action !== "list" && action !== "inspect") {
                return toolError(`agents_catalog action must be list or inspect, got ${JSON.stringify(action ?? "")}. It does not create, import, reload, or launch. Nothing was written.`);
            }
            const host = resolveHost(ctx, deps);
            const remote = (deps.sharedCatalog ?? !deps.userRoot) ? await openSharedCatalog(host.cwd, host.userRoot, "catalog-tool", host.projectTrusted) : undefined;
            let snapshot;
            try {
                snapshot = remote ? await remote.get(host.sessionSettings ?? deps.sessionSettings?.snapshot())
                    : withAgentSessionSettings(loadCatalog(host), host.sessionSettings ?? deps.sessionSettings?.snapshot());
            }
            finally {
                remote?.close();
            }
            if (action === "list") {
                const listed = presentCatalog(snapshot, deps.enrich, deps.readSkillDefaults);
                return {
                    content: [{ type: "text", text: listed.text }],
                    details: { action, wrote: false, revision: listed.revision, entries: listed.entries, diagnostics: listed.diagnostics },
                };
            }
            if (!params.id?.trim())
                return toolError("inspect needs a role name or agent id. Call agents_catalog with action list to see them. Nothing was written.");
            const view = presentCatalogEntry(snapshot, canonicalCatalogId(params.id), deps.enrich, deps.readSkillDefaults);
            return {
                content: [{ type: "text", text: view.text }],
                details: { action, wrote: false, view },
                isError: view.found ? undefined : true,
            };
        },
    };
}
function resolveHost(ctx, deps) {
    if (deps.resolveHost)
        return deps.resolveHost(ctx);
    return {
        cwd: ctx.cwd,
        projectTrusted: ctx.isProjectTrusted(),
        userRoot: deps.userRoot ?? defaultUserRoot(),
        projectConfigDirName: deps.projectConfigDirName,
        bundledRoot: deps.bundledRoot,
    };
}
function toolError(text) {
    return {
        content: [{ type: "text", text }],
        details: { wrote: false },
        isError: true,
    };
}
