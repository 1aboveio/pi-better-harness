/**
 * `/agents` list, show/inspect, create, reload, and import-codex.
 *
 * Lifecycle registers `registerAgentCommands`. This module does not edit the
 * extension entry and does not launch children. Import and ambiguous choices
 * write nothing unless the required confirmation is actually collected.
 * Personal scope is the default. Project scope is explicit and trusted-only.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { presentCatalog, presentCatalogEntry, type LaunchEnricher, type OperationView } from "./agent-inspection.ts";
import {
    CATALOG_SCHEMA_VERSION,
    DiagnosticCodes,
    EFFORT_LEVELS,
    parseDefinition,
    type AgentDefinition,
    type Diagnostic,
    type InstructionMode,
    type PortablePreferences,
    type ThinkingLevel,
} from "./catalog-schema.ts";
import {
    createDefinition,
    defaultUserRoot,
    loadCatalog,
    projectCatalogPaths,
    refreshCatalog,
    saveDefinition,
    userCatalogPaths,
    type CatalogSnapshot,
} from "./catalog-store.ts";
import { listCatalog } from "./catalog-resolver.ts";
import {
    CODEX_FORMAT,
    PI_VS_CODEX_PRECEDENCE,
    agentIdFromDisplayName,
    buildImportedAgent,
    codexSourceRef,
    parseCodexSource,
    renderReimportPreview,
    suggestBaseRoles,
    type CodexDocument,
} from "./codex-import.ts";
import { resolveRoleAssignment } from "./role-assignment.ts";

const MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const TIER_PATTERN = /^[a-z][a-z0-9-]{0,32}$/;
const KNOWN_FLAGS = new Set(["role", "scope", "name", "id", "mode", "description", "instructions", "model", "effort", "tier", "help"]);
const USAGE = [
    "/agents list",
    "/agents show <id>    (inspect is the same command)",
    "/agents create [--role <role-id>] [--name <name>] [--scope user|project] [--mode add|replace] [--instructions <text>] [--model <provider/model>] [--effort <level>] [--tier <label>]",
    "/agents reload",
    "/agents import-codex <file.toml> [--scope user|project] [--role <role-id>]",
    "Create and import write to the personal catalog unless --scope project is set.",
    "Import confirms one base role and replace mode. It does not scan .codex/agents.",
].join("\n");

export interface AgentCommandDeps {
    userRoot?: string;
    bundledRoot?: string;
    projectConfigDirName?: string;
    now?: () => string;
    /** Resolution unit injects availability, actual model/effort, and launchability. */
    enrich?: LaunchEnricher;
}

export interface AgentCommandUi {
    select(title: string, options: string[]): Promise<string | undefined>;
    confirm(title: string, message: string): Promise<boolean>;
    input(title: string, placeholder?: string): Promise<string | undefined>;
    editor(title: string, prefill?: string): Promise<string | undefined>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setWidget?(key: string, content: string[] | undefined): void;
}

export interface AgentCommandHost {
    cwd: string;
    hasUI: boolean;
    mode?: "tui" | "rpc" | "json" | "print";
    isProjectTrusted(): boolean;
    ui: AgentCommandUi;
}

export interface AgentCommandResult {
    ok: boolean;
    status: "ok" | "clarification-needed" | "error";
    command: string;
    wrote: boolean;
    path?: string;
    scope?: "user" | "project";
    message: string;
    diagnostics: Diagnostic[];
    data?: unknown;
}

interface CatalogLocation {
    cwd: string;
    userRoot: string;
    projectTrusted: boolean;
    projectConfigDirName?: string;
    bundledRoot?: string;
}

interface ParsedArgs {
    positionals: string[];
    flags: Map<string, string[]>;
    unknown: string[];
    missing: string[];
}

