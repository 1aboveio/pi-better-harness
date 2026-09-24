/**
 * Portable pi-agent/v1 definitions.
 *
 * Markdown body plus YAML frontmatter. This module is pure: no filesystem, no
 * Pi APIs, and no child launch. Operations and resolution import these types
 * directly; the extension entrypoint is intentionally not wired here.
 *
 * Portable preferences (model, effort, tier) are catalog data. They are not
 * host execution controls and do not grant tools, sandbox modes, or presets.
 */
import { isAlias, isCollection, isMap, isPair, isScalar, parseDocument, stringify, type Node, type Pair } from "yaml";
import { THINKING_LEVELS, type ThinkingLevel } from "./thinking.ts";

export type { ThinkingLevel };

export const CATALOG_SCHEMA_VERSION = "pi-agent/v1" as const;
export type CatalogSchemaVersion = typeof CATALOG_SCHEMA_VERSION;
export type CatalogKind = "role" | "agent";
export type InstructionMode = "add" | "replace";
export type CatalogScope = "project" | "user" | "bundled";
export type PreferenceKey = "model" | "effort" | "tier";
export type DiagnosticSeverity = "error" | "warning" | "info";

export const PREFERENCE_KEYS = ["model", "effort", "tier"] as const satisfies readonly PreferenceKey[];

/** Closed set of thinking levels shared with the existing subagent parser. */
export const EFFORT_LEVELS = THINKING_LEVELS;

/**
 * Top-level keys that describe host execution. The catalog preserves them and
 * blocks launch; it never treats them as enforced permissions or tool presets.
 */
export const HOST_EXECUTION_CONTROL_KEYS = [
    "sandbox",
    "sandbox_mode",
    "sandboxMode",
    "tools",
    "tool",
    "toolPreset",
    "toolsPreset",
    "permissions",
    "permission",
    "mcp",
    "mcpServers",
    "extensions",
    "network",
    "filesystem",
    "cwd",
    "workspace",
    "allow_nested",
    "nested",
    "env",
    "environment",
] as const;

export const PARSER_LIMITS = {
    maxFileBytes: 512 * 1024,
    maxFrontmatterBytes: 128 * 1024,
    maxBodyBytes: 384 * 1024,
    maxAliasCount: 50,
    maxNodes: 2_000,
    maxDepth: 32,
    maxIdLength: 128,
    maxNameLength: 120,
    maxDescriptionLength: 2_000,
    maxStringLength: 64 * 1024,
} as const;

/**
 * Approved bundled-role defaults from DEV-23. Short model names in the product
 * table are OpenAI model ids; stored values use the provider/model form the
 * runtime already uses. Tiers are catalog policy, not benchmark rankings.
 */
export const APPROVED_ROLE_DEFAULTS = [
    { id: "role.researcher", name: "Researcher", model: "openai/gpt-6-sol", effort: "medium", tier: "balanced" },
    { id: "role.explorer", name: "Explorer", model: "openai/gpt-6-luna", effort: "medium", tier: "efficient" },
    { id: "role.product-manager", name: "Product Manager", model: "openai/gpt-6-sol", effort: "medium", tier: "balanced" },
    { id: "role.developer", name: "Developer", model: "openai/gpt-6-sol", effort: "high", tier: "balanced" },
    { id: "role.reviewer", name: "Reviewer", model: "openai/gpt-6-astra", effort: "medium", tier: "frontier" },
    { id: "role.architect", name: "Architect", model: "openai/gpt-6-astra", effort: "high", tier: "frontier" },
] as const;

export const DiagnosticCodes = {
    malformedFrontmatter: "malformed-frontmatter",
    parserLimit: "parser-limit",
    duplicateKey: "duplicate-key",
    invalidSchema: "invalid-schema",
    invalidKind: "invalid-kind",
    invalidId: "invalid-id",
    duplicateId: "duplicate-id",
    invalidField: "invalid-field",
    invalidInstructionMode: "invalid-instruction-mode",
    emptyReplacement: "empty-replacement",
    multipleBaseRoles: "multiple-base-roles",
    missingRole: "missing-role",
    unusableRole: "unusable-role",
    unknownAgent: "unknown-agent",
    unknownRole: "unknown-role",
    ambiguousSelector: "ambiguous-selector",
    missingSelector: "missing-selector",
    invalidShadow: "invalid-shadow",
    unsupportedExecutionRestriction: "unsupported-execution-restriction",
    projectCatalogSuppressed: "project-catalog-suppressed",
    symlinkIgnored: "symlink-ignored",
    credentialMaterial: "credential-material",
    cosmeticMetadata: "cosmetic-metadata",
    untrustedWrite: "untrusted-write",
    immutableScope: "immutable-scope",
    definitionExists: "definition-exists",
    pathEscape: "path-escape",
    notLaunchable: "not-launchable",
    kindDirectoryMismatch: "kind-directory-mismatch",
    bundledMissing: "bundled-missing",
    ioError: "io-error",
    unsafeConfigDir: "unsafe-config-dir",
} as const;

export type DiagnosticCode = (typeof DiagnosticCodes)[keyof typeof DiagnosticCodes];

export interface Diagnostic {
    severity: DiagnosticSeverity;
    code: DiagnosticCode | string;
    message: string;
    id?: string;
    scope?: CatalogScope;
    path?: string;
    field?: string;
    /** Prevents launch of this identity. Does not hide unrelated identities. */
    blocking: boolean;
    /**
     * The file is not a trustworthy whole definition. A higher-priority
     * structural failure occupies its id and blocks lower-priority sources.
     */
    structural: boolean;
}

/** Model, effort, and tier only. Absence inherits; null is an explicit value. */
export interface PortablePreferences {
    model?: string | null;
    effort?: ThinkingLevel | null;
    tier?: string | null;
}

export interface Provenance {
    origin: "local" | "imported";
    format?: string;
    /** Original source label. Not a live sync handle and not a secret. */
    sourceRef?: string;
    importedAt?: string;
    note?: string;
}

/**
 * A required execution restriction the catalog does not enforce.
 * `honored: true` in a file is not proof of enforcement and does not unblock launch.
 */
export interface ExecutionRestriction {
    name: string;
    value: unknown;
    required: boolean;
    honored: boolean;
    reason?: string;
}

