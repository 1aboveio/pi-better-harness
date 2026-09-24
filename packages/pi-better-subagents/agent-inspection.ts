/**
 * Human and agent-facing inspection.
 *
 * Catalog validity, inheritance, and execution restrictions come from the
 * catalog resolver. Model availability, actual model, actual effort, and the
 * final launch decision are injected by the resolution unit. A valid
 * definition is not reported as launchable unless that enrichment says so,
 * and a catalog block stays not launchable even if enrichment disagrees.
 */
import { inspectCatalog, listCatalog, type CatalogInspection } from "./catalog-resolver.ts";
import { formatDiagnostic, type Diagnostic } from "./catalog-schema.ts";
import type { CatalogSnapshot } from "./catalog-store.ts";

export const LEGACY_CAPABILITY_CONTROLS = [
    "tool selection",
    "extension loading",
    "skills setup",
    "sandbox and workspace",
    "nested delegation",
] as const;

export const CAPABILITY_NOTE = "Tool selection, extension loading, skills setup, sandbox and workspace, and nested delegation stay on the existing spawn path. The catalog grants no extra tools or permissions. A role name or instruction that says read-only is not enforcement.";

export interface LaunchEnrichment {
    availability: "available" | "unavailable" | "unknown";
    requestedModel: string | null;
    actualModel: string | null;
    requestedEffort: string | null;
    actualEffort: string | null;
    modelReason?: string;
    effortReason?: string;
    /** Final model/effort launch decision. Ignored when the catalog itself blocks launch. */
    launchable: boolean;
    capabilities?: {
        grantedByCatalog?: false;
        note?: string;
        /** Ignored unless every name is already an existing spawn control. */
        enforcedExistingControls?: readonly string[];
    };
}

export type LaunchEnricher = (input: {
    inspection: CatalogInspection;
    snapshotDigest: string;
}) => LaunchEnrichment | undefined;

export interface OperationField {
    value: string | null;
    source: "agent-override" | "role-default" | "absent";
    explicit: boolean;
    inherited: boolean;
}

export interface OperationCapabilities {
    grantedByCatalog: false;
    sameAsLegacySpawn: true;
    extraGrants: readonly [];
    controls: readonly string[];
    note: string;
}

export interface OperationView {
    id: string;
    found: boolean;
    definitionValid: boolean;
    catalogLaunchable: boolean;
    /** Null until model resolution is injected. Never implied by definitionValid. */
    launchable: boolean | null;
    launchabilityDecided: boolean;
    launchabilityReason: string;
    identity: {
        id: string;
        kind?: string;
        name?: string;
        description?: string;
        scope?: string;
        path?: string;
    };
    role?: { id?: string; found: boolean; path?: string };
    winningSource?: { scope: string; path: string; contentDigest: string; id: string };
    shadowed: { scope: string; path: string; contentDigest: string; reason: string }[];
    instructionMode?: string;
    instructions?: string;
    fields?: { model: OperationField; effort: OperationField; tier: OperationField };
    requestedModel: string | null;
    requestedEffort: string | null;
    actualModel: string | null;
    actualEffort: string | null;
    availability?: LaunchEnrichment["availability"];
    modelReason?: string;
    effortReason?: string;
    capabilities: OperationCapabilities;
    restrictions: {
        name: string;
        value: unknown;
        required: boolean;
        honored: boolean;
        enforced: false;
        reason?: string;
    }[];
    codexProvenanceModel: string | null;
    validation: { code: string; message: string; blocking: boolean; path?: string; field?: string }[];
    text: string;
}

export interface OperationList {
    revision: string;
    entries: OperationView[];
    diagnostics: Diagnostic[];
    text: string;
}

const CAPABILITIES: OperationCapabilities = {
    grantedByCatalog: false,
    sameAsLegacySpawn: true,
    extraGrants: [],
    controls: LEGACY_CAPABILITY_CONTROLS,
    note: CAPABILITY_NOTE,
};

export function presentCatalog(snapshot: CatalogSnapshot, enrich?: LaunchEnricher): OperationList {
    const entries = listCatalog(snapshot).map((entry) => presentCatalogEntry(snapshot, entry.id, enrich));
    const lines = [
        `Catalog revision ${snapshot.digest}.`,
        "Definition validity is not launchability. Model availability is decided only by the injected resolver.",
        ...snapshot.diagnostics.map((diagnostic) => formatDiagnostic(diagnostic)),
        ...entries.map((entry) => entry.text.split("\n")[0] ?? entry.id),
    ];
    return { revision: snapshot.digest, entries, diagnostics: [...snapshot.diagnostics], text: lines.join("\n") };
}