export function registerAgentCommands(pi: Pick<ExtensionAPI, "registerCommand">, deps: AgentCommandDeps = {}): void {
    pi.registerCommand("agents", {
        description: "List, inspect, create, reload, or import Codex agent definitions",
        getArgumentCompletions(prefix: string) {
            const commands = ["list", "inspect", "show", "create", "reload", "import-codex", "help"];
            const first = prefix.trim().split(/\s+/)[0] ?? "";
            if (first !== prefix.trim() && first.length > 0) return null;
            const items = commands.filter((command) => command.startsWith(first)).map((value) => ({ value, label: value }));
            return items.length > 0 ? items : null;
        },
        async handler(args: string, ctx: ExtensionCommandContext) {
            await executeAgentsCommand(args, {
                cwd: ctx.cwd,
                hasUI: ctx.hasUI,
                mode: ctx.mode,
                isProjectTrusted: () => ctx.isProjectTrusted(),
                ui: ctx.ui,
            }, deps);
        },
    });
}

export async function executeAgentsCommand(args: string, host: AgentCommandHost, deps: AgentCommandDeps = {}): Promise<AgentCommandResult> {
    const parsed = parseCommandArgs(args);
    if (parsed.unknown.length > 0 || parsed.missing.length > 0) {
        const detail = [
            ...parsed.unknown.map((flag) => `Unknown flag --${flag}.`),
            ...parsed.missing.map((flag) => `--${flag} needs a value.`),
        ].join(" ");
        return finish(host, result("error", parsed.positionals[0] ?? "agents", false, `${detail}\n${USAGE}`));
    }
    if (parsed.flags.has("help") || parsed.positionals[0] === "help" || parsed.positionals.length === 0) {
        return finish(host, result("ok", "help", false, USAGE));
    }
    const command = parsed.positionals[0]!;
    const loc = location(host, deps);
    if (command === "list") return finish(host, await runList(parsed, loc, deps));
    if (command === "show" || command === "inspect") return finish(host, await runShow(command, parsed, host, loc, deps));
    if (command === "reload") return finish(host, await runReload(parsed, loc, deps));
    if (command === "create") return finish(host, await runCreate(parsed, host, loc, deps));
    if (command === "import-codex") return finish(host, await runImport(parsed, host, loc, deps));
    return finish(host, result("error", command, false, `Unknown /agents command ${JSON.stringify(command)}.\n${USAGE}`));
}

export function parseCommandArgs(input: string): ParsedArgs {
    const positionals: string[] = [];
    const flags = new Map<string, string[]>();
    const unknown: string[] = [];
    const missing: string[] = [];
    const tokens = tokenize(input);
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index]!;
        if (token === "--") {
            positionals.push(...tokens.slice(index + 1));
            break;
        }
        if (!token.startsWith("--")) {
            positionals.push(token);
            continue;
        }
        const body = token.slice(2);
        const eq = body.indexOf("=");
        const name = eq === -1 ? body : body.slice(0, eq);
        if (!KNOWN_FLAGS.has(name)) {
            unknown.push(name);
            continue;
        }
        const value = eq === -1 ? tokens[index + 1] : body.slice(eq + 1);
        if (eq === -1 && (value === undefined || value.startsWith("--"))) {
            missing.push(name);
            continue;
        }
        if (eq === -1) index += 1;
        flags.set(name, [...(flags.get(name) ?? []), value ?? ""]);
    }
    return { positionals, flags, unknown, missing };
}

async function runList(parsed: ParsedArgs, loc: CatalogLocation, deps: AgentCommandDeps): Promise<AgentCommandResult> {
    if (parsed.positionals.length > 1) return result("error", "list", false, "list does not take extra arguments. Use /agents show <id> to inspect one definition.");
    const listed = presentCatalog(readCatalog(loc), deps.enrich);
    return {
        ...result("ok", "list", false, `Listed from a fresh catalog read. File edits show up on the next list or launch; /agents reload is not required for that.\n${listed.text}`),
        diagnostics: listed.diagnostics,
        data: listed,
    };
}

async function runReload(parsed: ParsedArgs, loc: CatalogLocation, deps: AgentCommandDeps): Promise<AgentCommandResult> {
    if (parsed.positionals.length > 1) return result("error", "reload", false, "reload does not take extra arguments.");
    const listed = presentCatalog(refreshCatalog(loc), deps.enrich);
    return {
        ...result("ok", "reload", false, `Reloaded revision ${listed.revision} for inspection. The next launch reads the files again on its own; this command is not a prerequisite.\n${listed.text}`),
        diagnostics: listed.diagnostics,
        data: listed,
    };
}