interface DefinitionBase {
    schema: CatalogSchemaVersion;
    id: string;
    name: string;
    description?: string;
    provenance?: Provenance;
    executionRestrictions: ExecutionRestriction[];
    /** Explicit metadata object from the file. Cosmetic unless it hides a secret. */
    metadata?: Record<string, unknown>;
    /** Unknown non-execution frontmatter, preserved so writes do not drop it. */
    extensions?: Record<string, unknown>;
    /** Host execution keys preserved verbatim (secrets redacted) and not enforced. */
    preservedExecutionControls?: Record<string, unknown>;
    body: string;
}

export interface RoleDefinition extends DefinitionBase {
    kind: "role";
    defaults: PortablePreferences;
}

export interface AgentDefinition extends DefinitionBase {
    kind: "agent";
    /** Exactly one base role. Executable-role memberships are not additional parents. */
    roleId: string;
    instructionMode: InstructionMode;
    /** Explicit values only. Missing keys inherit and must not be backfilled. */
    overrides: PortablePreferences;
}

export type CatalogDefinition = RoleDefinition | AgentDefinition;

export interface ParseResult {
    /** True when the file is a trustworthy whole definition. Blocking diagnostics may still prevent launch. */
    ok: boolean;
    definition?: CatalogDefinition;
    /** Set when this file should occupy an id even though it is not ok. */
    occupantId?: string;
    diagnostics: Diagnostic[];
}

export interface SerializeResult {
    ok: boolean;
    markdown?: string;
    diagnostics: Diagnostic[];
}

const ID_PATTERN = /^(role|agent)\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const TIER_PATTERN = /^[a-z][a-z0-9-]{0,32}$/;
const SECRET_KEY = /^(api[_-]?key|apikey|secret|password|passwd|token|access[_-]?token|refresh[_-]?token|credential|credentials|authorization|auth|databaseurl|connectionstring|dsn)$/i;
const MULTI_ROLE_KEYS = new Set(["roleIds", "baseRoles", "baseRole", "inherits", "roles"]);
const KNOWN_TOP_LEVEL = new Set([
    "schema",
    "kind",
    "id",
    "name",
    "description",
    "defaults",
    "roleId",
    "instructions",
    "overrides",
    "provenance",
    "executionRestrictions",
    "metadata",
    "extensions",
    "preservedExecutionControls",
    ...HOST_EXECUTION_CONTROL_KEYS,
    ...MULTI_ROLE_KEYS,
]);

const EXECUTION_KEY_SET = new Set<string>(HOST_EXECUTION_CONTROL_KEYS);

export function formatDiagnostic(diagnostic: Diagnostic): string {
    const where = [diagnostic.scope, diagnostic.path, diagnostic.id ? `id ${diagnostic.id}` : undefined]
        .filter(Boolean)
        .join(" ");
    return where ? `${diagnostic.code}: ${diagnostic.message} (${where})` : `${diagnostic.code}: ${diagnostic.message}`;
}

export function hasBlockingDiagnostic(diagnostics: readonly Diagnostic[]): boolean {
    return diagnostics.some((diagnostic) => diagnostic.blocking);
}

export function kindForId(id: string): CatalogKind | undefined {
    if (id.startsWith("role.")) return "role";
    if (id.startsWith("agent.")) return "agent";
    return undefined;
}

export function isPreferenceKey(value: string): value is PreferenceKey {
    return (PREFERENCE_KEYS as readonly string[]).includes(value);
}

/** Explicit override. Null is stored; it does not mean "inherit". */
export function setAgentOverride(agent: AgentDefinition, key: "model", value: string | null): AgentDefinition;
export function setAgentOverride(agent: AgentDefinition, key: "effort", value: ThinkingLevel | null): AgentDefinition;
export function setAgentOverride(agent: AgentDefinition, key: "tier", value: string | null): AgentDefinition;
export function setAgentOverride(agent: AgentDefinition, key: PreferenceKey, value: string | ThinkingLevel | null): AgentDefinition {
    if (key === "model") return { ...agent, overrides: { ...agent.overrides, model: value as string | null } };
    if (key === "effort") return { ...agent, overrides: { ...agent.overrides, effort: value as ThinkingLevel | null } };
    return { ...agent, overrides: { ...agent.overrides, tier: value as string | null } };
}

/** Delete one override key so the next resolution inherits that field again. */
export function removeAgentOverride(agent: AgentDefinition, key: PreferenceKey): AgentDefinition {
    const overrides = { ...agent.overrides };
    delete overrides[key];
    return { ...agent, overrides };
}

export function updateAgentOverrides(
    agent: AgentDefinition,
    patch: { set?: Partial<PortablePreferences>; remove?: readonly PreferenceKey[] },
): AgentDefinition {
    const remove = patch.remove ?? [];
    const set = patch.set ?? {};
    for (const key of remove) {
        if (set[key] !== undefined || (key in set && set[key] === null)) {
            throw new Error(`Override ${key} cannot be both set and removed.`);
        }
    }
    const overrides: PortablePreferences = { ...agent.overrides };
    for (const key of remove) delete overrides[key];
    if (Object.prototype.hasOwnProperty.call(set, "model") && set.model !== undefined) overrides.model = set.model;
    if (Object.prototype.hasOwnProperty.call(set, "effort") && set.effort !== undefined) overrides.effort = set.effort;
    if (Object.prototype.hasOwnProperty.call(set, "tier") && set.tier !== undefined) overrides.tier = set.tier;
    return { ...agent, overrides };
}

