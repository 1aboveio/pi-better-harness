/**
 * Pure inheritance and inspection over a catalog snapshot.
 *
 * Model availability, tier fallback, and effort adjustment belong to the
 * resolution unit. This module only reports portable preferences and whether
 * a definition is launchable. It does not start a child or read the disk.
 */
import {
    DiagnosticCodes,
    hasBlockingDiagnostic,
    type CatalogDefinition,
    type CatalogKind,
    type Diagnostic,
    type ExecutionRestriction,
    type InstructionMode,
    type PreferenceKey,
    type ThinkingLevel,
} from "./catalog-schema.ts";
import type { CatalogEntry, CatalogScope, CatalogSnapshot } from "./catalog-store.ts";

export interface FieldValue<T> {
    value: T | null;
    source: "agent-override" | "role-default" | "absent";
    /** True for a saved agent override, including an explicit null. Role defaults are not explicit. */
    explicit: boolean;
}

export interface DefinitionOrigin {
    scope: CatalogScope;
    path: string;
    contentDigest: string;
    id: string;
}

export interface EffectiveDefinition {
    kind: CatalogKind;
    id: string;
    name?: string;
    description?: string;
    roleId?: string;
    instructionMode: InstructionMode | "role";
    instructions: string;
    model: FieldValue<string>;
    effort: FieldValue<ThinkingLevel>;
    tier: FieldValue<string>;
    launchable: boolean;
    diagnostics: readonly Diagnostic[];
    source?: DefinitionOrigin;
    roleSource?: DefinitionOrigin;
    snapshotDigest: string;
    restrictions: readonly ExecutionRestriction[];
    /**
     * Catalog definitions do not grant tools, sandbox behavior, or presets.
     * Spawn continues to use the existing subagent controls.
     */
    capabilities: {
        grantedByCatalog: false;
        note: string;
    };
}

export interface Resolution {
    status: "resolved" | "blocked" | "not-found" | "clarification-needed";
    launchable: boolean;
    effective?: EffectiveDefinition;
    diagnostics: readonly Diagnostic[];
    entry?: CatalogEntry;
}

export interface CatalogListEntry {
    kind: CatalogKind;
    id: string;
    name?: string;
    description?: string;
    scope?: CatalogScope;
    path?: string;
    winningSource?: CatalogScope;
    roleId?: string;
    launchable: boolean;
    schemaLaunchable: boolean;
    blocked: boolean;
    diagnostics: readonly Diagnostic[];
}

export interface CatalogInspection {
    found: boolean;
    id: string;
    kind?: CatalogKind;
    name?: string;
    description?: string;
    winningSource?: DefinitionOrigin;
    shadowed: readonly { scope: CatalogScope; path: string; contentDigest: string; reason: string }[];
    roleId?: string;
    roleFound: boolean;
    instructionMode?: InstructionMode | "role";
    instructions?: string;
    fields?: {
        model: FieldValue<string>;
        effort: FieldValue<ThinkingLevel>;
        tier: FieldValue<string>;
    };
    validation: readonly Diagnostic[];
    launchable: boolean;
    restrictions: readonly ExecutionRestriction[];
    capabilities: EffectiveDefinition["capabilities"];
    snapshotDigest: string;
}

const CAPABILITIES: EffectiveDefinition["capabilities"] = {
    grantedByCatalog: false,
    note: "Tool selection, extension loading, sandbox, workspace, and nested delegation stay on the existing spawn path. A role name or instruction does not grant or remove capabilities.",
};

export function resolveSelection(
    snapshot: CatalogSnapshot,
    selector: { agentId?: string; roleId?: string },
): Resolution {
    if (selector.agentId && selector.roleId) {
        const diagnostic = blockedDiagnostic(
            DiagnosticCodes.ambiguousSelector,
            `Choose either agent ${selector.agentId} or role ${selector.roleId} for one run, or split the work into two runs. No launch was selected.`,
        );
        return { status: "clarification-needed", launchable: false, diagnostics: [diagnostic] };
    }
    if (!selector.agentId && !selector.roleId) {
        return {
            status: "not-found",
            launchable: false,
            diagnostics: [blockedDiagnostic(DiagnosticCodes.missingSelector, "Pass an agent id or a role id. Catalog-free launches stay on the existing spawn path.")],
        };
    }
    if (selector.roleId) return resolveRole(snapshot, selector.roleId);
    return resolveAgent(snapshot, selector.agentId!);
}