async function runShow(
    command: string,
    parsed: ParsedArgs,
    host: AgentCommandHost,
    loc: CatalogLocation,
    deps: AgentCommandDeps,
): Promise<AgentCommandResult> {
    if (parsed.positionals.length > 2) return result("error", command, false, `${command} takes one id. Display names and filenames are not ids.`);
    let id = parsed.positionals[1];
    if (!id) {
        if (!host.hasUI) {
            return clarification(command, `${command} needs an id. UI is unavailable, so none was selected. Run /agents list and pass the id. Nothing was written.`);
        }
        const ids = listCatalog(readCatalog(loc)).map((entry) => entry.id);
        if (ids.length === 0) return result("error", command, false, "The catalog has no definitions to inspect.");
        const selected = await host.ui.select("Inspect a role or agent", ids);
        if (!selected) return clarification(command, "Inspect was dismissed. Nothing was written.");
        id = selected;
    }
    const view = presentCatalogEntry(readCatalog(loc), id, deps.enrich);
    return {
        ok: view.found,
        status: view.found ? "ok" : "error",
        command,
        wrote: false,
        message: view.found ? view.text : `${view.text}\nNothing was written.`,
        diagnostics: viewDiagnostics(view),
        data: view,
    };
}

async function runCreate(
    parsed: ParsedArgs,
    host: AgentCommandHost,
    loc: CatalogLocation,
    deps: AgentCommandDeps,
): Promise<AgentCommandResult> {
    if (parsed.positionals.length > 1) {
        return result("error", "create", false, "create takes flags, not a bare role name. Use --role <role-id>. Nothing was written.");
    }
    const scope = readScope(parsed.flags);
    if (scope.error) return result("error", "create", false, `${scope.error} Nothing was written.`);
    if (scope.value === "project" && !loc.projectTrusted) return untrusted("create");
    const snapshot = readCatalog(loc);
    const roles = catalogRoles(snapshot);
    let roleIds = [...(parsed.flags.get("role") ?? [])];
    if (roleIds.length > 1) {
        const decision = await resolveRoleAssignment(roleIds.map((roleId) => ({ roleId })), {
            hasUI: host.hasUI,
            select: host.hasUI ? (title, options) => host.ui.select(title, options) : undefined,
        });
        if (decision.status !== "resolved" || decision.jobs.length !== 1) {
            return clarification("create", `${decision.message} A named agent was not created. Split does not write two agents or an agent with multiple parents.`);
        }
        roleIds = [decision.jobs[0]!.roleId];
    }
    let roleId = roleIds[0];
    if (!roleId) {
        if (!host.hasUI) {
            return clarification("create", `create needs --role <role-id>. UI is unavailable, so no role was chosen. Roles: ${roles.map((role) => role.id).join(", ") || "none"}. Nothing was written.`);
        }
        if (roles.length === 0) return result("error", "create", false, "No roles are available to use as a base. Nothing was written.");
        const selected = await host.ui.select("Choose one base role", roles.map(roleOption));
        if (!selected) return clarification("create", "Role choice was dismissed. Nothing was written.");
        roleId = selected.split(" ")[0];
    }
    if (!roleId || !roles.some((role) => role.id === roleId)) {
        return result("error", "create", false, `Unknown role ${roleId ?? ""}. Nothing was written. Use /agents list and pass one role id.`);
    }
    let name = parsed.flags.get("name")?.[0];
    if (!name?.trim()) {
        if (!host.hasUI) return clarification("create", "create needs --name. UI is unavailable, so no name was chosen. Nothing was written.");
        const entered = await host.ui.input("Agent display name", "Payments Developer");
        if (!entered?.trim()) return clarification("create", "Name was dismissed. Nothing was written.");
        name = entered.trim();
    } else {
        name = name.trim();
    }
    const explicitId = parsed.flags.get("id")?.[0];
    const id = explicitId ?? agentIdFromDisplayName(name);
    if (!id || !/^agent\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id)) {
        return result("error", "create", false, `Id ${JSON.stringify(explicitId ?? name)} is not agent.<slug>. Nothing was written.`);
    }
    const modeFlag = parsed.flags.get("mode")?.[0] ?? "add";
    if (modeFlag !== "add" && modeFlag !== "replace") {
        return result("error", "create", false, "mode must be add or replace. Nothing was written.");
    }
    const mode: InstructionMode = modeFlag;
    let instructions = parsed.flags.get("instructions")?.[0];
    if (!parsed.flags.has("instructions")) {
        if (host.hasUI) {
            const edited = await host.ui.editor(mode === "replace" ? "Replacement instructions" : "Instructions to add", "");
            if (edited === undefined) return clarification("create", "Instruction editor was dismissed. Nothing was written.");
            instructions = edited;
        } else {
            instructions = "";
        }
    }
    if (mode === "replace" && instructions!.trim() === "") {
        return clarification("create", "replace mode needs nonempty instruction text. Model and effort still inherit unless you set overrides. Nothing was written.");
    }
    const overrides: PortablePreferences = {};
    const overrideError = readOverrides(parsed.flags, overrides);
    if (overrideError) return result("error", "create", false, `${overrideError} Nothing was written.`);
    const description = parsed.flags.get("description")?.[0];
    const definition: AgentDefinition = {
        schema: CATALOG_SCHEMA_VERSION,
        kind: "agent",
        id,
        name,
        description: description?.trim() || undefined,
        roleId,
        instructionMode: mode,
        overrides,
        executionRestrictions: [],
        provenance: { origin: "local" },
        body: instructions ?? "",
    };
    const saved = createDefinition({ ...loc, definition, scope: scope.value, replace: false });
    if (!saved.ok || !saved.path) {
        return { ...result("error", "create", false, saved.diagnostics.map((item) => item.message).join("\n") || "Create did not write a file."), diagnostics: saved.diagnostics };
    }
    const view = presentCatalogEntry(readCatalog(loc), id, deps.enrich);
    return {
        ok: true,
        status: "ok",
        command: "create",
        wrote: true,
        path: saved.path,
        scope: scope.value,
        message: `Created ${id} in the ${scopeLabel(scope.value)} catalog at ${saved.path}. Only the role reference and explicit overrides were stored.\n${view.text}`,
        diagnostics: [...saved.diagnostics, ...viewDiagnostics(view)],
        data: view,
    };
}