export function parseDefinition(markdown: string, sourcePath?: string): ParseResult {
    const diagnostics: Diagnostic[] = [];
    if (Buffer.byteLength(markdown, "utf8") > PARSER_LIMITS.maxFileBytes) {
        diagnostics.push(problem(DiagnosticCodes.parserLimit, `Definition exceeds ${PARSER_LIMITS.maxFileBytes} bytes. Split or shorten it.`, {
            path: sourcePath,
            blocking: true,
            structural: true,
        }));
        return { ok: false, diagnostics, ...occupantFromSource(markdown) };
    }
    if (markdown.includes("\0")) {
        diagnostics.push(problem(DiagnosticCodes.malformedFrontmatter, "Definition contains NUL and was not parsed.", {
            path: sourcePath,
            blocking: true,
            structural: true,
        }));
        return { ok: false, diagnostics };
    }

    const split = splitFrontmatter(markdown);
    if ("error" in split) {
        diagnostics.push(problem(DiagnosticCodes.malformedFrontmatter, split.error, {
            path: sourcePath,
            blocking: true,
            structural: true,
        }));
        return { ok: false, diagnostics };
    }
    if (Buffer.byteLength(split.yaml, "utf8") > PARSER_LIMITS.maxFrontmatterBytes) {
        diagnostics.push(problem(DiagnosticCodes.parserLimit, `Frontmatter exceeds ${PARSER_LIMITS.maxFrontmatterBytes} bytes.`, {
            path: sourcePath,
            blocking: true,
            structural: true,
        }));
        return { ok: false, diagnostics, ...occupantFromSource(split.yaml) };
    }
    if (Buffer.byteLength(split.body, "utf8") > PARSER_LIMITS.maxBodyBytes) {
        diagnostics.push(problem(DiagnosticCodes.parserLimit, `Instruction body exceeds ${PARSER_LIMITS.maxBodyBytes} bytes.`, {
            path: sourcePath,
            blocking: true,
            structural: true,
        }));
        return { ok: false, diagnostics, ...occupantFromSource(split.yaml) };
    }

    const document = parseDocument(split.yaml, {
        uniqueKeys: true,
        version: "1.2",
        schema: "core",
        merge: true,
        resolveKnownTags: false,
        strict: true,
        prettyErrors: true,
    });
    const identity = occupantFromDocument(document);
    if (document.errors.length > 0) {
        for (const error of document.errors) {
            const duplicate = /unique|duplicated mapping key/i.test(error.message);
            diagnostics.push(problem(duplicate ? DiagnosticCodes.duplicateKey : DiagnosticCodes.malformedFrontmatter, clip(error.message), {
                path: sourcePath,
                id: identity.occupantId,
                blocking: true,
                structural: true,
            }));
        }
        return { ok: false, diagnostics, ...identity };
    }

    const measured = measureNode(document.contents);
    if (measured.nodes > PARSER_LIMITS.maxNodes || measured.depth > PARSER_LIMITS.maxDepth) {
        diagnostics.push(problem(
            DiagnosticCodes.parserLimit,
            `Frontmatter has ${measured.nodes} nodes at depth ${measured.depth}. Limits are ${PARSER_LIMITS.maxNodes} nodes and depth ${PARSER_LIMITS.maxDepth}. Anchors are allowed within these limits.`,
            { path: sourcePath, id: identity.occupantId, blocking: true, structural: true },
        ));
        return { ok: false, diagnostics, ...identity };
    }

    let data: unknown;
    try {
        data = document.toJS({ maxAliasCount: PARSER_LIMITS.maxAliasCount });
    } catch (error) {
        diagnostics.push(problem(DiagnosticCodes.parserLimit, clip(error instanceof Error ? error.message : String(error)), {
            path: sourcePath,
            id: identity.occupantId,
            blocking: true,
            structural: true,
        }));
        return { ok: false, diagnostics, ...identity };
    }

    const graph = yamlGraphIssue(data);
    if (graph) {
        diagnostics.push(problem(
            DiagnosticCodes.parserLimit,
            graph === "cycle"
                ? "YAML alias cycle in frontmatter. Later aliases may repeat an earlier anchor, but a cycle is rejected before recursive traversal so this file cannot exhaust the catalog read. Remove the cyclic alias. Alias expansions stay limited to 50, nodes to 2000, and depth to 32."
                : `YAML alias graph exceeded the catalog bounds (${PARSER_LIMITS.maxNodes} nodes, depth ${PARSER_LIMITS.maxDepth}) while checking for cycles. Shorten the frontmatter.`,
            { path: sourcePath, id: identity.occupantId, blocking: true, structural: true },
        ));
        return { ok: false, diagnostics, ...identity };
    }

    if (!isPlainObject(data)) {
        diagnostics.push(problem(DiagnosticCodes.malformedFrontmatter, "Frontmatter must be a YAML mapping.", {
            path: sourcePath,
            id: identity.occupantId,
            blocking: true,
            structural: true,
        }));
        return { ok: false, diagnostics, ...identity };
    }

    try {
        return interpretMapping(data, split.body, diagnostics, sourcePath);
    } catch (error) {
        diagnostics.push(problem(
            DiagnosticCodes.parserLimit,
            `Catalog parser stopped on this file: ${clip(error instanceof Error ? error.message : String(error))}. Other definitions are unaffected. Remove cyclic aliases or shorten the frontmatter.`,
            { path: sourcePath, id: identity.occupantId, blocking: true, structural: true },
        ));
        return { ok: false, diagnostics, ...identity };
    }
}

export function validateDefinition(definition: CatalogDefinition): ParseResult {
    return parseDefinition(serializeUnchecked(definition), undefined);
}

export function serializeDefinition(definition: CatalogDefinition): SerializeResult {
    const parsed = validateDefinition(definition);
    if (!parsed.ok || !parsed.definition) {
        return { ok: false, diagnostics: parsed.diagnostics };
    }
    return {
        ok: true,
        markdown: serializeUnchecked(parsed.definition),
        diagnostics: parsed.diagnostics,
    };
}

function serializeUnchecked(definition: CatalogDefinition): string {
    const mapping: Record<string, unknown> = {
        schema: definition.schema,
        kind: definition.kind,
        id: definition.id,
        name: definition.name,
    };
    if (definition.description !== undefined) mapping.description = definition.description;
    if (definition.kind === "agent") {
        mapping.roleId = definition.roleId;
        mapping.instructions = { mode: definition.instructionMode };
        if (hasPreference(definition.overrides)) mapping.overrides = preferenceMapping(definition.overrides);
    } else if (hasPreference(definition.defaults)) {
        mapping.defaults = preferenceMapping(definition.defaults);
    }
    if (definition.provenance) mapping.provenance = { ...definition.provenance };
    if (definition.executionRestrictions.length > 0) mapping.executionRestrictions = definition.executionRestrictions.map((item) => ({ ...item }));
    if (definition.metadata && Object.keys(definition.metadata).length > 0) mapping.metadata = definition.metadata;
    if (definition.extensions && Object.keys(definition.extensions).length > 0) mapping.extensions = definition.extensions;
    if (definition.preservedExecutionControls && Object.keys(definition.preservedExecutionControls).length > 0) {
        mapping.preservedExecutionControls = definition.preservedExecutionControls;
    }
    const yaml = stringify(mapping, { lineWidth: 0 }).trimEnd();
    const body = definition.body.length === 0 ? "\n" : definition.body.startsWith("\n") ? definition.body : `\n${definition.body}`;
    const normalizedBody = body.endsWith("\n") ? body : `${body}\n`;
    return `---\n${yaml}\n---${normalizedBody}`;
}

