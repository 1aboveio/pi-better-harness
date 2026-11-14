// Generated fixed launch domain from packages/pi-better-subagents/agent-inspection.ts. Do not edit directly.
/**
 * Human and agent-facing inspection.
 *
 * Catalog validity, inheritance, and execution restrictions come from the
 * catalog resolver. Model availability, actual model, actual effort, and the
 * final launch decision are injected by the resolution unit. A valid
 * definition is not reported as launchable unless that enrichment says so,
 * and a catalog block stays not launchable even if enrichment disagrees.
 */
import { inspectCatalog, listCatalog } from "./catalog-resolver.domain.mjs";
import { formatDiagnostic, shortRoleName } from "./catalog-schema.domain.mjs";
import { loadConfig, normalizeTools, SAFE_DEFAULT_TOOLS } from "./config.domain.mjs";
import { resolveExtensions } from "./extensions.domain.mjs";
import { configuredSkillExposure } from "./skills.domain.mjs";
export const LEGACY_CAPABILITY_CONTROLS = [
    "tool selection",
    "extension loading",
    "sandbox and workspace",
    "nested delegation",
];
export const CAPABILITY_NOTE = "Tool selection, extension loading, sandbox and workspace, and nested delegation stay on the existing spawn path. Skill exposure is the one launch value a definition carries (`defaults.skills` / `overrides.skills`) because the launcher reproduces it exactly; like those controls it grants no extra tools or permissions, it only narrows which skills the child can see. A role name or instruction that says read-only is not enforcement.";
/** `model@effort`, `model`, or `effort <level>` when only an effort is set. Undefined when neither is set. */
export function formatModelEffort(model, effort) {
    const m = typeof model === "string" && model.trim() !== "" ? model : undefined;
    const e = typeof effort === "string" && effort.trim() !== "" ? effort : undefined;
    if (m && e)
        return `${m}@${e}`;
    if (m)
        return m;
    if (e)
        return `effort ${e}`;
    return undefined;
}
const STATIC_CAPABILITIES = {
    grantedByCatalog: false,
    sameAsLegacySpawn: true,
    extraGrants: [],
    controls: LEGACY_CAPABILITY_CONTROLS,
    note: CAPABILITY_NOTE,
};
/**
 * Values `spawnSubagentRun` uses when a catalog launch omits tools, sandbox,
 * workspace, and nesting. A missing model does not invent provider extensions.
 * Without a published profile, sandboxing defaults to off.
 */