async function runImport(
    parsed: ParsedArgs,
    host: AgentCommandHost,
    loc: CatalogLocation,
    deps: AgentCommandDeps,
): Promise<AgentCommandResult> {
    if (parsed.positionals.length > 2) {
        return result("error", "import-codex", false, "import-codex takes one file. It does not scan a directory. Nothing was imported.");
    }
    const scope = readScope(parsed.flags);
    if (scope.error) return result("error", "import-codex", false, `${scope.error} Nothing was imported.`);
    if (scope.value === "project" && !loc.projectTrusted) return untrusted("import-codex");
    let filePath = parsed.positionals[1];
    if (!filePath) {
        if (!host.hasUI) {
            return clarification("import-codex", "import-codex needs a TOML file path. UI is unavailable, so no path was chosen and .codex/agents was not scanned. Example: /agents import-codex .codex/agents/reviewer.toml. Nothing was imported.");
        }
        const entered = await host.ui.input("Codex TOML file", ".codex/agents/name.toml");
        if (!entered?.trim()) return clarification("import-codex", "Import path was dismissed. Nothing was imported.");
        filePath = entered.trim();
    }
    const resolved = isAbsolute(filePath) ? filePath : resolve(loc.cwd, filePath);
    let fileStats;
    try {
        fileStats = statSync(resolved);
    } catch (error) {
        return result("error", "import-codex", false, `Cannot read ${resolved}: ${error instanceof Error ? error.message : String(error)}. Nothing was imported.`);
    }
    if (fileStats.isDirectory()) {
        return result("error", "import-codex", false, `${resolved} is a directory. import-codex does not scan directories, including .codex/agents. Pass one TOML file. Nothing was imported.`);
    }
    let source: string;
    try {
        source = readFileSync(resolved, "utf8");
    } catch (error) {
        return result("error", "import-codex", false, `Cannot read ${resolved}: ${error instanceof Error ? error.message : String(error)}. Nothing was imported.`);
    }
    const parsedSource = parseCodexSource(source, resolved);
    if (!parsedSource.ok) {
        return { ...result("error", "import-codex", false, parsedSource.diagnostics.map((item) => item.message).join("\n")), diagnostics: parsedSource.diagnostics };
    }
    const document = parsedSource.document;
    const snapshot = readCatalog(loc);
    const roles = catalogRoles(snapshot);
    if (roles.length === 0) return result("error", "import-codex", false, "No roles are available to use as the one base role. Nothing was imported.");
    const suggestion = suggestBaseRoles(`${document.name}\n${document.description}\n${document.developerInstructions}`, roles);
    const requestedRoles = [...(parsed.flags.get("role") ?? [])];
    if (requestedRoles.length > 1) {
        const decision = await resolveRoleAssignment(requestedRoles.map((roleId) => ({ roleId })), {
            hasUI: host.hasUI,
            select: host.hasUI ? (title, options) => host.ui.select(title, options) : undefined,
        });
        if (decision.status !== "resolved" || decision.jobs.length !== 1) {
            return clarification("import-codex", `${decision.message} Import did not write an agent with multiple parents.`);
        }
        requestedRoles.splice(0, requestedRoles.length, decision.jobs[0]!.roleId);
    }
    let roleId = requestedRoles[0];
    if (roleId && !roles.some((role) => role.id === roleId)) {
        return result("error", "import-codex", false, `Unknown role ${roleId}. Nothing was imported.`);
    }
    const sourceRef = codexSourceRef(resolved);
    const existingLookup = matchExisting(listScopeAgents(loc, scope.value).agents, document.proposedId, sourceRef);
    if (existingLookup.conflict) return clarification("import-codex", `${existingLookup.conflict} Nothing was imported.`);
    if (!roleId) {
        if (!host.hasUI) {
            return clarification("import-codex", headlessImportMessage(document, suggestion, roles, existingLookup.match?.definition, sourceRef, scope.value, deps));
        }
        const ordered = [...roles].sort((left, right) => left.id.localeCompare(right.id));
        if (suggestion.unique) {
            const index = ordered.findIndex((role) => role.id === suggestion.unique);
            if (index > 0) ordered.unshift(...ordered.splice(index, 1));
        }
        const title = suggestion.unique
            ? `Confirm one base role. Suggested ${suggestion.unique}. Imported instructions use replace mode.`
            : suggestion.ambiguous.length > 0
                ? `Choose one base role. ${suggestion.ambiguous.join(" and ")} tied, and an agent cannot have both.`
                : "Choose one base role. None was suggested from the Codex name.";
        const selected = await host.ui.select(title, ordered.map(roleOption));
        if (!selected) return clarification("import-codex", "Role confirmation was dismissed. Nothing was imported.");
        roleId = selected.split(" ")[0];
        if (!roleId || !roles.some((role) => role.id === roleId)) {
            return result("error", "import-codex", false, `Unknown role choice ${JSON.stringify(selected)}. Nothing was imported.`);
        }
    }
    if (!host.hasUI) {
        return clarification("import-codex", headlessImportMessage(document, { ...suggestion, unique: roleId, ambiguous: [] }, roles, existingLookup.match?.definition, sourceRef, scope.value, deps, roleId));
    }
    if (!roleId) return result("error", "import-codex", false, "No role was confirmed. Nothing was imported.");
    const confirmedMode = await host.ui.confirm(
        "Import instructions in replace mode?",
        [
            `Imported developer_instructions replace the ${roleId} instruction text.`,
            "Model, effort, and tier still inherit unless you explicitly save Codex values as overrides.",
            `Destination: ${scopeLabel(scope.value)} catalog.`,
            `Proposed id: ${existingLookup.match?.definition.id ?? document.proposedId}.`,
            `${PI_VS_CODEX_PRECEDENCE.codex} ${PI_VS_CODEX_PRECEDENCE.pi}`,
            "The native file is an independent copy. Later edits to the Codex source do not change it.",
        ].join("\n"),
    );
    if (!confirmedMode) {
        return clarification("import-codex", "Import cancelled. Codex instructions are only imported in replace mode, and that was not confirmed. Nothing was written.");
    }
    let saveOverrides = false;
    if (document.storableModel || document.storableEffort) {
        const choice = await host.ui.select("Codex model and effort are not copied into overrides unless you say so", [
            "Inherit model and effort from the selected role",
            "Save supported Codex model and effort as explicit overrides",
        ]);
        if (!choice) return clarification("import-codex", "Override confirmation was dismissed. Inherited role values were not flattened into overrides. Nothing was imported.");
        saveOverrides = choice.startsWith("Save ");
    }
    const id = existingLookup.match?.definition.id ?? document.proposedId;
    const built = buildImportedAgent(document, {
        id,
        roleId,
        saveOverrides,
        importedAt: deps.now?.() ?? new Date().toISOString(),
        sourceRef,
    });
    if (!built.ok || !built.definition) {
        return { ...result("error", "import-codex", false, built.diagnostics.map((item) => item.message).join("\n") || "The native copy could not be built. Nothing was imported."), diagnostics: built.diagnostics };
    }
    if (existingLookup.match) {
        const preview = renderReimportPreview(existingLookup.match.definition, built.definition);
        const confirmed = await host.ui.confirm(`Replace ${id}?`, preview.text);
        if (!confirmed) {
            return clarification("import-codex", `${preview.text}\nReplacement was not confirmed. The existing definition was left unchanged.`);
        }
    }
    const saved = existingLookup.match
        ? saveDefinition({ ...loc, definition: built.definition, scope: scope.value, replace: true })
        : createDefinition({ ...loc, definition: built.definition, scope: scope.value, replace: false });
    if (!saved.ok || !saved.path) {
        return { ...result("error", "import-codex", false, saved.diagnostics.map((item) => item.message).join("\n") || "Import did not write a file."), diagnostics: [...parsedSource.diagnostics, ...built.diagnostics, ...saved.diagnostics] };
    }
    const view = presentCatalogEntry(readCatalog(loc), built.definition.id, deps.enrich);
    const launchNote = view.catalogLaunchable
        ? "Catalog validation passed. Definition validity is not launchability."
        : "The file was saved and is not launchable.";
    return {
        ok: true,
        status: "ok",
        command: "import-codex",
        wrote: true,
        path: saved.path,
        scope: scope.value,
        message: `Imported ${built.definition.id} into the ${scopeLabel(scope.value)} catalog at ${saved.path}. ${launchNote}\n${PI_VS_CODEX_PRECEDENCE.codex} ${PI_VS_CODEX_PRECEDENCE.pi}\n${view.text}`,
        diagnostics: [...parsedSource.diagnostics, ...built.diagnostics, ...saved.diagnostics, ...viewDiagnostics(view)],
        data: { view, replaced: Boolean(existingLookup.match) },
    };
}

