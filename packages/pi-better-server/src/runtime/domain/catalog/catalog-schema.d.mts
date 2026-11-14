import { type ThinkingLevel } from "./thinking.mjs";
export type { ThinkingLevel };
export declare const CATALOG_SCHEMA_VERSION: "pi-agent/v1";
export type CatalogSchemaVersion = typeof CATALOG_SCHEMA_VERSION;
export type CatalogKind = "role" | "agent";
export type InstructionMode = "add" | "replace";
export type CatalogScope = "project" | "user" | "bundled";
export type PreferenceKey = "model" | "effort" | "tier";
export type DiagnosticSeverity = "error" | "warning" | "info";
export declare const PREFERENCE_KEYS: ["model", "effort", "tier"];
/**
 * Every key `defaults` (roles) and `overrides` (agents) may carry. `skills` is
 * added here but is not a `PreferenceKey`: model resolution consumes preferences,
 * while skill exposure is reproduced by the launcher from the definition.
 */
export declare const DEFINITION_PREFERENCE_KEYS: readonly ["model", "effort", "tier", "skills"];
/** Closed set of thinking levels shared with the existing subagent parser. */
export declare const EFFORT_LEVELS: any;
/**
 * Top-level keys that describe host execution. The catalog preserves them and
 * blocks launch; it never treats them as enforced permissions or tool presets.
 */
export declare const HOST_EXECUTION_CONTROL_KEYS: readonly ["sandbox", "sandbox_mode", "sandboxMode", "tools", "tool", "toolPreset", "toolsPreset", "permissions", "permission", "mcp", "mcpServers", "extensions", "network", "filesystem", "cwd", "workspace", "allow_nested", "nested", "env", "environment"];
export declare const PARSER_LIMITS: {
    readonly maxFileBytes: number;
    readonly maxFrontmatterBytes: number;
    readonly maxBodyBytes: number;
    readonly maxAliasCount: 50;
    readonly maxNodes: 2000;
    readonly maxDepth: 32;
    readonly maxIdLength: 128;
    readonly maxNameLength: 120;
    readonly maxDescriptionLength: 2000;
    readonly maxStringLength: number;
};
/**
 * Approved bundled-role defaults from DEV-23. Short model names in the product
 * table are OpenAI model ids; stored values use the provider/model form the
 * runtime already uses. Tiers are catalog policy, not benchmark rankings.
 */
export declare const APPROVED_ROLE_DEFAULTS: readonly [{
    readonly id: "role.researcher";
    readonly name: "Researcher";
    readonly model: "openai/gpt-6.1-terra";
    readonly effort: "medium";
    readonly tier: "balanced";
}, {
    readonly id: "role.explorer";
    readonly name: "Explorer";
    readonly model: "openai/gpt-6-luna";
    readonly effort: "medium";
    readonly tier: "efficient";
}, {
    readonly id: "role.product-manager";
    readonly name: "Product Manager";
    readonly model: "openai/gpt-6.1-sol";
    readonly effort: "medium";
    readonly tier: "balanced";
}, {
    readonly id: "role.developer";
    readonly name: "Developer";
    readonly model: "openai/gpt-6.1-sol";
    readonly effort: "high";
    readonly tier: "balanced";
}, {
    readonly id: "role.reviewer";
    readonly name: "Reviewer";
    readonly model: "openai/gpt-6-astra";
    readonly effort: "medium";
    readonly tier: "frontier";
}, {
    readonly id: "role.architect";
    readonly name: "Architect";
    readonly model: "openai/gpt-6-astra";
    readonly effort: "high";
    readonly tier: "frontier";
}, {
    readonly id: "role.writer";
    readonly name: "Writer";
    readonly model: "openai/gpt-6.1-terra";
    readonly effort: "medium";
    readonly tier: undefined;
}];
export declare const DiagnosticCodes: {
    readonly malformedFrontmatter: "malformed-frontmatter";
    readonly parserLimit: "parser-limit";
    readonly duplicateKey: "duplicate-key";
    readonly invalidSchema: "invalid-schema";
    readonly invalidKind: "invalid-kind";
    readonly invalidId: "invalid-id";
    readonly duplicateId: "duplicate-id";
    readonly invalidField: "invalid-field";
    readonly invalidInstructionMode: "invalid-instruction-mode";
    readonly emptyReplacement: "empty-replacement";
    readonly multipleBaseRoles: "multiple-base-roles";
    readonly missingRole: "missing-role";
    readonly unusableRole: "unusable-role";
    readonly unknownAgent: "unknown-agent";
    readonly unknownRole: "unknown-role";
    readonly ambiguousSelector: "ambiguous-selector";
    readonly missingSelector: "missing-selector";
    readonly invalidShadow: "invalid-shadow";
    readonly unsupportedExecutionRestriction: "unsupported-execution-restriction";
    readonly projectCatalogSuppressed: "project-catalog-suppressed";
    readonly symlinkIgnored: "symlink-ignored";
    readonly credentialMaterial: "credential-material";
    readonly cosmeticMetadata: "cosmetic-metadata";
    readonly untrustedWrite: "untrusted-write";
    readonly immutableScope: "immutable-scope";
    readonly definitionExists: "definition-exists";
    readonly pathEscape: "path-escape";
    readonly notLaunchable: "not-launchable";
    readonly kindDirectoryMismatch: "kind-directory-mismatch";
    readonly bundledMissing: "bundled-missing";
    readonly ioError: "io-error";
    readonly unsafeConfigDir: "unsafe-config-dir";
};
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
/**
 * Model, effort, tier, and skill exposure. Absence inherits; null is an explicit value.
 *
 * `skills` is the one launch value here that changes what the child can see
 * rather than how the model is chosen. It stays a definition-owned preference
 * because the launcher reproduces it exactly (`--no-skills` plus `--skill`), the
 * same way it reproduces model and effort, and because it grants nothing: a
 * skill list narrows prompt exposure and cannot add a tool or a permission.
 */