function interpretMapping(
    data: Record<string, unknown>,
    body: string,
    diagnostics: Diagnostic[],
    sourcePath: string | undefined,
): ParseResult {
    const redacted = redactSecrets(data, "frontmatter", diagnostics, sourcePath) as Record<string, unknown>;
    const idText = typeof redacted.id === "string" ? redacted.id : undefined;
    const occupantId = idText && ID_PATTERN.test(idText) ? idText : undefined;

    if (redacted.schema !== CATALOG_SCHEMA_VERSION) {
        diagnostics.push(problem(DiagnosticCodes.invalidSchema, `schema must be ${CATALOG_SCHEMA_VERSION}.`, {
            path: sourcePath,
            field: "schema",
            id: occupantId,
            blocking: true,
            structural: true,
        }));
    }
    if (redacted.kind !== "role" && redacted.kind !== "agent") {
        diagnostics.push(problem(DiagnosticCodes.invalidKind, "kind must be role or agent.", {
            path: sourcePath,
            field: "kind",
            id: occupantId,
            blocking: true,
            structural: true,
        }));
    }
    if (!occupantId) {
        diagnostics.push(problem(
            DiagnosticCodes.invalidId,
            "id must be a stable role.<slug> or agent.<slug> identifier, independent of the file name. Use lowercase letters, numbers, dots, and hyphens.",
            { path: sourcePath, field: "id", blocking: true, structural: true },
        ));
    } else if (redacted.kind === "role" || redacted.kind === "agent") {
        if (kindForId(occupantId) !== redacted.kind) {
            diagnostics.push(problem(DiagnosticCodes.invalidId, `id ${occupantId} does not match kind ${redacted.kind}.`, {
                path: sourcePath,
                field: "id",
                id: occupantId,
                blocking: true,
                structural: true,
            }));
        }
    }

    const name = readName(redacted.name, diagnostics, sourcePath, occupantId);
    const description = readDescription(redacted.description, diagnostics, sourcePath, occupantId);
    const extensions: Record<string, unknown> = {};
    const preservedExecutionControls: Record<string, unknown> = isPlainObject(redacted.preservedExecutionControls)
        ? { ...redacted.preservedExecutionControls }
        : {};
    if (redacted.preservedExecutionControls !== undefined && !isPlainObject(redacted.preservedExecutionControls)) {
        diagnostics.push(problem(DiagnosticCodes.invalidField, "preservedExecutionControls must be a mapping.", {
            path: sourcePath,
            field: "preservedExecutionControls",
            id: occupantId,
            blocking: true,
            structural: true,
        }));
    }

    for (const key of Object.keys(redacted)) {
        if (KNOWN_TOP_LEVEL.has(key)) continue;
        extensions[key] = redacted[key];
        diagnostics.push(problem(
            DiagnosticCodes.cosmeticMetadata,
            `Unknown field ${key} was preserved and is not enforced.`,
            { path: sourcePath, field: key, id: occupantId, blocking: false, structural: false, severity: "warning" },
        ));
    }
    if (isPlainObject(redacted.extensions)) {
        for (const [key, value] of Object.entries(redacted.extensions)) extensions[key] = value;
    }

    for (const key of HOST_EXECUTION_CONTROL_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(redacted, key)) continue;
        preservedExecutionControls[key] = redacted[key];
        rememberRestriction(key, redacted[key], diagnostics, sourcePath, occupantId);
    }

    const multi = [...MULTI_ROLE_KEYS].filter((key) => Object.prototype.hasOwnProperty.call(redacted, key));
    if (multi.length > 0 || Array.isArray(redacted.roleId)) {
        for (const key of multi) extensions[key] = redacted[key];
        diagnostics.push(problem(
            DiagnosticCodes.multipleBaseRoles,
            "An agent has exactly one base role (roleId). Multiple inheritance and executable-role memberships are not catalog parents. Remove the extra role fields.",
            { path: sourcePath, field: multi[0] ?? "roleId", id: occupantId, blocking: true, structural: true },
        ));
    }

    const provenance = readProvenance(redacted.provenance, extensions, diagnostics, sourcePath, occupantId);
    const restrictions = readRestrictions(redacted.executionRestrictions, diagnostics, sourcePath, occupantId);
    for (const key of Object.keys(preservedExecutionControls)) {
        if (restrictions.some((item) => item.name === key)) continue;
        restrictions.push({
            name: key,
            value: preservedExecutionControls[key],
            required: true,
            honored: false,
            reason: "Preserved host execution control. The catalog does not enforce it, so launch stays blocked until the restriction is removed.",
        });
    }
    for (const restriction of restrictions) {
        if (!restriction.required) {
            diagnostics.push(problem(
                DiagnosticCodes.cosmeticMetadata,
                `Optional execution restriction ${restriction.name} is preserved and is not enforced.`,
                { path: sourcePath, field: restriction.name, id: occupantId, blocking: false, structural: false, severity: "warning" },
            ));
            continue;
        }
        diagnostics.push(problem(
            DiagnosticCodes.unsupportedExecutionRestriction,
            restriction.honored
                ? `Required execution restriction ${restriction.name} claims to be honored, but this catalog does not enforce host controls. Remove the restriction after it is actually resolved; a flag does not make it active.`
                : `Required execution restriction ${restriction.name} is preserved and blocks launch because the catalog cannot enforce it. ${restriction.reason ?? "Remove it once a real host control covers it, or delete the requirement."}`,
            { path: sourcePath, field: restriction.name, id: occupantId, blocking: true, structural: false },
        ));
    }

    const metadata = isPlainObject(redacted.metadata) ? redacted.metadata : undefined;
    if (redacted.metadata !== undefined && !isPlainObject(redacted.metadata)) {
        diagnostics.push(problem(DiagnosticCodes.invalidField, "metadata must be a mapping.", {
            path: sourcePath,
            field: "metadata",
            id: occupantId,
            blocking: true,
            structural: true,
        }));
    } else if (metadata && Object.keys(metadata).length > 0) {
        diagnostics.push(problem(DiagnosticCodes.cosmeticMetadata, "metadata is preserved and does not change launch or capabilities.", {
            path: sourcePath,
            field: "metadata",
            id: occupantId,
            blocking: false,
            structural: false,
            severity: "info",
        }));
    }

    const structural = diagnostics.some((diagnostic) => diagnostic.structural);
    if (structural || !occupantId || (redacted.kind !== "role" && redacted.kind !== "agent") || !name) {
        return { ok: false, occupantId, diagnostics };
    }

    if (redacted.kind === "role") {
        if (redacted.roleId !== undefined || redacted.instructions !== undefined || redacted.overrides !== undefined) {
            diagnostics.push(problem(DiagnosticCodes.invalidField, "Roles do not take roleId, instructions, or overrides. Put model, effort, and tier in defaults.", {
                path: sourcePath,
                id: occupantId,
                blocking: true,
                structural: true,
            }));
            return { ok: false, occupantId, diagnostics };
        }
        const defaults = readPreferences(redacted.defaults, "defaults", extensions, restrictions, diagnostics, sourcePath, occupantId);
        if (diagnostics.some((diagnostic) => diagnostic.structural)) return { ok: false, occupantId, diagnostics };
        const definition: RoleDefinition = compactDefinition({
            schema: CATALOG_SCHEMA_VERSION,
            kind: "role",
            id: occupantId,
            name,
            description,
            defaults: defaults ?? {},
            provenance,
            executionRestrictions: restrictions,
            metadata,
            extensions: Object.keys(extensions).length > 0 ? extensions : undefined,
            preservedExecutionControls: Object.keys(preservedExecutionControls).length > 0 ? preservedExecutionControls : undefined,
            body,
        });
        return { ok: true, definition, diagnostics };
    }

    if (redacted.defaults !== undefined) {
        extensions.defaults = redacted.defaults;
        diagnostics.push(problem(
            DiagnosticCodes.invalidField,
            "Agents must not store role defaults. Omit inherited fields and set only explicit overrides. The defaults mapping was preserved under extensions and was not copied into overrides.",
            { path: sourcePath, field: "defaults", id: occupantId, blocking: true, structural: true },
        ));
        return { ok: false, occupantId, diagnostics };
    }

    const roleId = typeof redacted.roleId === "string" && ID_PATTERN.test(redacted.roleId) && kindForId(redacted.roleId) === "role"
        ? redacted.roleId
        : undefined;
    if (!roleId) {
        diagnostics.push(problem(DiagnosticCodes.invalidField, "roleId must reference exactly one role.<slug> base role.", {
            path: sourcePath,
            field: "roleId",
            id: occupantId,
            blocking: true,
            structural: true,
        }));
        return { ok: false, occupantId, diagnostics };
    }

    const instructionMode = readInstructionMode(redacted.instructions, diagnostics, sourcePath, occupantId);
    if (!instructionMode || diagnostics.some((diagnostic) => diagnostic.structural)) {
        return { ok: false, occupantId, diagnostics };
    }
    if (instructionMode === "replace" && body.trim().length === 0) {
        diagnostics.push(problem(
            DiagnosticCodes.emptyReplacement,
            "Instruction mode replace requires nonempty instruction text. Model and effort still inherit unless overridden; an empty replacement was not saved as add mode.",
            { path: sourcePath, field: "instructions.mode", id: occupantId, blocking: true, structural: true },
        ));
        return { ok: false, occupantId, diagnostics };
    }

    const overrides = readPreferences(redacted.overrides, "overrides", extensions, restrictions, diagnostics, sourcePath, occupantId);
    if (diagnostics.some((diagnostic) => diagnostic.structural)) return { ok: false, occupantId, diagnostics };

    const definition: AgentDefinition = compactDefinition({
        schema: CATALOG_SCHEMA_VERSION,
        kind: "agent",
        id: occupantId,
        name,
        description,
        roleId,
        instructionMode,
        overrides: overrides ?? {},
        provenance,
        executionRestrictions: restrictions,
        metadata,
        extensions: Object.keys(extensions).length > 0 ? extensions : undefined,
        preservedExecutionControls: Object.keys(preservedExecutionControls).length > 0 ? preservedExecutionControls : undefined,
        body,
    });
    return { ok: true, definition, diagnostics };
}

