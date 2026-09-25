/**
 * Read-only `agents_catalog` tool. List and inspect are the only actions.
 * Creation, import, and reload stay on `/agents`, where confirmation can be
 * collected. This module does not write files.
 */
import { presentCatalog, presentCatalogEntry, type LaunchEnricher } from "./agent-inspection.ts";
import { defaultUserRoot, loadCatalog } from "./catalog-store.ts";

type TypeModule = {
    Object: (value: unknown) => unknown;
    String: (value?: unknown) => unknown;
    Optional: (value: unknown) => unknown;
};

export interface DiscoveryHost {
    cwd: string;
    projectTrusted: boolean;
    userRoot: string;
    projectConfigDirName?: string;
    bundledRoot?: string;
}

export interface DiscoveryDeps {
    userRoot?: string;
    bundledRoot?: string;
    projectConfigDirName?: string;
    enrich?: LaunchEnricher;
    resolveHost?: (ctx: { cwd: string; isProjectTrusted(): boolean }) => DiscoveryHost;
}

export interface AgentsCatalogParams {
    action?: string;
    id?: string;
}

export function agentsCatalogTool(Type: TypeModule, deps: DiscoveryDeps = {}) {
    return {
        name: "agents_catalog" as const,
        label: "Agents catalog",
        description: "List or inspect role and named-agent definitions, including inheritance, diagnostics, restrictions, and whether launchability is actually known. This tool does not create, import, or edit definitions.",
        promptSnippet: "List and inspect catalog roles and named agents, including inheritance and whether launchability is known.",
        promptGuidelines: [
            "Use agents_catalog to discover roles and named agents before subagent_spawn. It is read-only.",
            "Do not treat a valid definition as launchable. definitionValid and catalogLaunchable do not select a model or start a child.",
            "A role name or instruction that says read-only is not enforcement. Unsupported execution restrictions stay blocking.",
            "Ask the user to run /agents create or /agents import-codex for writes. Those commands confirm role, scope, and import replacement.",
            "Launch with the existing subagent_spawn or batch tool. Pass one agent or one role, not both. Two roles for one run need the user to choose one or split the work.",
            "Put an authoritative model or effort on the structured invocation. Do not rely on copying a model name into the child prompt. Explicit invocation and workflow choices override definition defaults.",
        ],
        parameters: Type.Object({
            action: Type.String({ description: "list or inspect. No other action is accepted." }),
            id: Type.Optional(Type.String({ description: "Role or agent id for inspect. Display names and filenames are not ids." })),
        }),
        async execute(
            _toolCallId: string,
            params: AgentsCatalogParams,
            _signal?: AbortSignal,
            _onUpdate?: unknown,
            ctx?: { cwd: string; isProjectTrusted(): boolean },
        ) {
            if (!ctx) return toolError("agents_catalog needs the extension context. Nothing was written.");
            const action = params?.action;
            if (action !== "list" && action !== "inspect") {
                return toolError(`agents_catalog action must be list or inspect, got ${JSON.stringify(action ?? "")}. It does not create, import, reload, or launch. Nothing was written.`);
            }
            const host = resolveHost(ctx, deps);
            if (action === "list") {
                const listed = presentCatalog(loadCatalog(host), deps.enrich);
                return {
                    content: [{ type: "text" as const, text: listed.text }],
                    details: { action, wrote: false, revision: listed.revision, entries: listed.entries, diagnostics: listed.diagnostics },
                };
            }
            if (!params.id?.trim()) return toolError("inspect needs an id. Call agents_catalog with action list to see ids. Nothing was written.");
            const view = presentCatalogEntry(loadCatalog(host), params.id.trim(), deps.enrich);
            return {
                content: [{ type: "text" as const, text: view.text }],
                details: { action, wrote: false, view },
                isError: view.found ? undefined : true,
            };
        },
    };
}

function resolveHost(ctx: { cwd: string; isProjectTrusted(): boolean }, deps: DiscoveryDeps): DiscoveryHost {
    if (deps.resolveHost) return deps.resolveHost(ctx);
    return {
        cwd: ctx.cwd,
        projectTrusted: ctx.isProjectTrusted(),
        userRoot: deps.userRoot ?? defaultUserRoot(),
        projectConfigDirName: deps.projectConfigDirName,
        bundledRoot: deps.bundledRoot,
    };
}

function toolError(text: string) {
    return {
        content: [{ type: "text" as const, text }],
        details: { wrote: false },
        isError: true as const,
    };
}