function headlessImportMessage(
    document: CodexDocument,
    suggestion: { unique?: string; ambiguous: string[] },
    roles: { id: string; name: string }[],
    existing: AgentDefinition | undefined,
    sourceRef: string,
    scope: "user" | "project",
    deps: AgentCommandDeps,
    confirmedRole?: string,
): string {
    const roleLine = confirmedRole
        ? `Role ${confirmedRole} was passed but replacement mode is not confirmed.`
        : suggestion.unique
            ? `Suggested role: ${suggestion.unique}. It is not confirmed.`
            : suggestion.ambiguous.length > 0
                ? `Role suggestion ties ${suggestion.ambiguous.join(" and ")}. Choose one; an agent cannot have both.`
                : `No role was suggested. Choose one of: ${roles.map((role) => role.id).join(", ")}.`;
    const lines = [
        "import-codex needs confirmation of one base role and replace mode.",
        `UI is unavailable (${"print/json or hasUI=false"}). Nothing was written.`,
        roleLine,
        "Instruction mode would be replace. Imported developer_instructions would replace role instructions, not append to them.",
        "Unspecified model and effort would inherit from the role. They are not flattened into overrides unless that is confirmed.",
        `Destination would be the ${scopeLabel(scope)} catalog.`,
        `Proposed id: ${existing?.id ?? document.proposedId}.`,
        `developer_instructions: ${JSON.stringify(document.developerInstructions)}`,
        `${PI_VS_CODEX_PRECEDENCE.codex} ${PI_VS_CODEX_PRECEDENCE.pi}`,
        `Source ${sourceRef} would be copied, not watched.`,
    ];
    const roleForPreview = confirmedRole ?? suggestion.unique;
    if (existing && roleForPreview) {
        const built = buildImportedAgent(document, {
            id: existing.id,
            roleId: roleForPreview,
            saveOverrides: false,
            importedAt: deps.now?.() ?? "unconfirmed",
            sourceRef,
        });
        if (built.definition) lines.push(renderReimportPreview(existing, built.definition).text);
    } else if (existing) {
        lines.push(`instructions currently: ${JSON.stringify(existing.body)}`);
        lines.push(`role currently: ${existing.roleId}`);
        lines.push(`imported developer_instructions: ${JSON.stringify(document.developerInstructions)}`);
        lines.push("The replacement role is not confirmed, so the native file was not changed.");
    }
    return lines.join("\n");
}