function readInstructionMode(
    value: unknown,
    diagnostics: Diagnostic[],
    sourcePath: string | undefined,
    id: string | undefined,
): InstructionMode | undefined {
    if (value === undefined) return "add";
    if (!isPlainObject(value) || Array.isArray(value)) {
        diagnostics.push(problem(DiagnosticCodes.invalidInstructionMode, "instructions must be a mapping with mode add (default) or replace.", {
            path: sourcePath,
            field: "instructions",
            id,
            blocking: true,
            structural: true,
        }));
        return undefined;
    }
    const mode = value.mode === undefined ? "add" : value.mode;
    if (mode !== "add" && mode !== "replace") {
        diagnostics.push(problem(DiagnosticCodes.invalidInstructionMode, "instructions.mode must be add or replace. replace changes instruction text only.", {
            path: sourcePath,
            field: "instructions.mode",
            id,
            blocking: true,
            structural: true,
        }));
        return undefined;
    }
    for (const key of Object.keys(value)) {
        if (key === "mode") continue;
        diagnostics.push(problem(DiagnosticCodes.invalidField, `Unknown instructions.${key} is not allowed. Instruction text belongs in the Markdown body.`, {
            path: sourcePath,
            field: `instructions.${key}`,
            id,
            blocking: true,
            structural: true,
        }));
    }
    return mode;
}

