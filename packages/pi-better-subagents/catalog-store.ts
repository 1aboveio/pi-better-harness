/**
 * Filesystem catalog: project, personal, and bundled sources.
 *
 * Discovery is deterministic and reads the disk on every call. There is no
 * launch cache. Callers that launch a batch must retain the returned snapshot
 * and reuse that object for every job.
 *
 * Project files are read only when `projectTrusted` is true. Pass Pi's
 * `ctx.isProjectTrusted()` and `CONFIG_DIR_NAME` from the host; this module
 * does not import Pi. Writes default to the personal root. Project scope is
 * explicit and refused when the project is untrusted. Bundled files are immutable.
 */
import { createHash, randomBytes } from "node:crypto";
import {
    closeSync,
    existsSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
    CATALOG_SCHEMA_VERSION,
    DiagnosticCodes,
    kindForId,
    parseDefinition,
    serializeDefinition,
    type CatalogDefinition,
    type CatalogKind,
    type CatalogScope,
    type Diagnostic,
    type ParseResult,
} from "./catalog-schema.ts";

export type { CatalogScope, CatalogKind, CatalogDefinition, Diagnostic, ParseResult };

export const DEFAULT_PROJECT_CONFIG_DIR_NAME = ".pi";
export const SOURCE_PRECEDENCE = ["project", "user", "bundled"] as const;

export interface LoadCatalogInput {
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
}

export interface SaveResult {
    /** True when the file was written. Blocking diagnostics can still make that file unlaunchable. */
    ok: boolean;
    path?: string;
    scope?: "user" | "project";
    diagnostics: Diagnostic[];
}

interface Occurrence {
    scope: CatalogScope;
    path: string;
    contentDigest: string;
    directoryKind: CatalogKind;
    parse: ParseResult;
}

class FrozenMap<K, V> extends Map<K, V> {
    static fill<K, V>(entries: Iterable<readonly [K, V]>): FrozenMap<K, V> {
        const map = new FrozenMap<K, V>();
        for (const [key, value] of entries) Map.prototype.set.call(map, key, value);
        return map;
    }

    override set(): this {
        throw new TypeError("Catalog snapshot is immutable.");
    }
    override delete(): boolean {
        throw new TypeError("Catalog snapshot is immutable.");
    }
    override clear(): void {
        throw new TypeError("Catalog snapshot is immutable.");
    }
}

export function defaultUserRoot(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
    const configured = env.PI_CODING_AGENT_DIR?.trim();
    return configured ? configured : join(home, ".pi", "agent");
}

export function bundledRolesRoot(moduleUrl: string = import.meta.url): string {
    return join(dirname(fileURLToPath(moduleUrl)), "roles");
}

export function projectCatalogPaths(cwd: string, projectConfigDirName: string = DEFAULT_PROJECT_CONFIG_DIR_NAME): {
    root: string;
    roles: string;
    agents: string;
} {
    const root = join(cwd, projectConfigDirName, "agents");
    return { root, roles: join(root, "roles"), agents: join(root, "agents") };
}

export function userCatalogPaths(userRoot: string): { root: string; roles: string; agents: string } {
    const root = join(userRoot, "agents");
    return { root, roles: join(root, "roles"), agents: join(root, "agents") };
}

export function contentDigest(raw: string): string {
    return createHash("sha256").update(raw).digest("hex");
}

