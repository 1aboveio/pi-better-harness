import { lstatSync, opendirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bundledRolesRoot, contentDigest, loadCatalog, projectCatalogPaths, userCatalogPaths } from "./domain/catalog/catalog-store.mjs";
import { parseDefinition } from "./domain/catalog/catalog-schema.mjs";
import { readCatalogPreferences } from "./domain/catalog/catalog-preferences.mjs";
import type { CatalogEntry } from "./domain/catalog/catalog-store.mjs";

type Location = { cwd: string; userRoot: string; projectTrusted: boolean };
type Scope = { version: string; snapshot: ReturnType<typeof loadCatalog>; loc: Location; scan?: Generator<void, string>; checked?: string };

// Fixed-build, server-local derived values only. No grant or launch authority is cached.
export class CatalogSources {
  readonly metrics = { reads: 0, parses: 0, scopes: 0, notifications: 0, stats: 0, repairSteps: 0, repairs: 0, entries: 0, preferenceReads: 0 };
  private files = new Map<string, { version: string; raw: string }>();
  private fileBytes = 0;
  private parsed = new Map<string, ReturnType<typeof parseDefinition>>();
  private scopes = new Map<string, Scope>();
  private entries = new Map<string, CatalogEntry>();
  private preferencesCache = new Map<string, { version: string; value: ReturnType<typeof readCatalogPreferences> }>();
  private observing = false;
  private active = new Set<string>();
  private turn = 0;

  beginObservation() { this.observing = true; this.active.clear(); }
  endObservation() {
    this.observing = false;
    for (const [key, scope] of this.scopes) if (!this.active.has(key)) { scope.scan?.return(""); scope.scan = undefined; }
  }

  /** The budget counts iterator/stat steps across all scopes, not per observer. */
  repair(budget = 128) {
    const scopes = [...this.active].map(key => this.scopes.get(key)).filter((scope): scope is Scope => !!scope);
    if (!scopes.length) return false;
    const completed = new Set<Scope>();
    let changed = false;
    for (let step = 0; step < budget; step++) {
      if (completed.size === scopes.length) break;
      const scope = scopes[this.turn++ % scopes.length]!;
      if (completed.has(scope)) { step--; continue; }
      scope.scan ??= this.scan(scope.loc);
      this.metrics.repairSteps++;
      const next = scope.scan.next();
      if (next.done) {
        scope.checked = next.value;
        scope.scan = undefined;
        this.metrics.repairs++;
        changed ||= scope.checked !== scope.version;
        completed.add(scope);
      }
    }
    return changed;
  }

  watchPaths() {
    return new Set([...this.active].flatMap(key => {
      const loc = this.scopes.get(key)?.loc;
      return loc ? this.paths(loc).directories : [];
    }));
  }

  hint(path: string) {
    for (const key of this.active) {
      const scope = this.scopes.get(key);
      if (scope && this.paths(scope.loc).directories.some(directory => directory === path || directory === dirname(path))) {
        scope.checked = "hint:" + path + ":" + this.version(path);
      }
    }
  }

  private paths(loc: Location) {
    const user = userCatalogPaths(loc.userRoot), project = projectCatalogPaths(loc.cwd);
    return { project, roots: [user.root, ...(loc.projectTrusted ? [project.root] : [])],
      directories: [user.root, user.roles, user.agents, bundledRolesRoot(), ...(loc.projectTrusted ? [project.root, project.roles, project.agents] : [])] };
  }

  private *scan(loc: Location): Generator<void, string> {
    const { roots, directories, project } = this.paths(loc);
    const versions: unknown[] = [];
    for (const root of roots) { versions.push([root, this.version(join(root, "settings.json"))]); yield; }
    if (!loc.projectTrusted) { versions.push([project.root, this.version(project.root)]); yield; }
    for (const directory of directories) {
      versions.push([directory, this.version(directory)]); yield;
      let handle: ReturnType<typeof opendirSync> | undefined;
      const files: unknown[] = [];
      try {
        const stats = lstatSync(directory);
        if (!stats.isDirectory() || stats.isSymbolicLink()) continue;
        handle = opendirSync(directory);
        for (;;) {
          const entry = handle.readSync();
          if (!entry) break;
          if (!entry.name.startsWith(".") && entry.name.endsWith(".md")) files.push([entry.name, this.version(join(directory, entry.name))]);
          yield;
        }
      } catch (error) { files.push(String(error)); }
      finally { handle?.closeSync(); }
      versions.push(files.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    }
    return JSON.stringify(versions);
  }

  entry = (entry: CatalogEntry) => {
    const key = JSON.stringify(entry);
    const previous = this.entries.get(key);
    if (previous) return previous;
    this.metrics.entries++;
    if (Buffer.byteLength(key) <= 64 * 1024) this.put(this.entries, key, entry, 512);
    return entry;
  };

  preferences = (root: string) => {
    const version = this.version(root) + this.version(join(root, "settings.json"));
    const previous = this.preferencesCache.get(root);
    if (previous?.version === version) return previous.value;
    this.metrics.preferenceReads++;
    const value = readCatalogPreferences(root);
    this.put(this.preferencesCache, root, { version, value }, 128);
    return value;
  };

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

  load(loc: Location, fresh = false) {
    const key = JSON.stringify([loc.cwd, loc.userRoot, loc.projectTrusted]);
    const previous = this.scopes.get(key);
    if (this.observing) this.active.add(key);
    if (this.observing && !fresh && previous && (!previous.checked || previous.checked === previous.version)) return previous.snapshot;
    let version = this.observing && previous?.checked;
    if (!version) {
      const scan = this.scan(loc);
      let next = scan.next();
      while (!next.done) next = scan.next();
      version = next.value;
    }
    if (!fresh && previous?.version === version) return previous.snapshot;
    this.metrics.scopes++;
    // Writes always use fresh bytes, not a stat-derived content proof.
    const sources = fresh ? {
      read: (path: string) => { this.metrics.reads++; return readFileSync(path, "utf8"); },
      parse: this.parse,
      entry: this.entry,
      preferences: (root: string) => { this.metrics.preferenceReads++; return readCatalogPreferences(root); },
    } : this;
    const snapshot = loadCatalog({ ...loc, sources });
    if (!previous && this.scopes.size >= 64) this.scopes.values().next().value?.scan?.return("");
    // Hot exact hints must not restart a long missed-event reconciliation pass.
    this.put(this.scopes, key, { version, snapshot, loc, scan: previous?.scan }, 64);
    return snapshot;
  }

  private put<K, V>(map: Map<K, V>, key: K, value: V, limit: number) {
    map.delete(key); map.set(key, value);
    if (map.size > limit) map.delete(map.keys().next().value!);
  }

  get resources() { return { scopes: this.scopes.size, scans: [...this.scopes.values()].filter(scope => !!scope.scan).length, files: this.files.size, fileBytes: this.fileBytes }; }

  clear() {
    for (const scope of this.scopes.values()) scope.scan?.return("");
    this.files.clear(); this.fileBytes = 0; this.parsed.clear(); this.scopes.clear();
    this.entries.clear(); this.preferencesCache.clear(); this.active.clear();
  }
}