function readPreferences(
    value: unknown,
    field: "defaults" | "overrides",
    extensions: Record<string, unknown>,
    restrictions: ExecutionRestriction[],
    diagnostics: Diagnostic[],
    sourcePath: string | undefined,
    id: string | undefined,
): PortablePreferences | undefined {
    if (value === undefined) return {};
    if (!isPlainObject(value)) {
        diagnostics.push(problem(DiagnosticCodes.invalidField, `${field} must be a mapping of model, effort, and tier.`, {
            path: sourcePath,
            field,
            id,
            blocking: true,
            structural: true,
        }));
        return undefined;
    }
    const preferences: PortablePreferences = {};
    for (const key of Object.keys(value)) {
        if (!isPreferenceKey(key)) {
            const target = `${field}.${key}`;
            extensions[target] = value[key];
            if (EXECUTION_KEY_SET.has(key)) {
                rememberRestriction(target, value[key], diagnostics, sourcePath, id);
                restrictions.push({
                    name: target,
                    value: value[key] ?? null,
                    required: true,
                    honored: false,
                    reason: "Host execution control nested in preferences. Preserved and not enforced.",
                });
                diagnostics.push(problem(
                    DiagnosticCodes.unsupportedExecutionRestriction,
                    `${target} is a host execution control, not a portable preference. It was preserved and blocks launch. Model, effort, and tier are the only preference fields.`,
                    { path: sourcePath, field: target, id, blocking: true, structural: false },
                ));
            } else {
                diagnostics.push(problem(DiagnosticCodes.cosmeticMetadata, `Unknown ${target} was preserved and is not a model, effort, or tier preference.`, {
                    path: sourcePath,
                    field: target,
                    id,
                    blocking: false,
                    structural: false,
                    severity: "warning",
                }));
            }
            continue;
        }
        const item = value[key];
        if (item === null) {
            preferences[key] = null;
            continue;
        }
        if (key === "model") {
            if (typeof item !== "string" || !MODEL_PATTERN.test(item)) {
                diagnostics.push(problem(DiagnosticCodes.invalidField, "model must be provider/model, without an @effort suffix. Set effort separately.", {
                    path: sourcePath,
                    field: `${field}.model`,
                    id,
                    blocking: true,
                    structural: true,
                }));
                continue;
            }
            preferences.model = item;
            continue;
        }
        if (key === "effort") {
            if (typeof item !== "string" || !(THINKING_LEVELS as readonly string[]).includes(item)) {
                diagnostics.push(problem(
                    DiagnosticCodes.invalidField,
                    `effort must be one of ${THINKING_LEVELS.join(", ")}. Availability against a live model is checked at resolution, not here.`,
                    { path: sourcePath, field: `${field}.effort`, id, blocking: true, structural: true },
                ));
                continue;
            }
            preferences.effort = item as ThinkingLevel;
            continue;
        }
        if (typeof item !== "string" || !TIER_PATTERN.test(item)) {
            diagnostics.push(problem(DiagnosticCodes.invalidField, "tier must be a short lowercase catalog-policy label such as balanced, efficient, or frontier.", {
                path: sourcePath,
                field: `${field}.tier`,
                id,
                blocking: true,
                structural: true,
            }));
            continue;
        }
        preferences.tier = item;
    }
    return preferences;
}

function readRestrictions(
    value: unknown,
    diagnostics: Diagnostic[],
    sourcePath: string | undefined,
    id: string | undefined,
): ExecutionRestriction[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
        diagnostics.push(problem(DiagnosticCodes.invalidField, "executionRestrictions must be a list.", {
            path: sourcePath,
            field: "executionRestrictions",
            id,
            blocking: true,
            structural: true,
        }));
        return [];
    }
    const restrictions: ExecutionRestriction[] = [];
    for (const [index, item] of value.entries()) {
        if (!isPlainObject(item) || typeof item.name !== "string" || item.name.trim() === "") {
            diagnostics.push(problem(DiagnosticCodes.invalidField, `executionRestrictions[${index}] needs a name.`, {
                path: sourcePath,
                field: "executionRestrictions",
                id,
                blocking: true,
                structural: true,
            }));
            continue;
        }
        if (!isJsonData(item.value) && item.value !== undefined) {
            diagnostics.push(problem(DiagnosticCodes.invalidField, `executionRestrictions[${index}].value must be JSON-compatible data.`, {
                path: sourcePath,
                field: `executionRestrictions.${item.name}`,
                id,
                blocking: true,
                structural: true,
            }));
            continue;
        }
        const required = item.required === undefined ? true : item.required === true;
        if (item.required !== undefined && typeof item.required !== "boolean") {
            diagnostics.push(problem(DiagnosticCodes.invalidField, `executionRestrictions ${item.name} required must be a boolean.`, {
                path: sourcePath,
                field: item.name,
                id,
                blocking: true,
                structural: true,
            }));
            continue;
        }
        const honored = item.honored === true;
        restrictions.push({
            name: item.name,
            value: item.value ?? null,
            required,
            honored,
            reason: typeof item.reason === "string" ? item.reason : undefined,
        });
    }
    return restrictions;
}