/** Read every source again. Identical bytes produce the same digest and a new object. */
export function loadCatalog(input: LoadCatalogInput): CatalogSnapshot {
    const loadedAt = new Date().toISOString();
    const diagnostics: Diagnostic[] = [];
    const configDirName = input.projectConfigDirName ?? DEFAULT_PROJECT_CONFIG_DIR_NAME;
    if (!isSafeConfigDirName(configDirName)) {
        diagnostics.push(diagnostic(DiagnosticCodes.unsafeConfigDir, `Project config directory ${JSON.stringify(configDirName)} is not a single safe path segment.`, {
            blocking: true,
            structural: true,
        }));
        return finishSnapshot([], [], diagnostics, loadedAt);
    }

    const groups = new Map<CatalogScope, Map<string, Occurrence[]>>();
    for (const scope of SOURCE_PRECEDENCE) groups.set(scope, new Map());

    if (input.projectTrusted) {
        const project = projectCatalogPaths(input.cwd, configDirName);
        collectDirectory(project.roles, "project", "role", groups.get("project")!, diagnostics);
        collectDirectory(project.agents, "project", "agent", groups.get("project")!, diagnostics);
    } else {
        const project = projectCatalogPaths(input.cwd, configDirName);
        if (pathExists(project.roles) || pathExists(project.agents) || pathExists(project.root)) {
            diagnostics.push(diagnostic(
                DiagnosticCodes.projectCatalogSuppressed,
                `Project catalog at ${project.root} was not loaded because the project is not trusted. Personal and bundled definitions remain available. Trust the project or copy a definition into the personal catalog.`,
                { scope: "project", path: project.root, blocking: false, structural: false, severity: "info" },
            ));
        }
    }

    const user = userCatalogPaths(input.userRoot);
    collectDirectory(user.roles, "user", "role", groups.get("user")!, diagnostics);
    collectDirectory(user.agents, "user", "agent", groups.get("user")!, diagnostics);

    const bundledRoles = input.bundledRoot ?? bundledRolesRoot();
    if (!existsSync(bundledRoles)) {
        diagnostics.push(diagnostic(DiagnosticCodes.bundledMissing, `Bundled role directory ${bundledRoles} is missing.`, {
            scope: "bundled",
            path: bundledRoles,
            blocking: false,
            structural: false,
            severity: "warning",
        }));
    } else {
        collectDirectory(bundledRoles, "bundled", "role", groups.get("bundled")!, diagnostics);
    }
    if (input.bundledAgentsRoot) {
        collectDirectory(input.bundledAgentsRoot, "bundled", "agent", groups.get("bundled")!, diagnostics);
    }

    const { entries, blocked } = selectIdentities(groups, diagnostics);
    return finishSnapshot(entries, blocked, diagnostics, loadedAt);
}

export function refreshCatalog(input: LoadCatalogInput): CatalogSnapshot {
    return loadCatalog(input);
}

export function createDefinition(input: SaveDefinitionInput): SaveResult {
    return saveDefinition({ ...input, replace: input.replace ?? false });
}

export function saveDefinition(input: SaveDefinitionInput): SaveResult {
    const scope = input.scope ?? "user";
    const diagnostics: Diagnostic[] = [];
    if (scope === "project" && !input.projectTrusted) {
        diagnostics.push(diagnostic(
            DiagnosticCodes.untrustedWrite,
            "Refusing to write a project catalog in an untrusted project. Save to the personal catalog or trust the project and pass scope: \"project\" explicitly.",
            { scope: "project", blocking: true, structural: true },
        ));
        return { ok: false, diagnostics };
    }
    const configDirName = input.projectConfigDirName ?? DEFAULT_PROJECT_CONFIG_DIR_NAME;
    if (!isSafeConfigDirName(configDirName)) {
        diagnostics.push(diagnostic(DiagnosticCodes.unsafeConfigDir, `Project config directory ${JSON.stringify(configDirName)} is not a single safe path segment.`, {
            blocking: true,
            structural: true,
        }));
        return { ok: false, diagnostics };
    }

    const serialized = serializeDefinition(input.definition);
    diagnostics.push(...serialized.diagnostics.map((item) => ({ ...item, scope })));
    if (!serialized.ok || !serialized.markdown) return { ok: false, diagnostics };

    const root = scope === "project"
        ? projectCatalogPaths(input.cwd, configDirName).root
        : userCatalogPaths(input.userRoot).root;
    const directory = join(root, input.definition.kind === "role" ? "roles" : "agents");
    const canonicalPath = join(directory, `${input.definition.id}.md`);
    try {
        mkdirWithin(root, directory);
        const existing = findExisting(directory, input.definition.id);
        if (!existing.ok) return { ok: false, diagnostics: [...diagnostics, ...existing.diagnostics] };
        if (existing.paths.length > 1) {
            diagnostics.push(diagnostic(
                DiagnosticCodes.duplicateId,
                `Id ${input.definition.id} already appears in ${existing.paths.length} ${scope} files (${existing.paths.join(", ")}). No file was written. Keep one file for this id.`,
                { scope, id: input.definition.id, blocking: true, structural: true },
            ));
            return { ok: false, diagnostics };
        }
        const target = existing.paths[0] ?? canonicalPath;
        if (existing.paths.length === 1 && !input.replace) {
            diagnostics.push(diagnostic(
                DiagnosticCodes.definitionExists,
                `Id ${input.definition.id} already exists at ${target}. Nothing was overwritten. Pass replace: true to update that file in place.`,
                { scope, path: target, id: input.definition.id, blocking: true, structural: true },
            ));
            return { ok: false, diagnostics };
        }
        if (existing.paths.length === 0 && existsSync(canonicalPath)) {
            diagnostics.push(diagnostic(
                DiagnosticCodes.definitionExists,
                `${canonicalPath} exists and does not already hold id ${input.definition.id}. Refusing to overwrite it.`,
                { scope, path: canonicalPath, id: input.definition.id, blocking: true, structural: true },
            ));
            return { ok: false, diagnostics };
        }
        writeAtomic(target, serialized.markdown, root);
        return { ok: true, path: target, scope, diagnostics };
    } catch (error) {
        diagnostics.push(diagnostic(DiagnosticCodes.ioError, error instanceof Error ? error.message : String(error), {
            scope,
            blocking: true,
            structural: true,
        }));
        return { ok: false, diagnostics };
    }
}

