import { open, opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse, resolve, sep } from "node:path";

const MAX_DEPTH = 32;
const MAX_FILES = 1024;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_WORK = 32_768;

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function readError(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException).code;
  // Paths and source lines may contain credentials; expose only the error code.
  return Object.assign(new Error(`Cannot read SSH configuration (${code ?? "unknown error"})`), { code });
}

function argumentsOf(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote = "";
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (char === "\\" && i + 1 < line.length) {
      word += line[++i];
      started = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (char === "#") {
      break;
    } else if (/\s/.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) throw new Error("Invalid quoting in SSH Host or Include directive");
  if (started) words.push(word);
  return words;
}

function componentPattern(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else if (char === "[") {
      let start = i + 1;
      if (pattern[start] === "!") start++;
      if (pattern[start] === "]") start++;
      const end = pattern.indexOf("]", start);
      if (end === -1) source += "\\[";
      else {
        let body = pattern.slice(i + 1, end);
        const negated = body.startsWith("!");
        if (negated) body = body.slice(1);
        source += `[${negated ? "^" : ""}${body.replace(/\\/g, "\\\\").replace(/^\^/, "\\^").replace(/\]/g, "\\]")}]`;
        i = end;
      }
    } else source += char.replace(/[\\^$+.(){}|\]]/g, "\\$&");
  }
  try { return new RegExp(`${source}$`); }
  catch { throw new Error("Invalid SSH Include glob pattern"); }
}

/**
 * Discover literal Host aliases, not resolved connection settings or history.
 * Relative Includes stay rooted at dirname(configPath), including nested ones.
 * Host/Match conditions are not evaluated; no commands or network access occur.
 * Supports ~/ and pathname globs (*, ?, [...]), not ~user, tokens or env expansion.
 * Rejects excessive depth (32), unique files (1024), bytes (8 MiB), or work (32768).
 */
export async function sshHostAliases(configPath: string = join(homedir(), ".ssh", "config")): Promise<string[]> {
  const homePath = (path: string) => path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  const initial = resolve(homePath(configPath));
  const root = dirname(initial);
  const visited = new Set<string>();
  const aliases = new Set<string>();
  let bytes = 0;
  let work = 0;
  const spend = () => {
    if (++work > MAX_WORK) throw new Error("SSH configuration discovery work limit exceeded (32768)");
  };

  // Match one component at a time: unlike recursive JS globs, OpenSSH's ** is *.
  async function* expand(pattern: string): AsyncGenerator<string> {
    const absolute = resolve(root, homePath(pattern));
    const base = parse(absolute).root;
    const parts = absolute.slice(base.length).split(sep);
    async function* walk(path: string, index: number): AsyncGenerator<string> {
      spend();
      if (index === parts.length) { yield path; return; }
      const part = parts[index]!;
      if (!/[?*[]/.test(part)) {
        yield* walk(join(path, part), index + 1);
        return;
      }
      const matcher = componentPattern(part);
      const matches: string[] = [];
      try {
        const directory = await opendir(path);
        for await (const entry of directory) {
          spend();
          if ((entry.name.startsWith(".") && !part.startsWith(".")) || !matcher.test(entry.name)) continue;
          if (index + 1 < parts.length && !entry.isDirectory()) {
            if (!entry.isSymbolicLink()) continue;
            try { if (!(await stat(join(path, entry.name))).isDirectory()) continue; }
            catch (error) { if (missing(error)) continue; throw error; }
          }
          matches.push(entry.name);
        }
      } catch (error) {
        if (missing(error)) return;
        if ((error as NodeJS.ErrnoException).code) throw readError(error);
        throw error;
      }
      for (const name of matches.sort()) yield* walk(join(path, name), index + 1);
    }
    yield* walk(base, 0);
  }

  async function visit(path: string, depth: number): Promise<void> {
    spend();
    let canonical: string;
    try { canonical = await realpath(path); }
    catch (error) { if (missing(error)) return; throw readError(error); }
    if (visited.has(canonical)) return;
    if (depth > MAX_DEPTH) throw new Error("SSH configuration Include depth limit exceeded (32)");
    if (visited.size >= MAX_FILES) throw new Error("SSH configuration file limit exceeded (1024)");
    visited.add(canonical);
    let contents: string;
    try {
      const file = await open(canonical, "r");
      try {
        // A bounded read also handles a file growing while discovery runs.
        const chunks: Buffer[] = [];
        while (true) {
          const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_BYTES - bytes + 1));
          const { bytesRead } = await file.read(buffer);
          if (!bytesRead) break;
          bytes += bytesRead;
          if (bytes > MAX_BYTES) throw new Error("SSH configuration byte limit exceeded (8 MiB)");
          chunks.push(buffer.subarray(0, bytesRead));
        }
        contents = Buffer.concat(chunks).toString("utf8");
      } finally { await file.close(); }
    } catch (error) {
      if (missing(error)) return;
      if ((error as NodeJS.ErrnoException).code) throw readError(error);
      throw error;
    }
    for (const line of contents.split(/\r?\n/)) {
      const directive = /^\s*(host|include)(?:\s*=\s*|\s+)(.*)$/i.exec(line);
      if (!directive) continue;
      const args = argumentsOf(directive[2]!);
      if (directive[1]!.toLowerCase() === "host") {
        for (const alias of args) {
          if (alias && !alias.startsWith("!") && !/[*?[\]\s\x00-\x1f\x7f]/.test(alias)) aliases.add(alias);
        }
      } else {
        for (const pattern of args) {
          spend();
          if (pattern.startsWith("~") && !pattern.startsWith("~/")) throw new Error("SSH Include ~user paths are not supported");
          const includedPaths: string[] = [];
          for await (const included of expand(pattern)) includedPaths.push(included);
          for (const included of includedPaths.sort()) await visit(included, depth + 1);
        }
      }
    }
  }

  await visit(initial, 0);
  return [...aliases];
}
