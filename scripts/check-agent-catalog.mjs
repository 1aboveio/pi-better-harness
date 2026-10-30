import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { parseDefinition } from "../packages/pi-better-subagents/catalog-schema.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

/** Validate the published source alone, never a user's effective local catalog. */
export function checkAgentCatalog(root = repositoryRoot) {
    root = realpathSync(root);
    const document = parseDocument(readFileSync(join(root, "agent-catalog.yaml"), "utf8"), {
        uniqueKeys: true,
    });
    if (document.errors.length) throw new Error(document.errors.map((error) => error.message).join("\n"));
    const manifest = document.toJS({ maxAliasCount: 50 });
    if (!manifest || manifest.schema !== "pi-agent-catalog/v1" || manifest.definitionSchema !== "pi-agent/v1") {
        throw new Error("Unsupported catalog or definition schema.");
    }
    if (typeof manifest.id !== "string" || !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(manifest.id)) {
        throw new Error("Catalog id must be a stable, namespaced lowercase identifier.");
    }
    if (typeof manifest.name !== "string" || !manifest.name.trim()) throw new Error("Catalog name is required.");
    if (!manifest.paths || typeof manifest.paths !== "object" || Array.isArray(manifest.paths) || !manifest.paths.roles) {
        throw new Error("paths.roles is required; paths.agents is optional.");
    }
    if (Object.keys(manifest.paths).some((key) => !["roles", "agents"].includes(key))) {
        throw new Error("Unknown catalog definition directory kind.");
    }

    const definitions = new Map();
    const files = [];
    const diagnostics = [];
    for (const [kind, directory] of Object.entries(manifest.paths)) {
        if (typeof directory !== "string" || !directory || isAbsolute(directory)
            || directory.includes("\\") || directory.split("/").some((part) => !part || part === "." || part === "..")) {
            throw new Error(`paths.${kind} must be a repository-relative directory without traversal.`);
        }
        const absolute = join(root, directory);
        // Git symlinks must not let a subscription fetch definitions outside its pinned tree.
        let current = root;
        for (const segment of directory.split("/")) {
            current = join(current, segment);
            if (lstatSync(current).isSymbolicLink()) throw new Error(`Catalog path is a symlink: ${directory}`);
        }
        if (!lstatSync(absolute).isDirectory()) throw new Error(`Not a catalog directory: ${directory}`);
        const entries = readdirSync(absolute).filter((name) => name.endsWith(".md")).sort();
        if (!entries.length) throw new Error(`Declared catalog directory is empty: ${directory}`);
        for (const name of entries) {
            const path = join(absolute, name);
            if (!lstatSync(path).isFile()) throw new Error(`Definition must be a regular file: ${directory}/${name}`);
            const source = relative(root, path).split(sep).join("/");
            const parsed = parseDefinition(readFileSync(path, "utf8"), source);
            diagnostics.push(...parsed.diagnostics);
            if (!parsed.ok || !parsed.definition || parsed.diagnostics.some((diagnostic) => diagnostic.blocking)) {
                throw new Error(`Invalid definition ${source}: ${parsed.diagnostics.map((diagnostic) => diagnostic.message).join("; ")}`);
            }
            const definition = parsed.definition;
            if (definition.kind !== (kind === "roles" ? "role" : "agent")) throw new Error(`Wrong definition kind in ${source}`);
            if (definitions.has(definition.id)) throw new Error(`Duplicate definition id: ${definition.id}`);
            definitions.set(definition.id, definition);
            files.push({ path: source, id: definition.id, kind: definition.kind });
        }
    }
    for (const definition of definitions.values()) {
        if (definition.kind === "agent" && definitions.get(definition.roleId)?.kind !== "role") {
            throw new Error(`Missing base role ${definition.roleId} for ${definition.id}`);
        }
    }
    return { catalogId: manifest.id, files, diagnostics };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const result = checkAgentCatalog(process.argv[2] ? resolve(process.argv[2]) : repositoryRoot);
        console.log(JSON.stringify(result, null, 2));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}