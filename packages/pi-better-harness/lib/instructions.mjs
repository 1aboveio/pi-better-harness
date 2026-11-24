import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquire, defaultAgentDir, writeDestination } from "./install-settings.mjs";

const begin = "<!-- pi-better-harness:instructions:begin -->";
const end = "<!-- pi-better-harness:instructions:end -->";
const bundled = fileURLToPath(new URL("../extensions/harness-instructions/AGENTS.md", import.meta.url));

function sourceText(agentDir, target) {
  const settingsPath = join(agentDir, "settings.json");
  const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
  const source = settings.piBetterHarness?.instructionsFile;
  if (source === false) return null;
  const prompt = settings.piBetterHarness?.instructionsPrompt;
  if (typeof prompt === "string") return validateInstructionsPrompt(prompt);
  if (source !== undefined && (typeof source !== "string" || !source.trim())) {
    throw new Error("piBetterHarness.instructionsFile must be a file path or false.");
  }
  const path = source === undefined ? bundled : resolve(agentDir, source);
  if (resolve(path) === resolve(target) || realpathSync(path) === target) {
    throw new Error("The instructions source must be separate from APPEND_SYSTEM.md.");
  }
  return validateInstructionsPrompt(readFileSync(path, "utf8"));
}

export function validateInstructionsPrompt(prompt) {
  const text = prompt.trim();
  if (text.includes(begin) || text.includes(end)) throw new Error("Instructions contain reserved block markers.");
  return text;
}

function blockRange(text) {
  const start = text.indexOf(begin);
  const finish = text.indexOf(end);
  if (start === -1 && finish === -1) return undefined;
  const lineStart = i => i === 0 || text[i - 1] === "\n";
  const lineEnding = i => text.slice(i).match(/^(?:\r\n|\n|$)/)?.[0];
  const after = finish + end.length;
  if (start < 0 || finish < start || start !== text.lastIndexOf(begin) || finish !== text.lastIndexOf(end)
      || !lineStart(start) || !lineStart(finish) || !lineEnding(start + begin.length) || lineEnding(after) === undefined) {
    throw new Error("Ambiguous Harness block markers in APPEND_SYSTEM.md. Repair the markers before syncing.");
  }
  return [start, after + lineEnding(after).length];
}

function readTarget(path) {
  try {
    if (!statSync(path).isFile()) throw new Error(`Expected a regular file at ${path}`);
    return readFileSync(path);
  }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

function blockPrompt(text, range) {
  if (!range) return undefined;
  return text.slice(range[0] + begin.length, text.indexOf(end)).trim().replace(/\r\n/g, "\n");
}

function readInstructions(target) {
  const original = readTarget(target);
  const raw = original?.toString("utf8") ?? "";
  if (original && !Buffer.from(raw).equals(original)) throw new Error(`Invalid UTF-8 in ${target}`);
  const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
  const text = raw.slice(bom.length);
  return { original, raw, bom, text, range: blockRange(text) };
}

// Return undefined for Off. An enabled, empty prompt still has both markers.
export function currentInstructions(agentDir) {
  const path = join(agentDir, "APPEND_SYSTEM.md");
  const { text, range } = readInstructions(writeDestination(path));
  return blockPrompt(text, range);
}

// The marker pair is the opt-in. Only enable may create it.
// Reread under the lock before editing so concurrent changes are preserved.
export function manageInstructions(action, agentDir = defaultAgentDir(), edit) {
  const path = join(agentDir, "APPEND_SYSTEM.md");
  if (action === "enable") mkdirSync(agentDir, { recursive: true });
  else if (!lstatSync(path, { throwIfNoEntry: false })) {
    if (edit) throw new Error("Harness instructions were disabled while editing.");
    return false;
  }
  const target = writeDestination(path);
  if (action !== "enable" && !readInstructions(target).range) {
    if (edit) throw new Error("Harness instructions changed. Reopen the editor to use the latest prompt.");
    return false;
  }
  const release = acquire(target);
  let pending;
  try {
    const { original, raw, bom, text, range } = readInstructions(target);
    if (edit) {
      if (blockPrompt(text, range) !== edit.previous) {
        throw new Error("Harness instructions changed. Reopen the editor to use the latest prompt.");
      }
      // Save the source under the block lock so another Harness editor cannot
      // slip between the comparison and the sync. A failed sync is retryable.
      edit.saveSource();
    }
    if (!range && action !== "enable") return false;
    const content = action === "disable" ? null : sourceText(agentDir, target);
    if (content === null && action === "enable") throw new Error("Set instructionsFile to a path or remove the false setting before enabling.");
    const eol = text.match(/\r?\n/)?.[0] ?? "\n";
    const block = content === null ? "" : [begin, content.replace(/\r?\n/g, eol), end, ""].join(eol);
    const [start, finish] = range ?? [0, 0];
    const updated = bom + text.slice(0, start) + block + text.slice(finish);
    if (updated === raw) return false;

    pending = join(dirname(target), `.harness-instructions-${randomUUID()}.tmp`);
    writeFileSync(pending, updated, { flag: "wx", mode: 0o600 });
    if (original) {
      chmodSync(pending, statSync(target).mode & 0o777);
      if (writeDestination(path) !== target || !readTarget(target)?.equals(original)) {
        throw new Error(`${path} changed while updating. Retry with the latest contents.`);
      }
      renameSync(pending, target);
    } else {
      // A non-cooperating writer may create the file while we hold our lock.
      linkSync(pending, target);
    }
    return true;
  } finally {
    try { if (pending) rmSync(pending, { force: true }); } finally { release(); }
  }
}