export function presentCatalogEntry(snapshot: CatalogSnapshot, id: string, enrich?: LaunchEnricher): OperationView {
    const inspection = inspectCatalog(snapshot, id);
    const entry = snapshot.roles.get(id) ?? snapshot.agents.get(id) ?? snapshot.blocked.find((item) => item.id === id);
    const definitionValid = Boolean(entry?.structurallyValid && entry.definition);
    const catalogLaunchable = inspection.launchable;
    const validation: OperationView["validation"] = inspection.validation.map((diagnostic) => ({
        code: String(diagnostic.code),
        message: diagnostic.message,
        blocking: diagnostic.blocking,
        path: diagnostic.path,
        field: diagnostic.field,
    }));
    let enrichment: LaunchEnrichment | undefined;
    let enrichmentFailed = false;
    if (enrich && inspection.found) {
        try {
            enrichment = enrich({ inspection, snapshotDigest: snapshot.digest });
        } catch (error) {
            enrichmentFailed = true;
            validation.push({
                code: "launch-enrichment-failed",
                message: `Model enrichment failed (${error instanceof Error ? error.message : String(error)}). The definition was still listed. Launchability stays undecided rather than assumed.`,
                blocking: false,
            });
        }
    }
    if (enrichment?.capabilities?.grantedByCatalog) {
        validation.push({
            code: "capability-not-granted",
            message: "Enrichment tried to grant a catalog capability. The catalog does not grant tools, sandbox modes, or permissions, so that claim was ignored.",
            blocking: false,
        });
    }
    const unknownControls = (enrichment?.capabilities?.enforcedExistingControls ?? []).filter((control) => !LEGACY_CAPABILITY_CONTROLS.includes(control as typeof LEGACY_CAPABILITY_CONTROLS[number]));
    if (unknownControls.length > 0) {
        validation.push({
            code: "capability-not-granted",
            message: `Controls ${unknownControls.join(", ")} are not existing spawn controls and were not granted.`,
            blocking: false,
        });
    }
    const fields = inspection.fields
        ? {
            model: field(inspection.fields.model),
            effort: field(inspection.fields.effort),
            tier: field(inspection.fields.tier),
        }
        : undefined;
    let launchable: boolean | null;
    let launchabilityDecided: boolean;
    let launchabilityReason: string;
    if (!inspection.found || !catalogLaunchable) {
        launchable = false;
        launchabilityDecided = true;
        launchabilityReason = inspection.validation.find((diagnostic) => diagnostic.blocking)?.message
            ?? `Id ${id} is not a launchable catalog definition.`;
    } else if (!enrichment || enrichmentFailed) {
        launchable = null;
        launchabilityDecided = false;
        launchabilityReason = "The catalog definition has no blocking diagnostic, but that is not launchability. Inject model availability and effort support before launching. No actual model was selected here.";
    } else {
        launchable = enrichment.launchable;
        launchabilityDecided = true;
        launchabilityReason = enrichment.launchable
            ? enrichment.modelReason ?? "Injected model resolution marked this definition launchable."
            : enrichment.modelReason ?? enrichment.effortReason ?? "Injected model resolution blocked launch.";
    }
    const metadata = entry?.definition && "metadata" in entry.definition ? entry.definition.metadata : undefined;
    const codex = metadata && typeof metadata === "object" ? (metadata as { codex?: { model?: unknown } }).codex : undefined;
    const codexProvenanceModel = typeof codex?.model === "string" ? codex.model : null;
    const view: OperationView = {
        id,
        found: inspection.found,
        definitionValid,
        catalogLaunchable,
        launchable,
        launchabilityDecided,
        launchabilityReason,
        identity: {
            id,
            kind: inspection.kind,
            name: inspection.name,
            description: inspection.description,
            scope: inspection.winningSource?.scope,
            path: inspection.winningSource?.path,
        },
        role: inspection.roleId || inspection.kind === "agent"
            ? { id: inspection.roleId, found: inspection.roleFound, path: undefined }
            : inspection.kind === "role"
                ? { id, found: inspection.roleFound, path: inspection.winningSource?.path }
                : undefined,
        winningSource: inspection.winningSource,
        shadowed: inspection.shadowed.map((item) => ({ ...item })),
        instructionMode: inspection.instructionMode,
        instructions: inspection.instructions,
        fields,
        requestedModel: enrichment?.requestedModel ?? fields?.model.value ?? null,
        requestedEffort: enrichment?.requestedEffort ?? (fields?.effort.value ?? null),
        actualModel: enrichment?.actualModel ?? null,
        actualEffort: enrichment?.actualEffort ?? null,
        availability: enrichment?.availability,
        modelReason: enrichment?.modelReason,
        effortReason: enrichment?.effortReason,
        capabilities: CAPABILITIES,
        restrictions: inspection.restrictions.map((restriction) => ({
            name: restriction.name,
            value: restriction.value,
            required: restriction.required,
            honored: restriction.honored,
            enforced: false,
            reason: restriction.reason,
        })),
        codexProvenanceModel,
        validation,
        text: "",
    };
    view.text = renderOperationView(view);
    return view;
}