export function describeDefaultLaunchCapabilities(input) {
    const rawTools = input.config.defaultTools ?? SAFE_DEFAULT_TOOLS;
    const toolAllowlist = typeof rawTools === "string" ? normalizeTools(rawTools) : "unknown";
    const model = typeof input.model === "string" && input.model.trim() !== "" ? input.model : undefined;
    let extensions;
    if (toolAllowlist === "unknown") {
        extensions = { mode: "unknown", specs: [], unmapped: [], providerExtensions: model ? "resolved" : "unknown" };
    }
    else {
        const resolution = resolveExtensions({
            tools: toolAllowlist,
            ...(model ? { model } : {}),
            clean: false,
            allowNested: false,
            config: input.config,
        });
        extensions = {
            mode: resolution.mode,
            specs: resolution.specs,
            unmapped: resolution.unmapped,
            providerExtensions: model ? "resolved" : "unknown",
        };
    }
    const cwd = typeof input.cwd === "string" && input.cwd.trim() !== "" ? input.cwd : "unknown";
    const permissions = input.sandboxPermissions;
    const enabled = permissions?.enabled ?? false;
    return {
        toolAllowlist,
        extensions,
        sandbox: {
            enabled,
            applied: enabled ? "unknown" : false,
            // Profiles can permit outside writes or disallow project writes.
            writes: enabled ? "unknown" : "unconfined",
            ...(permissions ? { permissions } : {}),
        },
        workspace: {
            cwd,
            gitClone: false,
            sandboxRoot: enabled ? cwd : null,
        },
        nesting: { allowNested: false },
    };
}
export function presentCatalog(snapshot, enrich, readSkillDefaults) {
    const entries = listCatalog(snapshot).map((entry) => presentCatalogEntry(snapshot, entry.id, enrich, readSkillDefaults));
    const lines = [
        `Catalog revision ${snapshot.digest}.`,
        "Definition validity is not launchability. Model availability is decided only by the injected resolver.",
        ...snapshot.diagnostics.map((diagnostic) => formatDiagnostic(diagnostic)),
        ...entries.flatMap((entry) => [
            renderCatalogListLine(entry),
            `  description: ${JSON.stringify(entry.identity.description ?? "")}`,
        ]),
    ];
    return { revision: snapshot.digest, entries, diagnostics: [...snapshot.diagnostics], text: lines.join("\n") };
}
export function presentCatalogEntry(snapshot, id, enrich, readSkillDefaults) {
    const inspection = inspectCatalog(snapshot, id);
    const entry = snapshot.roles.get(id) ?? snapshot.agents.get(id) ?? snapshot.blocked.find((item) => item.id === id);
    const definitionValid = Boolean(entry?.structurallyValid && entry.definition);
    const catalogLaunchable = inspection.launchable;
    const validation = inspection.validation.map((diagnostic) => ({
        code: String(diagnostic.code),
        message: diagnostic.message,
        blocking: diagnostic.blocking,
        path: diagnostic.path,
        field: diagnostic.field,
    }));
    let enrichment;
    let enrichmentFailed = false;
    if (enrich && inspection.found) {
        try {
            enrichment = enrich({ inspection, snapshotDigest: snapshot.digest, snapshot });
        }
        catch (error) {
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
    const unknownControls = (enrichment?.capabilities?.enforcedExistingControls ?? []).filter((control) => !LEGACY_CAPABILITY_CONTROLS.includes(control));
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
    let launchable;
    let launchabilityDecided;
    let launchabilityReason;
    if (!inspection.found || !catalogLaunchable) {
        launchable = false;
        launchabilityDecided = true;
        launchabilityReason = inspection.validation.find((diagnostic) => diagnostic.blocking)?.message
            ?? `Id ${id} is not a launchable catalog definition.`;
    }
    else if (!enrichment || enrichmentFailed) {
        launchable = null;
        launchabilityDecided = false;
        launchabilityReason = "The catalog definition has no blocking diagnostic, but that is not launchability. Inject model availability and effort support before launching. No actual model was selected here.";
    }
    else {
        launchable = enrichment.launchable;
        launchabilityDecided = true;
        launchabilityReason = enrichment.launchable
            ? enrichment.modelReason ?? "Injected model resolution marked this definition launchable."
            : enrichment.modelReason ?? enrichment.effortReason ?? "Injected model resolution blocked launch.";
    }
    const metadata = entry?.definition && "metadata" in entry.definition ? entry.definition.metadata : undefined;
    const codex = metadata && typeof metadata === "object" ? metadata.codex : undefined;
    const codexProvenanceModel = typeof codex?.model === "string" ? codex.model : null;
    const skillDefaults = readSkillDefaults?.() ?? configuredSkillDefaults();
    const globalSkills = skillDefaults.value === undefined || skillDefaults.value === null
        ? null : [...skillDefaults.value];
    const view = {
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
        preferenceSources: Object.fromEntries(["model", "effort"].flatMap(key => {
            const owner = inspection.kind === "agent" && fields?.[key].inherited ? inspection.roleId : id;
            const source = owner ? snapshot.preferenceSources?.[owner]?.[key] : undefined;
            return source ? [[key, source]] : [];
        })),
        instructions: inspection.instructions,
        fields,
        skills: inspection.skills ? {
            value: inspection.skills.value ? [...inspection.skills.value] : null,
            source: inspection.skills.source,
            explicit: inspection.skills.explicit,
            inherited: inspection.skills.source === "role-default",
            global: globalSkills,
            effective: effectiveSkillExposure(inspection.skills, skillDefaults),
        } : undefined,
        defaults: definitionDefaults(fields),
        requestedModel: enrichment?.requestedModel ?? fields?.model.value ?? null,
        requestedEffort: enrichment?.requestedEffort ?? (fields?.effort.value ?? null),
        actualModel: enrichment?.actualModel ?? null,
        actualEffort: enrichment?.actualEffort ?? null,
        availability: enrichment?.availability,
        modelReason: enrichment?.modelReason,
        effortReason: enrichment?.effortReason,
        capabilities: {
            ...STATIC_CAPABILITIES,
            effective: enrichment?.capabilities?.effective ?? describeDefaultLaunchCapabilities({
                config: loadConfig(),
                model: enrichment?.actualModel ?? null,
            }),
        },
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
function renderHeader(view, shownId) {
    return [
        view.identity.kind ?? "missing",
        shownId,
        view.identity.name ? JSON.stringify(view.identity.name) : "unnamed",
        `scope=${view.identity.scope ?? "none"}`,
        `definitionValid=${yesNo(view.definitionValid)}`,
        `catalogLaunchable=${yesNo(view.catalogLaunchable)}`,
        `launchable=${view.launchable === null ? "unknown" : yesNo(view.launchable)}`,
        ...(view.defaults ? [`default ${view.defaults.label}`] : []),
    ].join(" ");
}
/**
 * One `agents_catalog` list line. A role shows its short name (`role developer
 * "Developer" …`), which is what the `role` field accepts; a named agent keeps
 * its full id. Inspect output and structured details keep the full id.
 */
export function renderCatalogListLine(view) {
    return renderHeader(view, view.identity.kind === "role" ? shortRoleName(view.id) : view.id);
}
export function renderOperationView(view) {
    const header = renderHeader(view, view.id);
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
        for (const key of ["model", "effort", "tier"]) {
            const fieldValue = view.fields[key];
            lines.push(`${key}: value=${JSON.stringify(fieldValue.value)} source=${fieldValue.source} explicit=${yesNo(fieldValue.explicit)} inherited=${yesNo(fieldValue.inherited)}`);
        }
    }
    lines.push(view.skills
        ? `skills: value=${JSON.stringify(view.skills.value)} mode=${skillMode(view.skills.value)} source=${view.skills.source} explicit=${yesNo(view.skills.explicit)} inherited=${yesNo(view.skills.inherited)}`
        : "skills: mode=discovery source=default");
    if (view.skills) {
        lines.push(`skills effective: mode=${view.skills.effective.mode} source=${view.skills.effective.source} paths=${JSON.stringify(view.skills.effective.paths)}${view.skills.effective.error ? ` error=${JSON.stringify(view.skills.effective.error)}` : ""}`);
        lines.push(`skills default: ${view.skills.global === null ? "not set" : JSON.stringify(view.skills.global)}`);
    }
    lines.push(`requested model: ${JSON.stringify(view.requestedModel)}`);
    lines.push(`actual model: ${JSON.stringify(view.actualModel)}`);
    lines.push(`requested effort: ${JSON.stringify(view.requestedEffort)}`);
    lines.push(`actual effort: ${JSON.stringify(view.actualEffort)}`);
    lines.push(`availability: ${view.availability ?? "not-resolved"}`);
    lines.push(view.launchabilityReason);
    if (view.launchable !== true)
        lines.push("Definition validity is not launchability.");
    if (view.codexProvenanceModel) {
        lines.push(`Codex model recorded as provenance only, not by itself an override: ${JSON.stringify(view.codexProvenanceModel)}`);
    }
    lines.push(`capabilities: ${view.capabilities.controls.join(", ")}`);
    lines.push(view.capabilities.note);
    lines.push("capabilities.grantedByCatalog=false");
    lines.push("capabilities.extraGrants=[]");
    lines.push(`tool allowlist: ${JSON.stringify(view.capabilities.effective.toolAllowlist)}`);
    lines.push(`extensions: ${JSON.stringify(view.capabilities.effective.extensions)}`);
    lines.push(`sandbox: ${JSON.stringify(view.capabilities.effective.sandbox)}`);
    lines.push(`workspace: ${JSON.stringify(view.capabilities.effective.workspace)}`);
    lines.push(`nesting: ${JSON.stringify(view.capabilities.effective.nesting)}`);
    lines.push("These values are the existing spawn defaults. The catalog did not grant them.");
    if (view.restrictions.length === 0)
        lines.push("execution restrictions: none");
    for (const restriction of view.restrictions) {
        lines.push(`execution restriction ${restriction.name}=${JSON.stringify(restriction.value)} required=${yesNo(restriction.required)} honored=${yesNo(restriction.honored)} enforced=false`);
        if (restriction.reason)
            lines.push(restriction.reason);
    }
    for (const diagnostic of view.validation)
        lines.push(`${diagnostic.code}: ${diagnostic.message}`);
    return lines.join("\n");
}
function definitionDefaults(fields) {
    const model = fields?.model.value ?? null;
    const effort = fields?.effort.value ?? null;
    const label = formatModelEffort(model, effort);
    return label ? { model, effort, label } : null;
}
function field(value) {
    return {
        value: value.value,
        source: value.source,
        explicit: value.explicit,
        inherited: value.source === "role-default",
    };
}
/** The child's observable skill modes: discovery, none, or exactly these paths. */
function skillMode(value) {
    if (value === null)
        return "discovery";
    return value.length === 0 ? "none" : "explicit";
}
/** Saved global `defaultSkills`; a malformed or unreadable config stays visible as an error. */
function configuredSkillDefaults() {
    try {
        const exposure = configuredSkillExposure(loadConfig().defaultSkills);
        return {
            value: exposure.mode === "inherit" ? null : exposure.paths,
            source: exposure.source,
        };
    }
    catch (error) {
        return {
            source: "config",
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
/** Where the active default resolves: session choice, saved global config, or discovery. */
function defaultSkillSource(defaults) {
    if (defaults.source === "session")
        return "session";
    if (defaults.source === "config" && (defaults.error || (defaults.value !== undefined && defaults.value !== null)))
        return "global";
    return "discovery";
}
/**
 * The exposure a launch with no `skills` option would resolve for this
 * definition. A definition's own list wins; otherwise an explicit null or an
 * absent key falls to the active default and then discovery. A session choice
 * that means discovery stays a session source, not a false discovery fallback.
 */
function effectiveSkillExposure(field, defaults) {
    if (field.value !== null) {
        const paths = [...field.value];
        return {
            mode: paths.length === 0 ? "none" : "explicit",
            paths,
            source: field.source === "agent-override" ? "agent-override" : "role-default",
        };
    }
    const source = defaultSkillSource(defaults);
    if (defaults.error) {
        return { mode: "error", paths: [], source, error: defaults.error };
    }
    if (defaults.value === undefined || defaults.value === null) {
        return { mode: "discovery", paths: [], source };
    }
    const paths = [...defaults.value];
    return { mode: paths.length === 0 ? "none" : "explicit", paths, source };
}
function yesNo(value) {
    return value ? "yes" : "no";
}
