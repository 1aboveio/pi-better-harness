import type { CommandResult, Condition } from "./types.js";

export interface ConditionMatch {
  matched: boolean;
  value?: unknown;
  error?: string;
}

export function evaluateCondition(condition: Condition, result: CommandResult): ConditionMatch {
  switch (condition.type) {
    case "exit_code":
      return { matched: result.exitCode === condition.equals, value: result.exitCode };
    case "stdout_contains":
      return { matched: result.stdout.includes(condition.value) };
    case "stderr_contains":
      return { matched: result.stderr.includes(condition.value) };
    case "json_path_equals": {
      const resolved = resolveJsonPath(result.stdout, condition.path);
      if (!resolved.ok) return { matched: false, error: resolved.error };
      return { matched: deepEqual(resolved.value, condition.value), value: resolved.value };
    }
    case "json_path_exists": {
      const resolved = resolveJsonPath(result.stdout, condition.path);
      return resolved.ok ? { matched: true, value: resolved.value } : { matched: false, error: resolved.error };
    }
  }
}

export function resolveJsonPath(jsonText: string, path: string): { ok: true; value: unknown } | { ok: false; error: string } {
  let current: unknown;
  try {
    current = JSON.parse(jsonText);
  } catch (error) {
    return { ok: false, error: `stdout is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }

  const tokens = parseJsonPath(path);
  if (!tokens) return { ok: false, error: `unsupported JSON path: ${path}` };

  for (const token of tokens) {
    if (typeof token === "number") {
      if (!Array.isArray(current) || token < 0 || token >= current.length) {
        return { ok: false, error: `JSON path not found: ${path}` };
      }
      current = current[token];
      continue;
    }
    if (current === null || typeof current !== "object" || !(token in current)) {
      return { ok: false, error: `JSON path not found: ${path}` };
    }
    current = (current as Record<string, unknown>)[token];
  }

  return { ok: true, value: current };
}

function parseJsonPath(path: string): Array<string | number> | undefined {
  if (!path.startsWith("$")) return undefined;
  const tokens: Array<string | number> = [];
  let i = 1;
  while (i < path.length) {
    if (path[i] === ".") {
      i += 1;
      const start = i;
      while (i < path.length && /[A-Za-z0-9_$-]/.test(path[i]!)) i += 1;
      if (i === start) return undefined;
      tokens.push(path.slice(start, i));
      continue;
    }
    if (path[i] === "[") {
      const end = path.indexOf("]", i);
      if (end === -1) return undefined;
      const raw = path.slice(i + 1, end).trim();
      const quoted = raw.match(/^['\"](.+)['\"]$/);
      if (quoted) {
        tokens.push(quoted[1]!);
      } else if (/^\d+$/.test(raw)) {
        tokens.push(Number(raw));
      } else {
        return undefined;
      }
      i = end + 1;
      continue;
    }
    return undefined;
  }
  return tokens;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}