export function listCatalog(snapshot: CatalogSnapshot): CatalogListEntry[] {
    const entries = [...snapshot.roles.values(), ...snapshot.agents.values(), ...snapshot.blocked];
    return entries
        .map((entry) => {
            const resolved = entry.kind === "role"
                ? resolveRole(snapshot, entry.id)
                : resolveAgent(snapshot, entry.id);
            return {
                kind: entry.kind,
                id: entry.id,
                name: entry.definition?.name,
                description: entry.definition?.description,
                scope: entry.scope,
                path: entry.duplicate ? undefined : entry.path,
                winningSource: entry.duplicate ? undefined : entry.scope,
                roleId: entry.definition?.kind === "agent" ? entry.definition.roleId : undefined,
                launchable: resolved.launchable,
                schemaLaunchable: entry.schemaLaunchable,
                blocked: !resolved.launchable,
                diagnostics: resolved.diagnostics,
            };
        })
        .sort((left, right) => `${left.kind}\0${left.id}`.localeCompare(`${right.kind}\0${right.id}`));
}

export function inspectCatalog(snapshot: CatalogSnapshot, id: string): CatalogInspection {
    const entry = findEntry(snapshot, id);
    if (!entry) {
        const diagnostic = blockedDiagnostic(
            id.startsWith("agent.") ? DiagnosticCodes.unknownAgent : DiagnosticCodes.unknownRole,
            `No catalog definition has id ${id}. Check the id, or reload after adding the file. Display names and filenames are not ids.`,
            id,
        );
        return {
            found: false,
            id,
            roleFound: false,
            validation: [diagnostic],
            launchable: false,
            restrictions: [],
            capabilities: CAPABILITIES,
            shadowed: [],
            snapshotDigest: snapshot.digest,
        };
    }
    const resolved = entry.kind === "role" ? resolveRole(snapshot, id) : resolveAgent(snapshot, id);
    const effective = resolved.effective;
    return {
        found: true,
        id,
        kind: entry.kind,
        name: effective?.name ?? entry.definition?.name,
        description: effective?.description ?? entry.definition?.description,
        winningSource: effective?.source ?? originOf(entry),
        shadowed: entry.unused.map((item) => ({
            scope: item.scope,
            path: item.path,
            contentDigest: item.contentDigest,
            reason: item.reason,
        })),
        roleId: effective?.roleId ?? (entry.definition?.kind === "agent" ? entry.definition.roleId : undefined),
        roleFound: entry.kind === "role" ? entry.structurallyValid : Boolean(effective?.roleSource),
        instructionMode: effective?.instructionMode,
        instructions: effective?.instructions,
        fields: effective ? { model: effective.model, effort: effective.effort, tier: effective.tier } : undefined,
        validation: resolved.diagnostics,
        launchable: resolved.launchable,
        restrictions: effective?.restrictions ?? entry.definition?.executionRestrictions ?? [],
        capabilities: CAPABILITIES,
        snapshotDigest: snapshot.digest,
    };
}

function resolveRole(snapshot: CatalogSnapshot, roleId: string): Resolution {
    const entry = findEntry(snapshot, roleId);
    if (!entry || entry.kind !== "role") {
        return {
            status: "not-found",
            launchable: false,
            diagnostics: [blockedDiagnostic(DiagnosticCodes.unknownRole, `Unknown role ${roleId}. It was not launched.`, roleId)],
        };
    }
    if (entry.duplicate || !entry.definition || entry.definition.kind !== "role") {
        return blockedEntry(snapshot, entry, entry.diagnostics);
    }
    const definition = entry.definition;
    const launchable = entry.schemaLaunchable;
    const diagnostics = launchable
        ? [...entry.diagnostics]
        : [...entry.diagnostics, blockedDiagnostic(
            DiagnosticCodes.notLaunchable,
            `Role ${roleId} is listed but not launchable. Resolve the diagnostics on ${entry.path} before launching it.`,
            roleId,
            entry.path,
            entry.scope,
        )];
    return {
        status: launchable ? "resolved" : "blocked",
        launchable,
        entry,
        diagnostics,
        effective: {
            kind: "role",
            id: definition.id,
            name: definition.name,
            description: definition.description,
            instructionMode: "role",
            instructions: definition.body,
            model: fieldFromRole(definition.defaults.model),
            effort: fieldFromRole(definition.defaults.effort),
            tier: fieldFromRole(definition.defaults.tier),
            launchable,
            diagnostics,
            source: originOf(entry),
            snapshotDigest: snapshot.digest,
            restrictions: definition.executionRestrictions,
            capabilities: CAPABILITIES,
        },
    };
}