function matchExisting(
    agents: { path: string; definition: AgentDefinition }[],
    proposedId: string,
    sourceRef: string,
): { match?: { path: string; definition: AgentDefinition }; conflict?: string } {
    const hits = agents.filter((agent) => agent.definition.id === proposedId || (agent.definition.provenance?.format === CODEX_FORMAT && agent.definition.provenance.sourceRef === sourceRef));
    if (hits.length > 1) {
        return { conflict: `This import matches ${hits.length} files (${hits.map((hit) => `${hit.definition.id} at ${hit.path}`).join("; ")}). Keep one file. No merge and no write were done.` };
    }
    return { match: hits[0] };
}

function listScopeAgents(loc: CatalogLocation, scope: "user" | "project"): { agents: { path: string; definition: AgentDefinition }[]; diagnostics: Diagnostic[] } {
    const diagnostics: Diagnostic[] = [];
    if (scope === "project" && !loc.projectTrusted) return { agents: [], diagnostics };
    const directory = scope === "project"
        ? projectCatalogPaths(loc.cwd, loc.projectConfigDirName).agents
        : userCatalogPaths(loc.userRoot).agents;
    if (!existsSync(directory)) return { agents: [], diagnostics };
    let directoryStats;
    try {
        directoryStats = lstatSync(directory);
    } catch (error) {
        diagnostics.push(diagnostic(DiagnosticCodes.ioError, error instanceof Error ? error.message : String(error)));
        return { agents: [], diagnostics };
    }
    if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) return { agents: [], diagnostics };
    const agents: { path: string; definition: AgentDefinition }[] = [];
    for (const name of readdirSync(directory).sort()) {
        if (name.startsWith(".") || !name.endsWith(".md")) continue;
        const path = resolve(directory, name);
        let fileStats;
        try {
            fileStats = lstatSync(path);
        } catch {
            continue;
        }
        if (fileStats.isSymbolicLink() || !fileStats.isFile()) continue;
        let parsed;
        try {
            parsed = parseDefinition(readFileSync(path, "utf8"), path);
        } catch {
            continue;
        }
        if (parsed.definition?.kind === "agent") agents.push({ path, definition: parsed.definition });
    }
    return { agents, diagnostics };
}