function readProvenance(
    value: unknown,
    extensions: Record<string, unknown>,
    diagnostics: Diagnostic[],
    sourcePath: string | undefined,
    id: string | undefined,
): Provenance | undefined {
    if (value === undefined) return undefined;
    if (!isPlainObject(value)) {
        diagnostics.push(problem(DiagnosticCodes.invalidField, "provenance must be a mapping.", {
            path: sourcePath,
            field: "provenance",
            id,
            blocking: true,
            structural: true,
        }));
        return undefined;
    }
    if (value.origin !== "local" && value.origin !== "imported") {
        diagnostics.push(problem(DiagnosticCodes.invalidField, "provenance.origin must be local or imported.", {
            path: sourcePath,
            field: "provenance.origin",
            id,
            blocking: true,
            structural: true,
        }));
        return undefined;
    }
    const provenance: Provenance = { origin: value.origin };
    if (value.format !== undefined) {
        if (typeof value.format !== "string" || value.format.length > 80) {
            diagnostics.push(problem(DiagnosticCodes.invalidField, "provenance.format must be a short string.", {
                path: sourcePath,
                field: "provenance.format",
                id,
                blocking: true,
                structural: true,
            }));
        } else {
            provenance.format = value.format;
        }
    }
    if (value.sourceRef !== undefined) {
        if (typeof value.sourceRef !== "string" || value.sourceRef.length > 500 || /[\r\n]/.test(value.sourceRef)) {
            diagnostics.push(problem(DiagnosticCodes.invalidField, "provenance.sourceRef must be a single-line source label, not credential material.", {
                path: sourcePath,
                field: "provenance.sourceRef",
                id,
                blocking: true,
                structural: true,
            }));
        } else {
            provenance.sourceRef = value.sourceRef;
        }
    }
    if (value.importedAt !== undefined) {
        if (typeof value.importedAt !== "string" || value.importedAt.length > 40) {
            diagnostics.push(problem(DiagnosticCodes.invalidField, "provenance.importedAt must be a short timestamp string.", {
                path: sourcePath,
                field: "provenance.importedAt",
                id,
                blocking: true,
                structural: true,
            }));
        } else {
            provenance.importedAt = value.importedAt;
        }
    }
    if (value.note !== undefined) {
        if (typeof value.note !== "string" || value.note.length > 500) {
            diagnostics.push(problem(DiagnosticCodes.invalidField, "provenance.note must be a string of at most 500 characters.", {
                path: sourcePath,
                field: "provenance.note",
                id,
                blocking: true,
                structural: true,
            }));
        } else {
            provenance.note = value.note;
        }
    }
    for (const key of Object.keys(value)) {
        if (["origin", "format", "sourceRef", "importedAt", "note"].includes(key)) continue;
        extensions[`provenance.${key}`] = value[key];
        diagnostics.push(problem(DiagnosticCodes.cosmeticMetadata, `Unknown provenance.${key} was preserved.`, {
            path: sourcePath,
            field: `provenance.${key}`,
            id,
            blocking: false,
            structural: false,
            severity: "warning",
        }));
    }
    return provenance;
}

function readName(value: unknown, diagnostics: Diagnostic[], sourcePath: string | undefined, id: string | undefined): string | undefined {
    if (typeof value !== "string" || value.trim() === "" || value.trim().length > PARSER_LIMITS.maxNameLength || /[\u0000-\u001F]/.test(value)) {
        diagnostics.push(problem(DiagnosticCodes.invalidField, "name must be a nonempty display name of at most 120 characters. Renaming it does not change id.", {
            path: sourcePath,
            field: "name",
            id,
            blocking: true,
            structural: true,
        }));
        return undefined;
    }
    return value.trim();
}

function readDescription(value: unknown, diagnostics: Diagnostic[], sourcePath: string | undefined, id: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.trim() === "" || value.length > PARSER_LIMITS.maxDescriptionLength) {
        diagnostics.push(problem(DiagnosticCodes.invalidField, "description must be a nonempty string of at most 2000 characters when present.", {
            path: sourcePath,
            field: "description",
            id,
            blocking: true,
            structural: true,
        }));
        return undefined;
    }
    return value.trim();
}

function rememberRestriction(
    name: string,
    value: unknown,
    diagnostics: Diagnostic[],
    sourcePath: string | undefined,
    id: string | undefined,
): void {
    if (!isJsonData(value) && value !== undefined) {
        diagnostics.push(problem(DiagnosticCodes.invalidField, `${name} must be JSON-compatible when preserved as a restriction.`, {
            path: sourcePath,
            field: name,
            id,
            blocking: true,
            structural: true,
        }));
    }
}

function redactSecrets(
    value: unknown,
    pathLabel: string,
    diagnostics: Diagnostic[],
    sourcePath: string | undefined,
    stack: Set<object> = new Set(),
): unknown {
    if (typeof value !== "object" || value === null) return value;
    if (stack.has(value)) throw new Error("YAML alias cycle");
    if (Array.isArray(value)) {
        stack.add(value);
        try {
            return value.map((item, index) => redactSecrets(item, `${pathLabel}[${index}]`, diagnostics, sourcePath, stack));
        } finally {
            stack.delete(value);
        }
    }
    if (!isPlainObject(value)) return value;
    stack.add(value);
    try {
        const output: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value)) {
            if (SECRET_KEY.test(key)) {
                diagnostics.push(problem(
                    DiagnosticCodes.credentialMaterial,
                    `Field ${pathLabel}.${key} looks like credential or connection material and was not stored. Remove it from the definition. Launch stays blocked.`,
                    { path: sourcePath, field: key, blocking: true, structural: false },
                ));
                output[key] = "[redacted]";
                continue;
            }
            output[key] = redactSecrets(child, `${pathLabel}.${key}`, diagnostics, sourcePath, stack);
        }
        return output;
    } finally {
        stack.delete(value);
    }
}

function splitFrontmatter(source: string): { yaml: string; body: string } | { error: string } {
    const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
    const opening = /^---[ \t]*\r?\n/.exec(text);
    if (!opening) {
        return { error: "Definition must be Markdown with opening YAML frontmatter (---). Filename and display name are not the schema." };
    }
    const rest = text.slice(opening[0].length);
    const closing = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(rest);
    if (!closing || closing.index === undefined) {
        return { error: "Frontmatter is missing the closing --- line. Keep instruction text below it." };
    }
    return {
        yaml: rest.slice(0, closing.index),
        body: rest.slice(closing.index + closing[0].length),
    };
}