function resolveAgent(snapshot: CatalogSnapshot, agentId: string): Resolution {
    const entry = findEntry(snapshot, agentId);
    if (!entry || entry.kind !== "agent") {
        return {
            status: "not-found",
            launchable: false,
            diagnostics: [blockedDiagnostic(DiagnosticCodes.unknownAgent, `Unknown agent ${agentId}. It was not launched as an anonymous role.`, agentId)],
        };
    }
    if (entry.duplicate || !entry.definition || entry.definition.kind !== "agent") {
        return blockedEntry(snapshot, entry, entry.diagnostics);
    }
    const agent = entry.definition;
    const roleEntry = findEntry(snapshot, agent.roleId);
    const diagnostics = [...entry.diagnostics];
    if (!roleEntry || roleEntry.kind !== "role" || !roleEntry.definition || roleEntry.definition.kind !== "role" || !roleEntry.structurallyValid) {
        diagnostics.push(blockedDiagnostic(
            roleEntry ? DiagnosticCodes.unusableRole : DiagnosticCodes.missingRole,
            roleEntry
                ? `Role ${agent.roleId} is present but not a usable base role. Agent ${agentId} stays listed and will not launch until that role is repaired.`
                : `Role ${agent.roleId} is not in the catalog. Agent ${agentId} stays listed and will not launch until the role is restored or roleId is repaired.`,
            agentId,
            entry.path,
            entry.scope,
        ));
        return {
            status: "blocked",
            launchable: false,
            entry,
            diagnostics,
            effective: baseEffective(snapshot, entry, agent, diagnostics, undefined),
        };
    }
    const role = roleEntry.definition;
    if (!roleEntry.schemaLaunchable) {
        diagnostics.push(...roleEntry.diagnostics.filter((item) => item.blocking).map((item) => ({ ...item, id: agentId })));
        diagnostics.push(blockedDiagnostic(
            DiagnosticCodes.unusableRole,
            `Role ${role.id} blocks launch (${roleEntry.path}). Agent ${agentId} inherits nothing into a launch until that role is launchable. Inspection still shows the role's current defaults.`,
            agentId,
            entry.path,
            entry.scope,
        ));
    }
    if (!entry.schemaLaunchable && !hasBlockingDiagnostic(diagnostics)) {
        diagnostics.push(blockedDiagnostic(DiagnosticCodes.notLaunchable, `Agent ${agentId} is not launchable.`, agentId, entry.path, entry.scope));
    }
    const launchable = entry.schemaLaunchable && roleEntry.schemaLaunchable && !hasBlockingDiagnostic(diagnostics);
    const effective = baseEffective(snapshot, entry, agent, diagnostics, {
        role,
        roleEntry,
        launchable,
    });
    return {
        status: launchable ? "resolved" : "blocked",
        launchable,
        entry,
        diagnostics,
        effective,
    };
}

function baseEffective(
    snapshot: CatalogSnapshot,
    entry: CatalogEntry,
    agent: Extract<CatalogDefinition, { kind: "agent" }>,
    diagnostics: readonly Diagnostic[],
    inheritance: {
        role: Extract<CatalogDefinition, { kind: "role" }>;
        roleEntry: CatalogEntry;
        launchable: boolean;
    } | undefined,
): EffectiveDefinition {
    const mode = agent.instructionMode;
    const instructions = inheritance
        ? combineInstructions(inheritance.role.body, agent.body, mode)
        : agent.body;
    return {
        kind: "agent",
        id: agent.id,
        name: agent.name,
        description: agent.description,
        roleId: agent.roleId,
        instructionMode: mode,
        instructions,
        model: inheritance ? inheritField(agent.overrides, inheritance.role.defaults, "model") : absentField(),
        effort: inheritance ? inheritField(agent.overrides, inheritance.role.defaults, "effort") : absentField(),
        tier: inheritance ? inheritField(agent.overrides, inheritance.role.defaults, "tier") : absentField(),
        launchable: inheritance?.launchable ?? false,
        diagnostics,
        source: originOf(entry),
        roleSource: inheritance ? originOf(inheritance.roleEntry) : undefined,
        snapshotDigest: snapshot.digest,
        restrictions: [
            ...agent.executionRestrictions,
            ...(inheritance?.role.executionRestrictions ?? []),
        ],
        capabilities: CAPABILITIES,
    };
}

