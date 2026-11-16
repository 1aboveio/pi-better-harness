// Generated from packages/pi-better-subagents/catalog-store.ts. Do not edit directly.
/**
 * Filesystem catalog: project, personal, and bundled sources.
 *
 * Discovery is deterministic. Direct callers read disk on every call; the server
 * can supply bounded source reuse after admission. Callers launching a batch retain the snapshot
 * and reuse that object for every job.
 *
 * Project files are read only when `projectTrusted` is true. Pass Pi's
 * `ctx.isProjectTrusted()` and `CONFIG_DIR_NAME` from the host; this module
 * does not import Pi. Writes default to the personal root. Project scope is
 * explicit and refused when the project is untrusted. Bundled files are immutable.
 */
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeSync, } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { readCatalogPreferences, writeCatalogPreferences } from "./catalog-preferences.mjs";
import { CATALOG_SCHEMA_VERSION, DiagnosticCodes, kindForId, parseDefinition, serializeDefinition, } from "./catalog-schema.mjs";
export const DEFAULT_PROJECT_CONFIG_DIR_NAME = ".pi";
export const SOURCE_PRECEDENCE = ["project", "user", "bundled"];
class FrozenMap extends Map {
    static fill(entries) {
        const map = new FrozenMap();
        for (const [key, value] of entries)
            Map.prototype.set.call(map, key, value);
        return map;
    }
    set() {
        throw new TypeError("Catalog snapshot is immutable.");
    }
    delete() {
        throw new TypeError("Catalog snapshot is immutable.");
    }
    clear() {
        throw new TypeError("Catalog snapshot is immutable.");
    }
}
/** Rebuild the same immutable domain value after a JSON socket round trip. */
export function catalogSnapshotFromWire(wire) {
    return deepFreeze({ ...wire, roles: FrozenMap.fill(wire.roles), agents: FrozenMap.fill(wire.agents) });
}
export function defaultUserRoot(env = process.env, home = homedir()) {
    const configured = env.PI_CODING_AGENT_DIR?.trim();
    return configured ? configured : join(home, ".pi", "agent");
}
export function bundledRolesRoot(moduleUrl = import.meta.url) {
    return join(dirname(fileURLToPath(moduleUrl)), "roles");
}
export function projectCatalogPaths(cwd, projectConfigDirName = DEFAULT_PROJECT_CONFIG_DIR_NAME) {
    const root = join(cwd, projectConfigDirName, "agents");
    return { root, roles: join(root, "roles"), agents: join(root, "agents") };
}
export function userCatalogPaths(userRoot) {
    const root = join(userRoot, "agents");
    return { root, roles: join(root, "roles"), agents: join(root, "agents") };
}
export function contentDigest(raw) {
    return createHash("sha256").update(raw).digest("hex");
}
/** Import matching needs every source in the destination scope, including shadowed IDs. */
export function listScopedAgents(input, scope) {
    const diagnostics = [];
    if (scope === "project" && !input.projectTrusted)
        throw new Error("Project catalog access requires a trusted host.");
    const config = input.projectConfigDirName ?? DEFAULT_PROJECT_CONFIG_DIR_NAME;
    if (!isSafeConfigDirName(config))
        throw new Error("Unsafe project config directory");
    const directory = scope === "project" ? projectCatalogPaths(input.cwd, config).agents : userCatalogPaths(input.userRoot).agents;
    const occurrences = new Map();
    collectDirectory(directory, scope, "agent", occurrences, diagnostics, input.sources);
    const agents = [...occurrences.values()].flat().flatMap(item => item.parse.definition?.kind === "agent"
        ? [{ path: item.path, definition: item.parse.definition }] : []);
    return { agents, diagnostics };
}
/** Discover authorized sources. Identical bytes produce the same content digest. */
export function loadCatalog(input) {
    const loadedAt = new Date().toISOString();
    const diagnostics = [];
    const configDirName = input.projectConfigDirName ?? DEFAULT_PROJECT_CONFIG_DIR_NAME;
    if (!isSafeConfigDirName(configDirName)) {
        diagnostics.push(diagnostic(DiagnosticCodes.unsafeConfigDir, `Project config directory ${JSON.stringify(configDirName)} is not a single safe path segment.`, {
            blocking: true,
            structural: true,
        }));
        return finishSnapshot([], [], diagnostics, loadedAt);
    }
    const groups = new Map();
    for (const scope of SOURCE_PRECEDENCE)
        groups.set(scope, new Map());
    if (input.projectTrusted) {
        const project = projectCatalogPaths(input.cwd, configDirName);
        collectDirectory(project.roles, "project", "role", groups.get("project"), diagnostics, input.sources);
        collectDirectory(project.agents, "project", "agent", groups.get("project"), diagnostics, input.sources);
    }
    else {
        const project = projectCatalogPaths(input.cwd, configDirName);
        if (pathExists(project.roles) || pathExists(project.agents) || pathExists(project.root)) {
            diagnostics.push(diagnostic(DiagnosticCodes.projectCatalogSuppressed, `Project catalog at ${project.root} was not loaded because the project is not trusted. Personal and bundled definitions remain available. Trust the project or copy a definition into the personal catalog.`, { scope: "project", path: project.root, blocking: false, structural: false, severity: "info" }));
        }
    }
    const user = userCatalogPaths(input.userRoot);
    collectDirectory(user.roles, "user", "role", groups.get("user"), diagnostics, input.sources);
    collectDirectory(user.agents, "user", "agent", groups.get("user"), diagnostics, input.sources);
    const bundledRoles = input.bundledRoot ?? bundledRolesRoot();
    if (!existsSync(bundledRoles)) {
        diagnostics.push(diagnostic(DiagnosticCodes.bundledMissing, `Bundled role directory ${bundledRoles} is missing.`, {
            scope: "bundled",
            path: bundledRoles,
            blocking: false,
            structural: false,
            severity: "warning",
        }));
    }
    else {
        collectDirectory(bundledRoles, "bundled", "role", groups.get("bundled"), diagnostics, input.sources);
    }
    if (input.bundledAgentsRoot) {
        collectDirectory(input.bundledAgentsRoot, "bundled", "agent", groups.get("bundled"), diagnostics, input.sources);
    }
    const { entries, blocked } = selectIdentities(groups, diagnostics);
    const savedSettings = {};
    const preferenceSources = {};
    const preferenceDigests = [];
    const scopes = [
        { scope: "user", root: user.root },
        ...(input.projectTrusted ? [{ scope: "project", root: projectCatalogPaths(input.cwd, configDirName).root }] : []),
    ];
    for (const { scope, root } of scopes) {
        try {
            const preferences = readCatalogPreferences(root);
            preferenceDigests.push(preferences.digest);
            for (const entry of entries) {
                if (scope === "user" && entry.scope === "project")
                    continue;
                const own = preferences.settings[entry.id];
                if (!own)
                    continue;
                const resolved = {};
                if (own.bundled) {
                    const fallbacks = entry.scope === "bundled" ? [entry] : entry.unused.filter(source => source.scope === "bundled");
                    const fallback = fallbacks.length === 1 ? fallbacks[0] : undefined;
                    const raw = fallback ? (input.sources?.read(fallback.path) ?? readFileSync(fallback.path, "utf8")) : undefined;
                    const parsed = raw === undefined ? undefined : (input.sources?.parse(raw, fallback.path) ?? parseDefinition(raw, fallback.path));
                    if (!fallback || !parsed?.ok || parsed.definition?.id !== entry.id || parsed.diagnostics.some(item => item.blocking)
                        || contentDigest(raw) !== fallback.contentDigest) {
                        const failure = diagnostic("catalog-preferences", `Cannot inherit bundled runtime defaults for ${entry.id}: a single valid bundled definition is required.`, {
                            scope, path: join(root, "settings.json"), id: entry.id, blocking: true, structural: false,
                        });
                        entry.diagnostics = [...entry.diagnostics, failure];
                        entry.schemaLaunchable = false;
                        diagnostics.push(failure);
                        continue;
                    }
                    const bundled = parsed.definition.kind === "role" ? parsed.definition.defaults : parsed.definition.overrides;
                    resolved.model = bundled.model ?? null;
                    resolved.effort = bundled.effort ?? null;
                }
                for (const key of ["model", "effort"]) {
                    if (Object.hasOwn(own, key))
                        Object.assign(resolved, { [key]: own[key] });
                }
                savedSettings[entry.id] = { ...savedSettings[entry.id], ...resolved };
                const sources = preferenceSources[entry.id] ??= {};
                for (const key of ["model", "effort"]) {
                    if (Object.hasOwn(resolved, key))
                        sources[key] = { scope, path: join(root, "settings.json"), ...(own.bundled && !Object.hasOwn(own, key) ? { bundled: true } : {}) };
                }
            }
        }
        catch (error) {
            const failure = diagnostic("catalog-preferences", error instanceof Error ? error.message : String(error), {
                scope, path: join(root, "settings.json"), blocking: true, structural: false,
            });
            diagnostics.push(failure);
            for (const entry of entries) {
                if (scope === "user" && entry.scope === "project")
                    continue;
                entry.diagnostics = [...entry.diagnostics, failure];
                entry.schemaLaunchable = false;
            }
        }
    }
    const snapshot = finishSnapshot(entries, blocked, diagnostics, loadedAt);
    const digest = contentDigest(JSON.stringify([snapshot.digest, preferenceDigests, savedSettings, preferenceSources]));
    return deepFreeze({ ...snapshot, digest, revision: digest, savedSettings, preferenceSources });
}
export function refreshCatalog(input) {
    return loadCatalog(input);
}
export function createDefinition(input) {
    return saveDefinition({ ...input, replace: input.replace ?? false });
}
/** Archive one displayed user override, preserving its model and effort preferences. */
export function resetUserDefinition(input) {
    return resetDefinition(input, false);
}
/** Restore bundled defaults, archiving a user definition and clearing only this id's user preferences. */
export function resetToBundled(input) {
    return resetDefinition(input, true);
}
/** Restore bundled model and effort while keeping every Markdown definition intact. */
export function resetRuntimeToBundled(input) {
    return resetDefinition(input, true, true);
}
function assertNoProjectPreferences(snapshot, id) {
    if (Object.values(snapshot.preferenceSources?.[id] ?? {}).some(source => source.scope === "project")) {
        throw new Error("Project preferences are active for this id. Reset to bundled cannot clear project preferences. Nothing was archived.");
    }
}
function resetDefinition(input, clearPreferences, runtimeOnly = false) {
    try {
        const snapshot = loadCatalog(input);
        const entry = snapshot.roles.get(input.id) ?? snapshot.agents.get(input.id);
        if (!entry || (entry.scope !== "user" && !(clearPreferences && entry.scope === "bundled")) || entry.duplicate || entry.paths.length !== 1) {
            throw new Error(clearPreferences
                ? "Only a single user or bundled definition can be reset. Project definitions are unchanged."
                : "Only a single user override can be reset. Project and bundled definitions are unchanged.");
        }
        if (clearPreferences)
            assertNoProjectPreferences(snapshot, input.id);
        if (entry.path !== input.expectedPath || entry.contentDigest !== input.expectedDigest) {
            throw new Error("The user definition changed since this screen was opened. Reopen its settings before resetting.");
        }
        const fallbacks = entry.scope === "bundled" ? [entry] : entry.unused.filter(source => source.scope === "bundled");
        if (fallbacks.length !== 1)
            throw new Error("Exactly one bundled definition must be available for this id. Nothing was changed.");
        const fallback = fallbacks[0];
        const bundledRoot = entry.kind === "role" ? input.bundledRoot ?? bundledRolesRoot() : input.bundledAgentsRoot;
        if (!bundledRoot || lstatSync(bundledRoot).isSymbolicLink())
            throw new Error("The bundled catalog is unavailable or symlinked.");
        assertInside(bundledRoot, fallback.path);
        assertNoSymlinkWalk(bundledRoot, fallback.path);
        const bundledRaw = readFileSync(fallback.path, "utf8");
        const bundled = parseDefinition(bundledRaw, fallback.path);
        if (!bundled.ok || bundled.diagnostics.some(item => item.blocking) || bundled.definition?.id !== input.id || contentDigest(bundledRaw) !== fallback.contentDigest) {
            throw new Error("The bundled definition is invalid. Nothing was changed.");
        }
        const root = userCatalogPaths(input.userRoot).root;
        const directory = join(root, entry.kind === "role" ? "roles" : "agents");
        const definitionRoot = entry.scope === "user" ? input.userRoot : bundledRoot;
        if (entry.scope === "user" && resolve(dirname(entry.path)) !== resolve(directory))
            throw new Error("The user definition is outside its catalog directory.");
        assertInside(definitionRoot, entry.path);
        assertNoSymlinkWalk(definitionRoot, entry.path);
        const stats = lstatSync(entry.path);
        const raw = readFileSync(entry.path);
        const text = raw.toString("utf8");
        if (!stats.isFile() || stats.isSymbolicLink() || !Buffer.from(text).equals(raw) || contentDigest(text) !== input.expectedDigest) {
            throw new Error("The user definition changed before reset. Nothing was changed.");
        }
        let previous = {};
        const legacy = entry.definition?.kind === "role" ? entry.definition.defaults : entry.definition?.overrides;
        const bundledPreferences = bundled.definition?.kind === "role" ? bundled.definition.defaults : bundled.definition?.overrides;
        const legacyPreferences = {
            ...(legacy?.model !== undefined ? { model: legacy.model } : bundledPreferences?.model !== undefined ? { model: null } : {}),
            ...(legacy?.effort !== undefined ? { effort: legacy.effort } : bundledPreferences?.effort !== undefined ? { effort: null } : {}),
        };
        // Clearing JSON alone would reveal legacy runtime choices in user Markdown.
        const runtimePreferences = entry.scope === "user" ? { bundled: true } : {};
        const assertBundledUnchanged = () => {
            if (lstatSync(bundledRoot).isSymbolicLink())
                throw new Error("The bundled catalog is unavailable or symlinked.");
            assertInside(bundledRoot, fallback.path);
            assertNoSymlinkWalk(bundledRoot, fallback.path);
            if (readFileSync(fallback.path, "utf8") !== bundledRaw) {
                throw new Error("The bundled fallback changed while saving preferences. Nothing was archived. Reopen its settings.");
            }
        };
        const saved = writeCatalogPreferences(root, input.id, current => {
            if (runtimeOnly)
                assertBundledUnchanged();
            previous = current;
            return runtimeOnly ? runtimePreferences : clearPreferences ? {} : current.bundled ? current : { ...legacyPreferences, ...current };
        });
        // Discovery skips hidden files. Keep the original bytes for manual recovery.
        const backupPath = entry.scope === "user" && !runtimeOnly
            ? join(directory, `.${basename(entry.path)}.${randomBytes(12).toString("hex")}.backup`)
            : undefined;
        try {
            const refreshed = loadCatalog(input);
            const current = refreshed.roles.get(input.id) ?? refreshed.agents.get(input.id);
            if (clearPreferences)
                assertNoProjectPreferences(refreshed, input.id);
            const currentFallbacks = current?.scope === "bundled" ? [current] : current?.unused.filter(source => source.scope === "bundled") ?? [];
            if (current?.scope !== entry.scope || current.duplicate || current.path !== entry.path || current.contentDigest !== input.expectedDigest
                || currentFallbacks.length !== 1 || currentFallbacks[0]?.path !== fallback.path || currentFallbacks[0]?.contentDigest !== fallback.contentDigest) {
                throw new Error("The definition or bundled fallback changed while saving preferences. Nothing was archived. Reopen its settings.");
            }
            assertBundledUnchanged();
            assertNoSymlinkWalk(definitionRoot, entry.path);
            const latest = readFileSync(entry.path);
            if (!latest.equals(raw) || !lstatSync(entry.path).isFile()) {
                throw new Error("The user definition changed while saving preferences. Nothing was archived. Reopen its settings.");
            }
            if (backupPath)
                renameSync(entry.path, backupPath);
        }
        catch (error) {
            // Compare and roll back under the same lock; preserve any later edit.
            try {
                writeCatalogPreferences(root, input.id, current => JSON.stringify(current) === JSON.stringify(saved.settings[input.id] ?? {}) ? previous : current);
            }
            catch (rollback) {
                throw new Error(`${error instanceof Error ? error.message : String(error)} Preference rollback also failed: ${rollback instanceof Error ? rollback.message : String(rollback)}`);
            }
            throw error;
        }
        return { ok: true, path: backupPath ? entry.path : saved.path, backupPath, scope: "user", diagnostics: [] };
    }
    catch (error) {
        return { ok: false, diagnostics: [diagnostic("agents-reset", error instanceof Error ? error.message : String(error), {
                    scope: "user", id: input.id, blocking: true, structural: false,
                })] };
    }
}
export function saveDefinition(input) {
    const scope = input.scope ?? "user";
    const diagnostics = [];
    if (scope === "project" && !input.projectTrusted) {
        diagnostics.push(diagnostic(DiagnosticCodes.untrustedWrite, "Refusing to write a project catalog in an untrusted project. Save to the personal catalog or trust the project and pass scope: \"project\" explicitly.", { scope: "project", blocking: true, structural: true }));
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
    if (!serialized.ok || !serialized.markdown)
        return { ok: false, diagnostics };
    const root = scope === "project"
        ? projectCatalogPaths(input.cwd, configDirName).root
        : userCatalogPaths(input.userRoot).root;
    const directory = join(root, input.definition.kind === "role" ? "roles" : "agents");
    const canonicalPath = join(directory, `${input.definition.id}.md`);
    try {
        mkdirWithin(root, directory);
        const existing = findExisting(directory, input.definition.id);
        if (!existing.ok)
            return { ok: false, diagnostics: [...diagnostics, ...existing.diagnostics] };
        if (existing.paths.length > 1) {
            diagnostics.push(diagnostic(DiagnosticCodes.duplicateId, `Id ${input.definition.id} already appears in ${existing.paths.length} ${scope} files (${existing.paths.join(", ")}). No file was written. Keep one file for this id.`, { scope, id: input.definition.id, blocking: true, structural: true }));
            return { ok: false, diagnostics };
        }
        const target = existing.paths[0] ?? canonicalPath;
        if (existing.paths.length === 1 && !input.replace) {
            diagnostics.push(diagnostic(DiagnosticCodes.definitionExists, `Id ${input.definition.id} already exists at ${target}. Nothing was overwritten. Pass replace: true to update that file in place.`, { scope, path: target, id: input.definition.id, blocking: true, structural: true }));
            return { ok: false, diagnostics };
        }
        if (existing.paths.length === 0 && existsSync(canonicalPath)) {
            diagnostics.push(diagnostic(DiagnosticCodes.definitionExists, `${canonicalPath} exists and does not already hold id ${input.definition.id}. Refusing to overwrite it.`, { scope, path: canonicalPath, id: input.definition.id, blocking: true, structural: true }));
            return { ok: false, diagnostics };
        }
        writeAtomic(target, serialized.markdown, root);
        return { ok: true, path: target, scope, diagnostics };
    }
    catch (error) {
        diagnostics.push(diagnostic(DiagnosticCodes.ioError, error instanceof Error ? error.message : String(error), {
            scope,
            blocking: true,
            structural: true,
        }));
        return { ok: false, diagnostics };
    }
}
export function isSafeConfigDirName(name) {
    return /^\.[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) || /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
}
function collectDirectory(directory, scope, directoryKind, into, diagnostics, sources) {
    let stats;
    try {
        stats = lstatSync(directory);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return;
        diagnostics.push(diagnostic(DiagnosticCodes.ioError, `Could not read ${directory}: ${error.message}`, {
            scope,
            path: directory,
            blocking: false,
            structural: false,
        }));
        return;
    }
    if (stats.isSymbolicLink()) {
        diagnostics.push(diagnostic(DiagnosticCodes.symlinkIgnored, `Ignoring symlinked catalog directory ${directory}. Discovery does not follow links outside the scope.`, { scope, path: directory, blocking: false, structural: false, severity: "warning" }));
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
    let names;
    try {
        names = readdirSync(directory);
    }
    catch (error) {
        // lstat can succeed and readdir still fail: mode 000, or the directory
        // disappearing between the two calls. Keep the failure on this path.
        diagnostics.push(diagnostic(DiagnosticCodes.ioError, `Could not read ${directory}: ${error.message}`, {
            scope,
            path: directory,
            blocking: false,
            structural: false,
        }));
        return;
    }
    names.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    for (const name of names) {
        if (name.startsWith(".") || !name.endsWith(".md"))
            continue;
        const path = join(directory, name);
        let fileStats;
        try {
            fileStats = lstatSync(path);
        }
        catch (error) {
            diagnostics.push(diagnostic(DiagnosticCodes.ioError, `Could not stat ${path}: ${error.message}`, {
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
        if (!fileStats.isFile())
            continue;
        let raw;
        try {
            raw = sources?.read(path) ?? readFileSync(path, "utf8");
        }
        catch (error) {
            diagnostics.push(diagnostic(DiagnosticCodes.ioError, `Could not read ${path}: ${error.message}`, {
                scope,
                path,
                blocking: false,
                structural: false,
            }));
            continue;
        }
        let parse;
        try {
            parse = sources?.parse(raw, path) ?? parseDefinition(raw, path);
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            diagnostics.push(diagnostic(DiagnosticCodes.parserLimit, `Stopped reading ${path}: ${detail.length > 500 ? `${detail.slice(0, 500)}\u2026` : detail}. This file was isolated so valid catalog entries remain usable.`, { scope, path, blocking: false, structural: true }));
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
        const occurrence = {
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
function selectIdentities(groups, diagnostics) {
    const ids = new Set();
    for (const scope of SOURCE_PRECEDENCE) {
        for (const id of groups.get(scope).keys())
            ids.add(id);
    }
    const entries = [];
    const blocked = [];
    for (const id of [...ids].sort()) {
        const considered = SOURCE_PRECEDENCE
            .map((scope) => ({ scope, group: groups.get(scope).get(id) ?? [] }))
            .filter((item) => item.group.length > 0);
        const [highest, ...lower] = considered;
        if (!highest)
            continue;
        const unused = lower.flatMap((item) => item.group.map((occurrence) => unusedSource(occurrence, highest.group.length > 1
            ? "blocked-by-duplicate-higher-priority"
            : highest.group[0].parse.ok
                ? "shadowed-by-whole-definition"
                : "blocked-by-invalid-higher-priority")));
        if (highest.group.length > 1) {
            const paths = highest.group.map((occurrence) => occurrence.path);
            const duplicateDiagnostic = diagnostic(DiagnosticCodes.duplicateId, `Duplicate id ${id} in ${highest.scope} scope: ${paths.join(", ")}. No file was selected by filesystem order, and lower-priority sources were not used. Keep a single file for this id.`, { scope: highest.scope, id, blocking: true, structural: true });
            diagnostics.push(duplicateDiagnostic);
            blocked.push({
                id,
                kind: kindForId(id),
                scope: highest.scope,
                path: paths[0],
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
        const winner = highest.group[0];
        const winnerDiagnostics = winner.parse.diagnostics.map((item) => ({
            ...item,
            scope: winner.scope,
            path: item.path ?? winner.path,
            id: item.id ?? id,
        }));
        if (winner.parse.ok && winner.parse.definition && winner.directoryKind !== winner.parse.definition.kind) {
            winnerDiagnostics.push(diagnostic(DiagnosticCodes.kindDirectoryMismatch, `${winner.path} is in the ${winner.directoryKind} directory but declares kind ${winner.parse.definition.kind}. Identity comes from id ${id}, not the directory.`, { scope: winner.scope, path: winner.path, id, blocking: false, structural: false, severity: "warning" }));
        }
        if (!winner.parse.ok) {
            winnerDiagnostics.push(diagnostic(DiagnosticCodes.invalidShadow, `Invalid ${winner.scope} definition at ${winner.path} blocks id ${id}. Lower-priority definitions were not used. Repair or remove this file.`, { scope: winner.scope, path: winner.path, id, blocking: true, structural: true }));
            diagnostics.push(winnerDiagnostics.at(-1));
        }
        const blocking = winnerDiagnostics.some((item) => item.blocking);
        const entry = {
            id,
            kind: kindForId(id),
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
function unusedSource(occurrence, reason) {
    return {
        scope: occurrence.scope,
        path: occurrence.path,
        contentDigest: occurrence.contentDigest,
        id: occurrence.parse.definition?.id ?? occurrence.parse.occupantId,
        reason,
    };
}
function finishSnapshot(entries, blocked, diagnostics, loadedAt) {
    const roleEntries = [];
    const agentEntries = [];
    for (const entry of entries) {
        const frozen = deepFreeze(cloneEntry(entry));
        if (frozen.kind === "role")
            roleEntries.push([frozen.id, frozen]);
        else
            agentEntries.push([frozen.id, frozen]);
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
    const snapshot = {
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
function digestEntry(entry) {
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
function snapshotDigest(payload) {
    return createHash("sha256").update(JSON.stringify(stableJson(payload))).digest("hex");
}
function stableJson(value) {
    if (Array.isArray(value))
        return value.map(stableJson);
    if (value && typeof value === "object") {
        const output = {};
        for (const key of Object.keys(value).sort()) {
            const item = value[key];
            if (item !== undefined)
                output[key] = stableJson(item);
        }
        return output;
    }
    return value;
}
function cloneEntry(entry) {
    return {
        ...entry,
        paths: [...entry.paths],
        diagnostics: entry.diagnostics.map((item) => ({ ...item })),
        unused: entry.unused.map((item) => ({ ...item })),
        definition: entry.definition ? structuredClone(entry.definition) : undefined,
    };
}
function sortDiagnostics(diagnostics) {
    return diagnostics
        .map((item) => ({ ...item }))
        .sort((left, right) => `${left.code}\0${left.path ?? ""}\0${left.message}`.localeCompare(`${right.code}\0${right.path ?? ""}\0${right.message}`));
}
function findExisting(directory, id) {
    if (!existsSync(directory))
        return { ok: true, paths: [] };
    let stats;
    try {
        stats = lstatSync(directory);
    }
    catch (error) {
        return { ok: false, diagnostics: [diagnostic(DiagnosticCodes.ioError, error.message, { path: directory, blocking: true, structural: true })] };
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
    const paths = [];
    for (const name of readdirSync(directory)) {
        if (name.startsWith(".") || !name.endsWith(".md"))
            continue;
        const path = join(directory, name);
        const fileStats = lstatSync(path);
        if (fileStats.isSymbolicLink() || !fileStats.isFile())
            continue;
        const parsed = parseDefinition(readFileSync(path, "utf8"), path);
        const found = parsed.definition?.id ?? parsed.occupantId;
        if (found === id)
            paths.push(path);
    }
    paths.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    return { ok: true, paths };
}
function mkdirWithin(root, directory) {
    mkdirSync(directory, { recursive: true });
    assertInside(root, directory);
    assertNoSymlinkWalk(root, directory);
}
function writeAtomic(target, content, root) {
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
    }
    catch (error) {
        closeSync(fd);
        rmSync(temporary, { force: true });
        throw error;
    }
    closeSync(fd);
    try {
        renameSync(temporary, target);
    }
    catch (error) {
        rmSync(temporary, { force: true });
        throw error;
    }
    assertInside(root, target);
}
function containedRoot(root) {
    return existsSync(root) ? realpathSync(root) : resolve(root);
}
function assertInside(root, target) {
    const resolvedRoot = containedRoot(root);
    const resolvedTarget = existsSync(target) ? realpathSync(target) : resolve(target);
    const rel = relative(resolvedRoot, resolvedTarget);
    if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(`Path ${target} escapes catalog root ${root}.`);
    }
}
function assertNoSymlinkWalk(root, target) {
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
function pathExists(path) {
    try {
        lstatSync(path);
        return true;
    }
    catch {
        return false;
    }
}
function deepFreeze(value) {
    if (!value || typeof value !== "object")
        return value;
    if (value instanceof Map) {
        for (const child of value.values())
            deepFreeze(child);
        Object.freeze(value);
        return value;
    }
    if (Object.isFrozen(value))
        return value;
    for (const child of Object.values(value))
        deepFreeze(child);
    Object.freeze(value);
    return value;
}
function diagnostic(code, message, fields) {
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