function occupantFromSource(yaml: string): { occupantId?: string } {
    const ids = new Set<string>();
    for (const line of yaml.split(/\r?\n/)) {
        const match = /^id:[ \t]*(["']?)((?:role|agent)\.[a-z0-9]+(?:[.-][a-z0-9]+)*)\1[ \t]*$/.exec(line);
        if (match?.[2]) ids.add(match[2]);
    }
    if (ids.size !== 1) return {};
    return { occupantId: [...ids][0] };
}

/**
 * Stable id from the top-level `id` key of a parsed document, including when a
 * later field is malformed. Comments and nested values are not identities.
 * Aliases count only when they point at an earlier scalar anchor. Distinct
 * top-level ids are not guessed between.
 */
function occupantFromDocument(document: { contents: Node | null }): { occupantId?: string } {
    if (!isMap(document.contents)) return {};
    const ordered = nodesInOrder(document.contents);
    const resolved: string[] = [];
    for (const item of document.contents.items) {
        if (!isPair(item) || !isScalar(item.key) || item.key.value !== "id") continue;
        const value = resolveIdScalar(item.value as Node | null, ordered);
        if (value === undefined) return {};
        resolved.push(value);
    }
    if (resolved.length === 0) return {};
    if (new Set(resolved).size !== 1) return {};
    const id = resolved[0]!;
    if (!ID_PATTERN.test(id)) return {};
    return { occupantId: id };
}

function resolveIdScalar(node: Node | null | undefined, ordered: OrderedNode[] | undefined): string | undefined {
    if (!node) return undefined;
    if (isScalar(node)) return typeof node.value === "string" ? node.value : undefined;
    if (!isAlias(node) || !ordered) return undefined;
    const seen = new Set<Node>();
    let current: Node | undefined = node;
    while (current && isAlias(current)) {
        if (seen.has(current)) return undefined;
        seen.add(current);
        const index = ordered.findIndex((item) => item.node === current);
        if (index < 0) return undefined;
        let target: Node | undefined;
        for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
            if (ordered[cursor]!.anchor === current.source) {
                target = ordered[cursor]!.node;
                break;
            }
        }
        current = target;
    }
    return current && isScalar(current) && typeof current.value === "string" ? current.value : undefined;
}

interface OrderedNode {
    node: Node;
    anchor?: string;
}

function nodesInOrder(root: Node | null): OrderedNode[] | undefined {
    const ordered: OrderedNode[] = [];
    const stack: Array<Node | Pair | null> = [root];
    let visited = 0;
    while (stack.length > 0) {
        if (++visited > PARSER_LIMITS.maxNodes + 1) return undefined;
        const current = stack.pop();
        if (!current) continue;
        if (isAlias(current)) {
            ordered.push({ node: current });
            continue;
        }
        if (isScalar(current) || isCollection(current)) {
            const anchor = typeof current.anchor === "string" && current.anchor.length > 0 ? current.anchor : undefined;
            ordered.push({ node: current, anchor });
        }
        if (isPair(current)) {
            stack.push(current.value as Node | null, current.key as Node | null);
            continue;
        }
        if (isCollection(current)) {
            for (let index = current.items.length - 1; index >= 0; index -= 1) {
                stack.push(current.items[index] as Node | Pair);
            }
        }
    }
    return ordered;
}

/** Iterative cycle check. Shared anchors (a diamond) are not cycles. */
function yamlGraphIssue(value: unknown): "cycle" | "limit" | undefined {
    const seen = new Set<object>();
    const inStack = new Set<object>();
    const frames: { node: object; children: readonly unknown[]; index: number }[] = [];
    const push = (node: unknown): "cycle" | "limit" | undefined => {
        if (typeof node !== "object" || node === null) return undefined;
        if (inStack.has(node)) return "cycle";
        if (seen.has(node)) return undefined;
        if (seen.size >= PARSER_LIMITS.maxNodes || frames.length >= PARSER_LIMITS.maxDepth) return "limit";
        seen.add(node);
        inStack.add(node);
        frames.push({
            node,
            children: Array.isArray(node) ? node : Object.values(node),
            index: 0,
        });
        return undefined;
    };
    const rootIssue = push(value);
    if (rootIssue) return rootIssue;
    while (frames.length > 0) {
        const frame = frames[frames.length - 1]!;
        if (frame.index >= frame.children.length) {
            inStack.delete(frame.node);
            frames.pop();
            continue;
        }
        const issue = push(frame.children[frame.index]);
        frame.index += 1;
        if (issue) return issue;
    }
    return undefined;
}

function measureNode(node: Node | null): { nodes: number; depth: number } {
    const state = { nodes: 0, depth: 0 };
    walkNode(node, 1, state);
    return state;
}

function walkNode(node: Node | Pair | null, depth: number, state: { nodes: number; depth: number }): void {
    if (node == null || state.nodes > PARSER_LIMITS.maxNodes + 1) return;
    state.nodes += 1;
    state.depth = Math.max(state.depth, depth);
    if (isAlias(node)) return;
    if (isPair(node)) {
        walkNode(node.key as Node | null, depth + 1, state);
        walkNode(node.value as Node | null, depth + 1, state);
        return;
    }
    if (isCollection(node)) {
        for (const item of node.items) walkNode(item as Node | Pair, depth + 1, state);
    }
}

function preferenceMapping(preferences: PortablePreferences): Record<string, unknown> {
    const mapping: Record<string, unknown> = {};
    for (const key of PREFERENCE_KEYS) {
        if (Object.prototype.hasOwnProperty.call(preferences, key) && preferences[key] !== undefined) {
            mapping[key] = preferences[key];
        }
    }
    return mapping;
}

function hasPreference(preferences: PortablePreferences): boolean {
    return PREFERENCE_KEYS.some((key) => preferences[key] !== undefined);
}

function compactDefinition<T extends CatalogDefinition>(definition: T): T {
    if (!definition.description) delete definition.description;
    if (!definition.provenance) delete definition.provenance;
    if (!definition.metadata) delete definition.metadata;
    if (!definition.extensions) delete definition.extensions;
    if (!definition.preservedExecutionControls) delete definition.preservedExecutionControls;
    return definition;
}

function problem(
    code: DiagnosticCode,
    message: string,
    fields: {
        path?: string;
        field?: string;
        id?: string;
        blocking: boolean;
        structural: boolean;
        severity?: DiagnosticSeverity;
    },
): Diagnostic {
    return {
        severity: fields.severity ?? (fields.blocking ? "error" : "warning"),
        code,
        message,
        path: fields.path,
        field: fields.field,
        id: fields.id,
        blocking: fields.blocking,
        structural: fields.structural,
    };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isJsonData(value: unknown, depth = 0): boolean {
    if (value === null) return true;
    if (typeof value === "string") return value.length <= PARSER_LIMITS.maxStringLength;
    if (typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (depth > PARSER_LIMITS.maxDepth) return false;
    if (Array.isArray(value)) return value.every((item) => isJsonData(item, depth + 1));
    if (isPlainObject(value)) return Object.values(value).every((item) => isJsonData(item, depth + 1));
    return false;
}

function clip(message: string): string {
    return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}
