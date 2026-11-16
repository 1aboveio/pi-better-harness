import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bundledRolesRoot, contentDigest, loadCatalog, projectCatalogPaths, userCatalogPaths } from "./domain/catalog/catalog-store.mjs";
import { parseDefinition } from "./domain/catalog/catalog-schema.mjs";

// Fixed-build, server-local derived values only. No grant or launch authority is cached.
export class CatalogSources {
  readonly metrics = { reads: 0, parses: 0, scopes: 0, notifications: 0, stats: 0 };
  private files = new Map<string, { version: string; raw: string }>();
  private fileBytes = 0;
  private parsed = new Map<string, ReturnType<typeof parseDefinition>>();
  private scopes = new Map<string, { version: string; snapshot: ReturnType<typeof loadCatalog> }>();

  private version(path: string): string {
    this.metrics.stats++;
    try {
      const s = lstatSync(path, { bigint: true });
      return [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].join(":");
    } catch (error) { return String(error); }
  }

  read = (path: string): string => {
    const version = this.version(path);
    const previous = this.files.get(path);
    if (previous?.version === version) return previous.raw;
    this.metrics.reads++;
    const raw = readFileSync(path, "utf8");
    this.fileBytes -= previous ? Buffer.byteLength(previous.raw) : 0;
    this.files.delete(path);
    // Large definitions remain readable but cannot consume the shared cache budget.
    if (Buffer.byteLength(raw) > 1024 * 1024) return raw;
    this.fileBytes += Buffer.byteLength(raw);
    while (this.files.size && (this.fileBytes > 16 * 1024 * 1024 || this.files.size >= 2048)) {
      const oldest = this.files.keys().next().value!;
      this.fileBytes -= Buffer.byteLength(this.files.get(oldest)!.raw);
      this.files.delete(oldest);
    }
    this.put(this.files, path, { version, raw }, 2048);
    return raw;
  };

  parse = (raw: string, path: string): ReturnType<typeof parseDefinition> => {
    const key = JSON.stringify([path, contentDigest(raw)]);
    const previous = this.parsed.get(key);
    if (previous) return previous;
    this.metrics.parses++;
    const parsed = parseDefinition(raw, path);
    if (Buffer.byteLength(raw) <= 64 * 1024) this.put(this.parsed, key, parsed, 512);
    return parsed;
  };

  load(loc: { cwd: string; userRoot: string; projectTrusted: boolean }, fresh = false) {
    const user = userCatalogPaths(loc.userRoot);
    const project = projectCatalogPaths(loc.cwd);
    const roots = [user.root, ...(loc.projectTrusted ? [project.root] : [])];
    const directories = [user.roles, user.agents, bundledRolesRoot(), ...(loc.projectTrusted ? [project.roles, project.agents] : [])];
    const versions: unknown[] = roots.map(root => [root, this.version(join(root, "settings.json"))]);
    if (!loc.projectTrusted) versions.push([project.root, this.version(project.root)]);
    for (const directory of directories) {
      versions.push([directory, this.version(directory)]);
      // Never follow a directory link, including when calculating cache identity.
      try {
        if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) continue;
        for (const name of readdirSync(directory).sort()) {
          if (!name.startsWith(".") && name.endsWith(".md")) versions.push([name, this.version(join(directory, name))]);
        }
      } catch { /* loadCatalog reports discovery failures. */ }
    }
    const key = JSON.stringify([loc.cwd, loc.userRoot, loc.projectTrusted]);
    const version = JSON.stringify(versions);
    const previous = this.scopes.get(key);
    if (!fresh && previous?.version === version) return previous.snapshot;
    this.metrics.scopes++;
    // Writes always use fresh bytes, not a stat-derived content proof.
    const sources = fresh ? {
      read: (path: string) => { this.metrics.reads++; return readFileSync(path, "utf8"); },
      parse: this.parse,
    } : this;
    const snapshot = loadCatalog({ ...loc, sources });
    this.put(this.scopes, key, { version, snapshot }, 64);
    return snapshot;
  }

  private put<K, V>(map: Map<K, V>, key: K, value: V, limit: number) {
    map.delete(key); map.set(key, value);
    if (map.size > limit) map.delete(map.keys().next().value!);
  }

  clear() { this.files.clear(); this.fileBytes = 0; this.parsed.clear(); this.scopes.clear(); }
}