function readOverrides(flags: Map<string, string[]>, overrides: PortablePreferences): string | undefined {
    if (flags.has("model")) {
        const model = flags.get("model")![0]!;
        if (!MODEL_PATTERN.test(model)) return `model must be provider/model, got ${JSON.stringify(model)}. No provider was guessed.`;
        overrides.model = model;
    }
    if (flags.has("effort")) {
        const effort = flags.get("effort")![0]!;
        if (!(EFFORT_LEVELS as readonly string[]).includes(effort)) return `effort must be one of ${EFFORT_LEVELS.join(", ")}, got ${JSON.stringify(effort)}.`;
        overrides.effort = effort as ThinkingLevel;
    }
    if (flags.has("tier")) {
        const tier = flags.get("tier")![0]!;
        if (!TIER_PATTERN.test(tier)) return `tier must be a short lowercase label, got ${JSON.stringify(tier)}.`;
        overrides.tier = tier;
    }
    return undefined;
}

function catalogRoles(snapshot: CatalogSnapshot): { id: string; name: string }[] {
    return listCatalog(snapshot)
        .filter((entry) => entry.kind === "role" && entry.name)
        .map((entry) => ({ id: entry.id, name: entry.name! }));
}

function roleOption(role: { id: string; name: string }): string {
    return `${role.id} (${role.name})`;
}