export interface PortablePreferences {
    model?: string | null;
    effort?: ThinkingLevel | null;
    tier?: string | null;
    skills?: string[] | null;
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
export declare function formatDiagnostic(diagnostic: Diagnostic): string;
export declare function hasBlockingDiagnostic(diagnostics: readonly Diagnostic[]): boolean;
export declare function kindForId(id: string): CatalogKind | undefined;
/** Prefix every role id carries. Stored ids and files keep it; people type and read the short name. */
export declare const ROLE_ID_PREFIX = "role.";
/** Short, user-facing role name: `role.developer` becomes `developer`. Any other id is returned unchanged. */
export declare function shortRoleName(id: string): string;
/**
 * Canonical role id for a value typed into a `role` field. Trimmed and
 * lowercased; a bare name gains the `role.` prefix, so `Developer` becomes
 * `role.developer`. The result always starts with `role.`, so a role field
 * can never select an `agent.*` named agent.
 */
export declare function canonicalRoleId(value: string): string;
/** Canonical named-agent id: trimmed and lowercased, since ids are lowercase-only. */
export declare function canonicalAgentId(value: string): string;
/**
 * Canonical id for a field that takes either kind, such as `agents_catalog`
 * inspect. An `agent.` id (any case) is lowercased; anything else is read as a role.
 */
export declare function canonicalCatalogId(value: string): string;
export declare function isPreferenceKey(value: string): value is PreferenceKey;
/** Explicit override. Null is stored; it does not mean "inherit". */
export declare function setAgentOverride(agent: AgentDefinition, key: "model", value: string | null): AgentDefinition;
export declare function setAgentOverride(agent: AgentDefinition, key: "effort", value: ThinkingLevel | null): AgentDefinition;
export declare function setAgentOverride(agent: AgentDefinition, key: "tier", value: string | null): AgentDefinition;
/** Delete one override key so the next resolution inherits that field again. */
export declare function removeAgentOverride(agent: AgentDefinition, key: PreferenceKey): AgentDefinition;
export declare function updateAgentOverrides(agent: AgentDefinition, patch: {
    set?: Partial<PortablePreferences>;
    remove?: readonly (PreferenceKey | "skills")[];
}): AgentDefinition;
/**
 * One `/agents` skill edit. `inherit` removes the definition's own key,
 * `none` writes `[]`, and `explicit` writes the absolute paths.
 *
 * `explicit` with no paths is rejected on purpose: an empty selected list must
 * not become `[]` (which means "none") or absence (which means discovery).
 */
export type SkillExposureEdit = {
    mode: "inherit";
} | {
    mode: "none";
} | {
    mode: "explicit";
    paths: readonly string[];
};
/** The definition's own skill value: undefined inherits, null suppresses, `[]` is none. */
export declare function definitionSkillPreference(definition: CatalogDefinition): string[] | null | undefined;
/** Absolute definition paths, with the empty selection rejected rather than stored as "none". */
export declare function definitionSkillPaths(paths: readonly string[]): string[];
/** Apply one edit without flattening inherited values or touching other fields. */
export declare function applySkillExposure<T extends CatalogDefinition>(definition: T, edit: SkillExposureEdit): T;
export declare function parseDefinition(markdown: string, sourcePath?: string): ParseResult;
export declare function validateDefinition(definition: CatalogDefinition): ParseResult;
export declare function serializeDefinition(definition: CatalogDefinition): SerializeResult;