export function isSafeConfigDirName(name: string): boolean {
    return /^\.[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
}

function collectDirectory(
    directory: string,
    scope: CatalogScope,
    directoryKind: CatalogKind,
    into: Map<string, Occurrence[]>,
    diagnostics: Diagnostic[],
): void {
    let stats;
    try {
        stats = lstatSync(directory);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        diagnostics.push(diagnostic(DiagnosticCodes.ioError, `Could not read ${directory}: ${(error as Error).message}`, {
            scope,
            path: directory,
            blocking: false,
            structural: false,
        }));
        return;
    }
    if (stats.isSymbolicLink()) {
        diagnostics.push(diagnostic(
            DiagnosticCodes.symlinkIgnored,
            `Ignoring symlinked catalog directory ${directory}. Discovery does not follow links outside the scope.`,
            { scope, path: directory, blocking: false, structural: false, severity: "warning" },
        ));
        return;
    }
    if (!stats.isDirectory()) {
        diagnostics.push(diagnostic(DiagnosticCodes.ioError, `${directory} is not a directory and was skipped.`, {
            scope,
            path: directory,
            blocking: false,
            structural: false,
            severity: "warning",
        }));
        return;
    }

    let names: string[];
    try {
        names = readdirSync(directory);
    } catch (error) {
        // lstat can succeed and readdir still fail: mode 000, or the directory
        // disappearing between the two calls. Keep the failure on this path.
        diagnostics.push(diagnostic(DiagnosticCodes.ioError, `Could not read ${directory}: ${(error as Error).message}`, {
            scope,
            path: directory,
            blocking: false,
            structural: false,
        }));
        return;
    }
    names.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    for (const name of names) {
        if (name.startsWith(".") || !name.endsWith(".md")) continue;
        const path = join(directory, name);
        let fileStats;
        try {
            fileStats = lstatSync(path);
        } catch (error) {
            diagnostics.push(diagnostic(DiagnosticCodes.ioError, `Could not stat ${path}: ${(error as Error).message}`, {
                scope,
                path,
                blocking: false,
                structural: false,
            }));
            continue;
        }
        if (fileStats.isSymbolicLink()) {
            diagnostics.push(diagnostic(DiagnosticCodes.symlinkIgnored, `Ignoring symlink ${path}. The target was not read.`, {
                scope,
                path,
                blocking: false,
                structural: false,
                severity: "warning",
            }));
            continue;
        }
        if (!fileStats.isFile()) continue;
        let raw: string;
        try {
            raw = readFileSync(path, "utf8");
        } catch (error) {
            diagnostics.push(diagnostic(DiagnosticCodes.ioError, `Could not read ${path}: ${(error as Error).message}`, {
                scope,
                path,
                blocking: false,
                structural: false,
            }));
            continue;
        }
        let parse: ParseResult;
        try {
            parse = parseDefinition(raw, path);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            diagnostics.push(diagnostic(
                DiagnosticCodes.parserLimit,
                `Stopped reading ${path}: ${detail.length > 500 ? `${detail.slice(0, 500)}\u2026` : detail}. This file was isolated so valid catalog entries remain usable.`,
                { scope, path, blocking: false, structural: true },
            ));
            continue;
        }
        const id = parse.definition?.id ?? parse.occupantId;
        if (!id || !kindForId(id)) {
            for (const item of parse.diagnostics) {
                diagnostics.push({ ...item, scope, path: item.path ?? path });
            }
            if (parse.diagnostics.length === 0) {
                diagnostics.push(diagnostic(DiagnosticCodes.malformedFrontmatter, `${path} produced no catalog id and was skipped.`, {
                    scope,
                    path,
                    blocking: false,
                    structural: true,
                    severity: "error",
                }));
            }
            continue;
        }
        const occurrence: Occurrence = {
            scope,
            path,
            contentDigest: contentDigest(raw),
            directoryKind,
            parse,
        };
        const list = into.get(id) ?? [];
        list.push(occurrence);
        into.set(id, list);
    }
}

function selectIdentities(
    groups: Map<CatalogScope, Map<string, Occurrence[]>>,
    diagnostics: Diagnostic[],
): { entries: CatalogEntry[]; blocked: CatalogEntry[] } {
    const ids = new Set<string>();
    for (const scope of SOURCE_PRECEDENCE) {
        for (const id of groups.get(scope)!.keys()) ids.add(id);
    }
    const entries: CatalogEntry[] = [];
    const blocked: CatalogEntry[] = [];
    for (const id of [...ids].sort()) {
        const considered = SOURCE_PRECEDENCE
            .map((scope) => ({ scope, group: groups.get(scope)!.get(id) ?? [] }))
            .filter((item) => item.group.length > 0);
        const [highest, ...lower] = considered;
        if (!highest) continue;
        const unused = lower.flatMap((item) => item.group.map((occurrence) => unusedSource(
            occurrence,
            highest.group.length > 1
                ? "blocked-by-duplicate-higher-priority"
                : highest.group[0]!.parse.ok
                    ? "shadowed-by-whole-definition"
                    : "blocked-by-invalid-higher-priority",
        )));
        if (highest.group.length > 1) {
            const paths = highest.group.map((occurrence) => occurrence.path);
            const duplicateDiagnostic = diagnostic(
                DiagnosticCodes.duplicateId,
                `Duplicate id ${id} in ${highest.scope} scope: ${paths.join(", ")}. No file was selected by filesystem order, and lower-priority sources were not used. Keep a single file for this id.`,
                { scope: highest.scope, id, blocking: true, structural: true },
            );
            diagnostics.push(duplicateDiagnostic);
            blocked.push({
                id,
                kind: kindForId(id)!,
                scope: highest.scope,
                path: paths[0]!,
                paths,
                contentDigest: contentDigest(highest.group.map((occurrence) => occurrence.contentDigest).join("\n")),
                diagnostics: [
                    duplicateDiagnostic,
                    ...highest.group.flatMap((occurrence) => occurrence.parse.diagnostics.map((item) => ({
                        ...item,
                        scope: highest.scope,
                        path: item.path ?? occurrence.path,
                        id,
                    }))),
                ],
                structurallyValid: false,
                schemaLaunchable: false,
                duplicate: true,
                unused,
            });
            continue;
        }
        const winner = highest.group[0]!;
        const winnerDiagnostics: Diagnostic[] = winner.parse.diagnostics.map((item) => ({
            ...item,
            scope: winner.scope,
            path: item.path ?? winner.path,
            id: item.id ?? id,
        }));
        if (winner.parse.ok && winner.parse.definition && winner.directoryKind !== winner.parse.definition.kind) {
            winnerDiagnostics.push(diagnostic(
                DiagnosticCodes.kindDirectoryMismatch,
                `${winner.path} is in the ${winner.directoryKind} directory but declares kind ${winner.parse.definition.kind}. Identity comes from id ${id}, not the directory.`,
                { scope: winner.scope, path: winner.path, id, blocking: false, structural: false, severity: "warning" },
            ));
        }
        if (!winner.parse.ok) {
            winnerDiagnostics.push(diagnostic(
                DiagnosticCodes.invalidShadow,
                `Invalid ${winner.scope} definition at ${winner.path} blocks id ${id}. Lower-priority definitions were not used. Repair or remove this file.`,
                { scope: winner.scope, path: winner.path, id, blocking: true, structural: true },
            ));
            diagnostics.push(winnerDiagnostics.at(-1)!);
        }
        const blocking = winnerDiagnostics.some((item) => item.blocking);
        const entry: CatalogEntry = {
            id,
            kind: kindForId(id)!,
            scope: winner.scope,
            path: winner.path,
            paths: [winner.path],
            contentDigest: winner.contentDigest,
            definition: winner.parse.definition,
            diagnostics: winnerDiagnostics,
            structurallyValid: winner.parse.ok,
            schemaLaunchable: winner.parse.ok && !blocking,
            duplicate: false,
            unused,
        };
        entries.push(entry);
    }
    return { entries, blocked };
}

function unusedSource(occurrence: Occurrence, reason: UnusedSource["reason"]): UnusedSource {
    return {
        scope: occurrence.scope,
        path: occurrence.path,
        contentDigest: occurrence.contentDigest,
        id: occurrence.parse.definition?.id ?? occurrence.parse.occupantId,
        reason,
    };
}

function finishSnapshot(
    entries: CatalogEntry[],
    blocked: CatalogEntry[],
    diagnostics: Diagnostic[],
    loadedAt: string,
): CatalogSnapshot {
    const roleEntries: Array<readonly [string, CatalogEntry]> = [];
    const agentEntries: Array<readonly [string, CatalogEntry]> = [];
    for (const entry of entries) {
        const frozen = deepFreeze(cloneEntry(entry));
        if (frozen.kind === "role") roleEntries.push([frozen.id, frozen]);
        else agentEntries.push([frozen.id, frozen]);
    }
    const roles = FrozenMap.fill(roleEntries);
    const agents = FrozenMap.fill(agentEntries);
    const frozenBlocked = deepFreeze(blocked.map(cloneEntry));
    const frozenDiagnostics = deepFreeze(sortDiagnostics(diagnostics));
    const digest = snapshotDigest({
        schema: CATALOG_SCHEMA_VERSION,
        entries: [...roles.values(), ...agents.values()].map(digestEntry),
        blocked: frozenBlocked.map(digestEntry),
        diagnostics: frozenDiagnostics.map((item) => ({
            severity: item.severity,
            code: item.code,
            id: item.id ?? null,
            path: item.path ?? null,
            message: item.message,
        })),
    });
    const snapshot: CatalogSnapshot = {
        schema: CATALOG_SCHEMA_VERSION,
        digest,
        revision: digest,
        loadedAt,
        roles,
        agents,
        blocked: frozenBlocked,
        diagnostics: frozenDiagnostics,
    };
    return deepFreeze(snapshot);
}

function digestEntry(entry: CatalogEntry): unknown {
    return {
        id: entry.id,
        kind: entry.kind,
        scope: entry.scope,
        paths: [...entry.paths],
        contentDigest: entry.contentDigest,
        structurallyValid: entry.structurallyValid,
        schemaLaunchable: entry.schemaLaunchable,
        duplicate: entry.duplicate,
        unused: entry.unused.map((item) => ({
            scope: item.scope,
            path: item.path,
            contentDigest: item.contentDigest,
            reason: item.reason,
        })),
    };
}

function snapshotDigest(payload: unknown): string {
    return createHash("sha256").update(JSON.stringify(stableJson(payload))).digest("hex");
}

function stableJson(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stableJson);
    if (value && typeof value === "object") {
        const output: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
            const item = (value as Record<string, unknown>)[key];
            if (item !== undefined) output[key] = stableJson(item);
        }
        return output;
    }
    return value;
}

