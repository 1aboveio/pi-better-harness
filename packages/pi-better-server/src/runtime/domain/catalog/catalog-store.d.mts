import type { AgentSessionOverrides } from "./agent-session-settings.mjs";
import { CATALOG_SCHEMA_VERSION, type CatalogDefinition, type AgentDefinition, type CatalogKind, type CatalogScope, type Diagnostic, type ParseResult } from "./catalog-schema.mjs";
export type { CatalogScope, CatalogKind, CatalogDefinition, Diagnostic, ParseResult };
export declare const DEFAULT_PROJECT_CONFIG_DIR_NAME = ".pi";
export declare const SOURCE_PRECEDENCE: readonly ["project", "user", "bundled"];
export interface LoadCatalogInput {
    /** Server-owned, bounded source reuse. Admission and discovery still run first. */
    sources?: {
        read(path: string): string;
        parse(raw: string, path: string): ParseResult;
    };
    cwd: string;
    /** Host trust decision. Untrusted projects do not contribute definitions. */
    projectTrusted: boolean;
    /** Personal root, usually `PI_CODING_AGENT_DIR` or `~/.pi/agent`. Required so tests never scan the real home by accident. */
    userRoot: string;
    /** Directory of bundled role markdown. Defaults to this package's `roles` directory. */
    bundledRoot?: string;
    /** Optional bundled named-agent directory. The package does not ship agents. */
    bundledAgentsRoot?: string;
    /** Single path segment. Pi hosts should pass `CONFIG_DIR_NAME` (default `.pi`). */
    projectConfigDirName?: string;
}
export interface SaveDefinitionInput {
    definition: CatalogDefinition;
    /** Defaults to personal storage. `"project"` must be explicit. */
    scope?: "user" | "project";
    cwd: string;
    projectTrusted: boolean;
    userRoot: string;
    projectConfigDirName?: string;
    /** When false, an existing id in that scope is left untouched. */
    replace?: boolean;
}
export interface UnusedSource {
    scope: CatalogScope;
    path: string;
    contentDigest: string;
    id?: string;
    reason: "shadowed-by-whole-definition" | "blocked-by-invalid-higher-priority" | "blocked-by-duplicate-higher-priority";
}
export interface CatalogEntry {
    id: string;
    kind: CatalogKind;
    scope: CatalogScope;
    /** Representative path. Duplicate entries also list every competing path. */
    path: string;
    paths: readonly string[];
    contentDigest: string;
    definition?: CatalogDefinition;
    diagnostics: readonly Diagnostic[];
    structurallyValid: boolean;
    /** Trustworthy definition with no blocking diagnostic. Role existence is checked by the resolver. */
    schemaLaunchable: boolean;
    duplicate: boolean;
    unused: readonly UnusedSource[];
}
export interface CatalogSnapshot {
    schema: typeof CATALOG_SCHEMA_VERSION;
    /** Hex sha256 of the canonical snapshot. Excludes `loadedAt`. */
    digest: string;
    revision: string;
    loadedAt: string;
    roles: ReadonlyMap<string, CatalogEntry>;
    agents: ReadonlyMap<string, CatalogEntry>;
    /** Same-scope duplicates. They occupy the id without selecting a filesystem-order winner. */
    blocked: readonly CatalogEntry[];
    diagnostics: readonly Diagnostic[];
    /** Immutable, branch-local preferences; never written by loadCatalog. */
    sessionSettings?: AgentSessionOverrides;
    savedSettings?: AgentSessionOverrides;
    preferenceSources?: Readonly<Record<string, Readonly<Partial<Record<"model" | "effort", {
        scope: "user" | "project";
        path: string;
        bundled?: boolean;
    }>>>>>;
}
export interface SaveResult {
    /** True when the file was written. Blocking diagnostics can still make that file unlaunchable. */
    ok: boolean;
    path?: string;
    scope?: "user" | "project";
    diagnostics: Diagnostic[];
}
/** Rebuild the same immutable domain value after a JSON socket round trip. */
export declare function catalogSnapshotFromWire(wire: Omit<CatalogSnapshot, "roles" | "agents"> & {
    roles: Iterable<readonly [string, CatalogEntry]>;
    agents: Iterable<readonly [string, CatalogEntry]>;
}): CatalogSnapshot;
export declare function defaultUserRoot(env?: NodeJS.ProcessEnv, home?: string): string;
export declare function bundledRolesRoot(moduleUrl?: string): string;
export declare function projectCatalogPaths(cwd: string, projectConfigDirName?: string): {
    root: string;
    roles: string;
    agents: string;
};
export declare function userCatalogPaths(userRoot: string): {
    root: string;
    roles: string;
    agents: string;
};
export declare function contentDigest(raw: string): string;
/** Import matching needs every source in the destination scope, including shadowed IDs. */
export declare function listScopedAgents(input: LoadCatalogInput, scope: "user" | "project"): {
    agents: {
        path: string;
        definition: AgentDefinition;
    }[];
    diagnostics: Diagnostic[];
};
/** Discover authorized sources. Identical bytes produce the same content digest. */
export declare function loadCatalog(input: LoadCatalogInput): CatalogSnapshot;
export declare function refreshCatalog(input: LoadCatalogInput): CatalogSnapshot;
export declare function createDefinition(input: SaveDefinitionInput): SaveResult;
type ResetDefinitionInput = LoadCatalogInput & {
    id: string;
    expectedPath: string;
    expectedDigest: string;
};
/** Archive one displayed user override, preserving its model and effort preferences. */
export declare function resetUserDefinition(input: ResetDefinitionInput): SaveResult & {
    backupPath?: string;
};
/** Restore bundled defaults, archiving a user definition and clearing only this id's user preferences. */
export declare function resetToBundled(input: ResetDefinitionInput): SaveResult & {
    backupPath?: string;
};
/** Restore bundled model and effort while keeping every Markdown definition intact. */
export declare function resetRuntimeToBundled(input: ResetDefinitionInput): SaveResult;
export declare function saveDefinition(input: SaveDefinitionInput): SaveResult;
export declare function isSafeConfigDirName(name: string): boolean;