function combineInstructions(roleBody: string, agentBody: string, mode: InstructionMode): string {
    if (mode === "replace") return agentBody;
    if (roleBody.trim().length === 0) return agentBody;
    if (agentBody.trim().length === 0) return roleBody;
    return `${roleBody.replace(/\n$/, "")}\n\n${agentBody.replace(/^\n/, "")}`;
}

function inheritField<K extends PreferenceKey>(
    overrides: { model?: string | null; effort?: ThinkingLevel | null; tier?: string | null },
    defaults: { model?: string | null; effort?: ThinkingLevel | null; tier?: string | null },
    key: K,
): FieldValue<K extends "effort" ? ThinkingLevel : string> {
    if (Object.prototype.hasOwnProperty.call(overrides, key) && overrides[key] !== undefined) {
        return {
            value: (overrides[key] ?? null) as K extends "effort" ? ThinkingLevel : string,
            source: "agent-override",
            explicit: true,
        };
    }
    if (defaults[key] !== undefined && defaults[key] !== null) {
        return {
            value: defaults[key] as K extends "effort" ? ThinkingLevel : string,
            source: "role-default",
            explicit: false,
        };
    }
    return absentField();
}

function fieldFromRole<T>(value: T | null | undefined): FieldValue<T> {
    if (value === undefined || value === null) return absentField();
    return { value, source: "role-default", explicit: false };
}

function absentField<T>(): FieldValue<T> {
    return { value: null, source: "absent", explicit: false };
}

function findEntry(snapshot: CatalogSnapshot, id: string): CatalogEntry | undefined {
    return snapshot.roles.get(id) ?? snapshot.agents.get(id) ?? snapshot.blocked.find((entry) => entry.id === id);
}

function originOf(entry: CatalogEntry): DefinitionOrigin | undefined {
    if (entry.duplicate) return undefined;
    return { scope: entry.scope, path: entry.path, contentDigest: entry.contentDigest, id: entry.id };
}

function blockedEntry(snapshot: CatalogSnapshot, entry: CatalogEntry, diagnostics: readonly Diagnostic[]): Resolution {
    const withSummary = diagnostics.some((item) => item.code === DiagnosticCodes.duplicateId || item.code === DiagnosticCodes.invalidShadow)
        ? [...diagnostics]
        : [...diagnostics, blockedDiagnostic(
            entry.duplicate ? DiagnosticCodes.duplicateId : DiagnosticCodes.notLaunchable,
            entry.duplicate
                ? `Id ${entry.id} is duplicated in ${entry.scope} and was not selected.`
                : `Id ${entry.id} is not launchable.`,
            entry.id,
            entry.path,
            entry.scope,
        )];
    return {
        status: "blocked",
        launchable: false,
        entry,
        diagnostics: withSummary,
        effective: entry.definition ? {
            kind: entry.kind,
            id: entry.id,
            name: entry.definition.name,
            description: entry.definition.description,
            roleId: entry.definition.kind === "agent" ? entry.definition.roleId : undefined,
            instructionMode: entry.definition.kind === "agent" ? entry.definition.instructionMode : "role",
            instructions: entry.definition.body,
            model: absentField(),
            effort: absentField(),
            tier: absentField(),
            launchable: false,
            diagnostics: withSummary,
            source: originOf(entry),
            snapshotDigest: snapshot.digest,
            restrictions: entry.definition.executionRestrictions,
            capabilities: CAPABILITIES,
        } : undefined,
    };
}

function blockedDiagnostic(
    code: Diagnostic["code"],
    message: string,
    id?: string,
    path?: string,
    scope?: CatalogScope,
): Diagnostic {
    return {
        severity: "error",
        code,
        message,
        id,
        path,
        scope,
        blocking: true,
        structural: false,
    };
}