export function renderOperationView(view: OperationView): string {
    const header = [
        view.identity.kind ?? "missing",
        view.id,
        view.identity.name ? JSON.stringify(view.identity.name) : "unnamed",
        `scope=${view.identity.scope ?? "none"}`,
        `definitionValid=${yesNo(view.definitionValid)}`,
        `catalogLaunchable=${yesNo(view.catalogLaunchable)}`,
        `launchable=${view.launchable === null ? "unknown" : yesNo(view.launchable)}`,
    ].join(" ");
    const lines = [
        header,
        `identity: id=${view.id} kind=${view.identity.kind ?? "unknown"} name=${JSON.stringify(view.identity.name ?? "")} description=${JSON.stringify(view.identity.description ?? "")}`,
        view.winningSource
            ? `winning source: ${view.winningSource.scope} ${view.winningSource.path} digest=${view.winningSource.contentDigest}`
            : "winning source: none",
        ...view.shadowed.map((item) => `shadowed: ${item.scope} ${item.path} ${item.reason}`),
        view.role ? `role: ${view.role.id ?? "none"} found=${yesNo(view.role.found)}` : "role: none",
        view.instructionMode ? `instruction mode: ${view.instructionMode}` : "instruction mode: none",
        `instructions: ${JSON.stringify(view.instructions ?? "")}`,
    ];
    if (view.fields) {
        for (const key of ["model", "effort", "tier"] as const) {
            const fieldValue = view.fields[key];
            lines.push(`${key}: value=${JSON.stringify(fieldValue.value)} source=${fieldValue.source} explicit=${yesNo(fieldValue.explicit)} inherited=${yesNo(fieldValue.inherited)}`);
        }
    }
    lines.push(`requested model: ${JSON.stringify(view.requestedModel)}`);
    lines.push(`actual model: ${JSON.stringify(view.actualModel)}`);
    lines.push(`requested effort: ${JSON.stringify(view.requestedEffort)}`);
    lines.push(`actual effort: ${JSON.stringify(view.actualEffort)}`);
    lines.push(`availability: ${view.availability ?? "not-resolved"}`);
    lines.push(view.launchabilityReason);
    if (view.launchable !== true) lines.push("Definition validity is not launchability.");
    if (view.codexProvenanceModel) {
        lines.push(`Codex model recorded as provenance only, not by itself an override: ${JSON.stringify(view.codexProvenanceModel)}`);
    }
    lines.push(`capabilities: ${view.capabilities.controls.join(", ")}`);
    lines.push(view.capabilities.note);
    lines.push("capabilities.grantedByCatalog=false");
    lines.push("capabilities.extraGrants=[]");
    if (view.restrictions.length === 0) lines.push("execution restrictions: none");
    for (const restriction of view.restrictions) {
        lines.push(`execution restriction ${restriction.name}=${JSON.stringify(restriction.value)} required=${yesNo(restriction.required)} honored=${yesNo(restriction.honored)} enforced=false`);
        if (restriction.reason) lines.push(restriction.reason);
    }
    for (const diagnostic of view.validation) lines.push(`${diagnostic.code}: ${diagnostic.message}`);
    return lines.join("\n");
}

function field(value: { value: string | null; source: OperationField["source"]; explicit: boolean }): OperationField {
    return {
        value: value.value,
        source: value.source,
        explicit: value.explicit,
        inherited: value.source === "role-default",
    };
}

function yesNo(value: boolean): "yes" | "no" {
    return value ? "yes" : "no";
}
