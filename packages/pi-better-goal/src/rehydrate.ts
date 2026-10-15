import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, join } from "node:path";

import type { WorkflowOwner } from "./workflow.js";

export const WORKFLOW_REHYDRATE_MESSAGE_TYPE = "workflow-rehydrate";
export const REHYDRATE_TIMEOUT_MS = 10_000;

/** Script locations a coordinator skill may ship, in precedence order, relative to its SKILL.md directory. */
const REHYDRATE_SCRIPTS = [join("scripts", "rehydrate.mjs"), "rehydrate.mjs"];

export function rehydrateFallbackMessage(owner: WorkflowOwner): string {
  return `Your context was just compacted while you coordinate the ${owner.name} workflow. ` +
    `Before your next step, read ${owner.path} in full, with no line limit.`;
}

/** The first rehydrate script the owner's skill ships, or undefined when it ships none. */
export function findRehydrateScript(owner: WorkflowOwner): string | undefined {
  const skillDir = dirname(owner.path);
  for (const relative of REHYDRATE_SCRIPTS) {
    const candidate = join(skillDir, relative);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Missing or unreadable: try the next location.
    }
  }
  return undefined;
}

function runScript(script: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("node", [script, "--cwd", cwd], { cwd, timeout: timeoutMs, encoding: "utf8", windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

/**
 * The message to inject after a compaction while `owner` coordinates the session, or null for none.
 * A skill's rehydrate script decides the text (empty output means no run is in progress); without
 * a script, or when it fails or times out, the model is told to re-read SKILL.md. Never throws.
 */
export async function workflowRehydrateMessage(
  owner: WorkflowOwner,
  cwd: string,
  options: { timeoutMs?: number } = {},
): Promise<string | null> {
  try {
    const script = findRehydrateScript(owner);
    if (!script) return rehydrateFallbackMessage(owner);
    const stdout = (await runScript(script, cwd, options.timeoutMs ?? REHYDRATE_TIMEOUT_MS)).trim();
    return stdout.length > 0 ? stdout : null;
  } catch {
    return rehydrateFallbackMessage(owner);
  }
}