function readScope(flags: Map<string, string[]>): { value: "user" | "project"; error?: string } {
    const values = flags.get("scope") ?? [];
    if (values.length === 0) return { value: "user" };
    if (values.length > 1) return { value: "user", error: "Pass --scope once. Use user or project." };
    if (values[0] === "user" || values[0] === "personal") return { value: "user" };
    if (values[0] === "project") return { value: "project" };
    return { value: "user", error: `Unknown scope ${JSON.stringify(values[0])}. Use user (the default) or project.` };
}

function scopeLabel(scope: "user" | "project"): string {
    return scope === "project" ? "project" : "personal";
}

function location(host: AgentCommandHost, deps: AgentCommandDeps): CatalogLocation {
    return {
        cwd: host.cwd,
        userRoot: deps.userRoot ?? defaultUserRoot(),
        projectTrusted: host.isProjectTrusted(),
        projectConfigDirName: deps.projectConfigDirName,
        bundledRoot: deps.bundledRoot,
    };
}

function readCatalog(loc: CatalogLocation): CatalogSnapshot {
    return loadCatalog(loc);
}

function untrusted(command: string): AgentCommandResult {
    return result("error", command, false, "Refusing to write the project catalog because the project is not trusted. Omit --scope to save personally, or trust the project and pass --scope project. Nothing was written.");
}

function clarification(command: string, message: string, diagnostics: Diagnostic[] = []): AgentCommandResult {
    return {
        ok: false,
        status: "clarification-needed",
        command,
        wrote: false,
        message,
        diagnostics: diagnostics.length > 0 ? diagnostics : [diagnostic("clarification-needed", message)],
    };
}

function result(status: AgentCommandResult["status"], command: string, wrote: boolean, message: string): AgentCommandResult {
    return { ok: status === "ok", status, command, wrote, message, diagnostics: status === "error" ? [diagnostic("agents-command", message.split("\n")[0] ?? message)] : [] };
}

function viewDiagnostics(view: OperationView): Diagnostic[] {
    return view.validation.map((item) => diagnostic(item.code, item.message, item.blocking, item.path, item.field));
}

function diagnostic(code: string, message: string, blocking = true, path?: string, field?: string): Diagnostic {
    return { severity: blocking ? "error" : "warning", code, message, path, field, blocking, structural: false };
}

function finish(host: AgentCommandHost, commandResult: AgentCommandResult): AgentCommandResult {
    if (!host.hasUI) return commandResult;
    const level = commandResult.status === "error" ? "error" : commandResult.status === "clarification-needed" ? "warning" : "info";
    try {
        host.ui.notify(commandResult.message, level);
    } catch {
        /* Notification is not a write. */
    }
    try {
        host.ui.setWidget?.("agents-catalog", commandResult.message.split("\n").slice(0, 40));
    } catch {
        /* Widget rendering is TUI-only. */
    }
    return commandResult;
}

function tokenize(input: string): string[] {
    const tokens: string[] = [];
    for (const match of input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
    return tokens;
}