function cloneEntry(entry: CatalogEntry): CatalogEntry {
    return {
        ...entry,
        paths: [...entry.paths],
        diagnostics: entry.diagnostics.map((item) => ({ ...item })),
        unused: entry.unused.map((item) => ({ ...item })),
        definition: entry.definition ? structuredClone(entry.definition) : undefined,
    };
}

function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
    return diagnostics
        .map((item) => ({ ...item }))
        .sort((left, right) => `${left.code}\0${left.path ?? ""}\0${left.message}`.localeCompare(`${right.code}\0${right.path ?? ""}\0${right.message}`));
}

function findExisting(directory: string, id: string): { ok: true; paths: string[] } | { ok: false; diagnostics: Diagnostic[] } {
    if (!existsSync(directory)) return { ok: true, paths: [] };
    let stats;
    try {
        stats = lstatSync(directory);
    } catch (error) {
        return { ok: false, diagnostics: [diagnostic(DiagnosticCodes.ioError, (error as Error).message, { path: directory, blocking: true, structural: true })] };
    }
    if (stats.isSymbolicLink()) {
        return {
            ok: false,
            diagnostics: [diagnostic(DiagnosticCodes.symlinkIgnored, `Refusing to write through symlinked directory ${directory}.`, {
                path: directory,
                blocking: true,
                structural: true,
            })],
        };
    }
    const paths: string[] = [];
    for (const name of readdirSync(directory)) {
        if (name.startsWith(".") || !name.endsWith(".md")) continue;
        const path = join(directory, name);
        const fileStats = lstatSync(path);
        if (fileStats.isSymbolicLink() || !fileStats.isFile()) continue;
        const parsed = parseDefinition(readFileSync(path, "utf8"), path);
        const found = parsed.definition?.id ?? parsed.occupantId;
        if (found === id) paths.push(path);
    }
    paths.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    return { ok: true, paths };
}

function mkdirWithin(root: string, directory: string): void {
    mkdirSync(directory, { recursive: true });
    assertInside(root, directory);
    assertNoSymlinkWalk(root, directory);
}

function writeAtomic(target: string, content: string, root: string): void {
    const directory = dirname(target);
    assertInside(root, directory);
    assertNoSymlinkWalk(root, directory);
    if (existsSync(target)) {
        const stats = lstatSync(target);
        if (stats.isSymbolicLink()) {
            throw new Error(`Refusing to replace symlink ${target}.`);
        }
    }
    const temporary = join(directory, `.${basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    const fd = openSync(temporary, "w", 0o600);
    try {
        writeSync(fd, content);
        fsyncSync(fd);
    } catch (error) {
        closeSync(fd);
        rmSync(temporary, { force: true });
        throw error;
    }
    closeSync(fd);
    try {
        renameSync(temporary, target);
    } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
    }
    assertInside(root, target);
}

function containedRoot(root: string): string {
    return existsSync(root) ? realpathSync(root) : resolve(root);
}

function assertInside(root: string, target: string): void {
    const resolvedRoot = containedRoot(root);
    const resolvedTarget = existsSync(target) ? realpathSync(target) : resolve(target);
    const rel = relative(resolvedRoot, resolvedTarget);
    if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(`Path ${target} escapes catalog root ${root}.`);
    }
}

function assertNoSymlinkWalk(root: string, target: string): void {
    const lexicalRoot = resolve(root);
    const rel = relative(lexicalRoot, resolve(target));
    if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(`Path ${target} escapes catalog root ${root}.`);
    }
    let current = lexicalRoot;
    for (const part of rel.split(sep).filter(Boolean)) {
        current = join(current, part);
        const stats = lstatSync(current);
        if (stats.isSymbolicLink()) {
            throw new Error(`Refusing to follow symlink at ${current}.`);
        }
    }
}

function pathExists(path: string): boolean {
    try {
        lstatSync(path);
        return true;
    } catch {
        return false;
    }
}

function deepFreeze<T>(value: T): T {
    if (!value || typeof value !== "object") return value;
    if (value instanceof Map) {
        for (const child of value.values()) deepFreeze(child);
        Object.freeze(value);
        return value;
    }
    if (Object.isFrozen(value)) return value;
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
    return value;
}

function diagnostic(
    code: Diagnostic["code"],
    message: string,
    fields: {
        scope?: CatalogScope;
        path?: string;
        id?: string;
        blocking: boolean;
        structural: boolean;
        severity?: Diagnostic["severity"];
    },
): Diagnostic {
    return {
        severity: fields.severity ?? (fields.blocking ? "error" : "warning"),
        code,
        message,
        scope: fields.scope,
        path: fields.path,
        id: fields.id,
        blocking: fields.blocking,
        structural: fields.structural,
    };
}

