/**
 * A guarded `apply_patch`: the Codex patch format, applied only through the
 * task's guarded file operations.
 *
 * Same tool name, parameter schema and patch format as the Codex tool (and
 * `@vanillagreen/pi-codex-minimal-tools`, MIT), so models' habits work. The
 * implementation is this harness's own: it never touches the filesystem
 * directly, so the Project files / Outside project levels, credential rules and
 * protected paths govern it exactly as they govern write, edit and bash.
 *
 * The whole patch is validated first (syntax, file rules, every hunk against
 * the current content). Only then is anything written, one whole file at a
 * time, so no file is ever left half-patched. A failure during the write phase
 * restores what it can and reports exactly what was and was not applied.
 */
import { dirname, isAbsolute, resolve } from "node:path";

export type PatchAction =
    | { kind: "add"; path: string; lines: string[] }
    | { kind: "delete"; path: string }
    | { kind: "update"; path: string; moveTo?: string; hunks: PatchHunk[] };

export interface PatchHunk {
    /** Text after `@@ `: a line to find before this hunk's context. */
    anchor?: string;
    /** Lines with their one-character prefix: " " context, "-" removed, "+" added. */
    lines: string[];
    /** `*** End of File`: the hunk's context must end at the file's last line. */
    endOfFile: boolean;
}

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const DELETE = "*** Delete File: ";
const UPDATE = "*** Update File: ";
const MOVE = "*** Move to: ";
const EOF_MARKER = "*** End of File";

export class PatchError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PatchError";
    }
}

function isHeader(line: string): boolean {
    const t = line.trim();
    return t === END || t.startsWith(ADD) || t.startsWith(DELETE) || t.startsWith(UPDATE);
}

function headerPath(line: string, prefix: string, at: number): string {
    const path = line.trim().slice(prefix.length).trim();
    if (!path) throw new PatchError(`Line ${at}: '${prefix.trim()}' needs a path.`);
    return path;
}

/** Parse Codex patch text. Throws a PatchError naming the offending line. */
export function parsePatch(input: string): PatchAction[] {
    if (typeof input !== "string" || !input.trim()) throw new PatchError("apply_patch needs a non-empty patch in `input`.");
    const lines = input.replace(/\r\n?/g, "\n").split("\n");
    let i = 0;
    while (i < lines.length && !lines[i]!.trim()) i++;
    if (lines[i]?.trim() !== BEGIN) throw new PatchError(`The patch must start with '${BEGIN}'.`);
    i++;
    const actions: PatchAction[] = [];
    let ended = false;
    while (i < lines.length) {
        const line = lines[i]!;
        const at = i + 1;
        const trimmed = line.trim();
        if (trimmed === END) { ended = true; i++; break; }
        if (!trimmed) { i++; continue; }
        if (trimmed.startsWith(ADD)) {
            const path = headerPath(line, ADD, at);
            const body: string[] = [];
            let bare = 0; // Trailing bare empty lines separate sections; inner ones are empty lines.
            i++;
            while (i < lines.length && !isHeader(lines[i]!)) {
                const bodyLine = lines[i]!;
                if (bodyLine === "") { body.push(""); bare++; i++; continue; }
                if (!bodyLine.startsWith("+")) throw new PatchError(`Line ${i + 1}: every line of an added file starts with '+' (${path}).`);
                body.push(bodyLine.slice(1));
                bare = 0;
                i++;
            }
            body.splice(body.length - bare);
            actions.push({ kind: "add", path, lines: body });
        } else if (trimmed.startsWith(DELETE)) {
            actions.push({ kind: "delete", path: headerPath(line, DELETE, at) });
            i++;
        } else if (trimmed.startsWith(UPDATE)) {
            const path = headerPath(line, UPDATE, at);
            i++;
            let moveTo: string | undefined;
            if (i < lines.length && lines[i]!.trim().startsWith(MOVE)) {
                moveTo = headerPath(lines[i]!, MOVE, i + 1);
                i++;
            }
            const hunks: PatchHunk[] = [];
            let current: PatchHunk | undefined;
            let bare = 0; // Trailing bare empty lines: separators unless more hunk lines follow.
            while (i < lines.length && !isHeader(lines[i]!)) {
                const bodyLine = lines[i]!;
                if (bodyLine.startsWith("@@")) {
                    if (current) current.lines.splice(current.lines.length - bare);
                    bare = 0;
                    const anchor = bodyLine.slice(2).trim();
                    current = { ...(anchor ? { anchor } : {}), lines: [], endOfFile: false };
                    hunks.push(current);
                } else if (bodyLine.trim() === EOF_MARKER) {
                    if (!current) throw new PatchError(`Line ${i + 1}: '${EOF_MARKER}' outside a hunk in ${path}.`);
                    current.lines.splice(current.lines.length - bare);
                    bare = 0;
                    current.endOfFile = true;
                } else {
                    if (!current) { current = { lines: [], endOfFile: false }; hunks.push(current); }
                    else if (current.endOfFile && bodyLine !== "") throw new PatchError(`Line ${i + 1}: lines after '${EOF_MARKER}' in ${path}.`);
                    if (bodyLine === "") {
                        // A bare empty line is an empty context line (models often drop the space).
                        if (!current.endOfFile) { current.lines.push(" "); bare++; }
                    } else if (" +-".includes(bodyLine[0]!)) {
                        current.lines.push(bodyLine);
                        bare = 0;
                    } else throw new PatchError(`Line ${i + 1}: hunk lines start with ' ', '+' or '-' (${path}).`);
                }
                i++;
            }
            if (current) current.lines.splice(current.lines.length - bare);
            if (hunks.some((hunk) => hunk.lines.length === 0)) throw new PatchError(`Empty hunk in ${path}.`);
            if (!hunks.length && !moveTo) throw new PatchError(`'${UPDATE.trim()} ${path}' has no changes.`);
            actions.push({ kind: "update", path, ...(moveTo ? { moveTo } : {}), hunks });
        } else {
            throw new PatchError(`Line ${at}: expected '${ADD.trim()}', '${UPDATE.trim()}', '${DELETE.trim()}' or '${END}', got: ${line.slice(0, 80)}`);
        }
    }
    if (!ended) throw new PatchError(`The patch must end with '${END}'.`);
    if (lines.slice(i).some((line) => line.trim())) throw new PatchError(`Text after '${END}'.`);
    if (!actions.length) throw new PatchError("The patch has no file operations.");
    return actions;
}

// ---- content ----------------------------------------------------------------

type Text = { lines: string[]; eol: string; finalNewline: boolean };

function splitText(content: string): Text {
    const eol = content.includes("\r\n") ? "\r\n" : "\n";
    const lines = content.split(/\r?\n/);
    const finalNewline = lines.length > 1 && lines.at(-1) === "";
    if (finalNewline || content === "") lines.pop();
    return { lines, eol, finalNewline };
}

function joinText(text: Text): string {
    return text.lines.join(text.eol) + (text.finalNewline && text.lines.length ? text.eol : "");
}

const normalizers: ((line: string) => string)[] = [
    (line) => line,
    (line) => line.trimEnd(),
    (line) => line.trim(),
    // Typographic punctuation models sometimes substitute for ASCII.
    (line) => line.trim().replace(/[‐-―−]/g, "-").replace(/[‘’‛]/g, "'")
        .replace(/[“”‟]/g, "\"").replace(/[  -   　]/g, " "),
];

/** First index at or after `from` where `needle` matches, trying stricter comparisons first. */
function seek(lines: string[], needle: string[], from: number, endOfFile: boolean): number {
    if (!needle.length) return endOfFile ? lines.length : -1;
    for (const normalize of normalizers) {
        const want = needle.map(normalize);
        const matches = (start: number) => want.every((line, k) => normalize(lines[start + k]!) === line);
        if (endOfFile) {
            const start = lines.length - needle.length;
            if (start >= from && matches(start)) return start;
            continue;
        }
        for (let start = from; start + needle.length <= lines.length; start++) if (matches(start)) return start;
    }
    return -1;
}

/** Apply every hunk to `content` in order, or throw naming the hunk that does not fit. */
export function applyHunks(content: string, hunks: readonly PatchHunk[], path: string): string {
    const text = splitText(content);
    let cursor = 0;
    hunks.forEach((hunk, index) => {
        const label = `hunk ${index + 1} of ${path}`;
        if (hunk.anchor !== undefined) {
            const found = seek(text.lines, [hunk.anchor], cursor, false);
            if (found < 0) throw new PatchError(`${label}: could not find the '@@ ${hunk.anchor}' line.`);
            cursor = found + 1;
        }
        const before = hunk.lines.filter((line) => line[0] !== "+").map((line) => line.slice(1));
        const after = hunk.lines.filter((line) => line[0] !== "-").map((line) => line.slice(1));
        let start: number;
        if (!before.length) {
            // Pure insertion: after the anchor, or at the end of the file.
            start = hunk.anchor !== undefined && !hunk.endOfFile ? cursor : text.lines.length;
        } else {
            start = seek(text.lines, before, cursor, hunk.endOfFile);
            if (start < 0) {
                const preview = before.slice(0, 3).join("\\n");
                throw new PatchError(`${label}: the context/removed lines were not found${hunk.endOfFile ? " at the end of the file" : ""} (starting "${preview.slice(0, 120)}").`);
            }
        }
        text.lines.splice(start, before.length, ...after);
        cursor = start + after.length;
    });
    if (!content.length && text.lines.length) text.finalNewline = true;
    return joinText(text);
}

// ---- planning and applying --------------------------------------------------

/** The guarded operations the tool is allowed to use. Nothing else touches the disk. */
export interface PatchFileOperations {
    /** Rejects with code ENOENT when the file does not exist. */
    readFile(path: string): Promise<Buffer>;
    writeFile(path: string, content: string): Promise<void>;
    mkdir(path: string): Promise<void>;
    remove(path: string): Promise<void>;
    /** Policy pre-checks without I/O: throw the refusal the operation itself would. */
    checkWrite(path: string): void;
    checkRemove(path: string): void;
}

type FileState = { original: string | null; current: string | null };
type Step = { kind: "write" | "remove"; path: string; original: string | null; content?: string };

export interface ApplyPatchResult {
    summary: string;
    changes: { kind: "add" | "update" | "delete" | "move"; path: string; moveTo?: string }[];
}

function stripPathQuotes(path: string): string {
    const quoted = /^(["'`]).*\1$/.test(path) ? path.slice(1, -1) : path;
    return quoted.startsWith("@") ? quoted.slice(1) : quoted;
}

export function resolvePatchPath(cwd: string, path: string): string {
    const cleaned = stripPathQuotes(path.trim());
    return isAbsolute(cleaned) ? resolve(cleaned) : resolve(cwd, cleaned);
}

function describe(action: PatchAction): string {
    if (action.kind === "add") return `add ${action.path}`;
    if (action.kind === "delete") return `delete ${action.path}`;
    return action.moveTo ? `update ${action.path} → ${action.moveTo}` : `update ${action.path}`;
}

/**
 * Validate the whole patch against the guarded operations and current files,
 * then write it. Throws a PatchError before any write when anything is wrong.
 */
export async function applyPatch(input: string, cwd: string, ops: PatchFileOperations): Promise<ApplyPatchResult> {
    const actions = parsePatch(input);
    const files = new Map<string, FileState>();
    const load = async (path: string): Promise<FileState> => {
        let state = files.get(path);
        if (state) return state;
        let original: string | null;
        try {
            original = (await ops.readFile(path)).toString("utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            original = null;
        }
        state = { original, current: original };
        files.set(path, state);
        return state;
    };
    const fail = (action: PatchAction, error: unknown): never => {
        const message = error instanceof Error ? error.message : String(error);
        throw new PatchError(`apply_patch rejected (${describe(action)}): ${message} Nothing was changed.`);
    };

    // 1. Validate everything. No write happens in this phase.
    for (const action of actions) {
        try {
            const path = resolvePatchPath(cwd, action.path);
            if (action.kind === "add") {
                ops.checkWrite(path);
                const state = await load(path);
                state.current = action.lines.length ? action.lines.join("\n") + "\n" : "";
            } else if (action.kind === "delete") {
                ops.checkRemove(path);
                const state = await load(path);
                if (state.current === null) throw new PatchError(`${action.path} does not exist.`);
                state.current = null;
            } else {
                ops.checkWrite(path);
                const state = await load(path);
                if (state.current === null) throw new PatchError(`${action.path} does not exist.`);
                const updated = action.hunks.length ? applyHunks(state.current, action.hunks, action.path) : state.current;
                const destination = action.moveTo ? resolvePatchPath(cwd, action.moveTo) : path;
                if (destination === path) {
                    state.current = updated;
                } else {
                    ops.checkRemove(path);
                    ops.checkWrite(destination);
                    const target = await load(destination);
                    target.current = updated;
                    state.current = null;
                }
            }
        } catch (error) {
            fail(action, error);
        }
    }

    // 2. Write whole files first, removals last: a failure part-way then leaves
    // extra files behind rather than losing content.
    const steps: Step[] = [];
    for (const [path, state] of files) {
        if (state.current === state.original) continue;
        if (state.current !== null) steps.push({ kind: "write", path, original: state.original, content: state.current });
    }
    for (const [path, state] of files) {
        if (state.current === null && state.original !== null) steps.push({ kind: "remove", path, original: state.original });
    }
    const done: Step[] = [];
    try {
        for (const step of steps) {
            if (step.kind === "write") {
                if (step.original === null) await ops.mkdir(dirname(step.path));
                await ops.writeFile(step.path, step.content!);
            } else {
                await ops.remove(step.path);
            }
            done.push(step);
        }
    } catch (error) {
        const failed = steps[done.length]!;
        const restored: string[] = [];
        const left: string[] = [];
        for (const step of [...done].reverse()) {
            try {
                if (step.original === null) await ops.remove(step.path);
                else await ops.writeFile(step.path, step.original);
                restored.push(step.path);
            } catch (undo) {
                left.push(`${step.kind === "write" ? (step.original === null ? "created" : "rewrote") : "removed"} ${step.path} (${undo instanceof Error ? undo.message : String(undo)})`);
            }
        }
        const pending = steps.slice(done.length + 1).map((step) => `${step.kind} ${step.path}`);
        throw new PatchError([
            `apply_patch failed to ${failed.kind} ${failed.path}: ${error instanceof Error ? error.message : String(error)}`,
            `Applied then restored: ${restored.join(", ") || "none"}.`,
            `Still applied (could not restore): ${left.join("; ") || "none"}.`,
            `Not applied: ${[`${failed.kind} ${failed.path}`, ...pending].join(", ")}.`,
        ].join("\n"));
    }

    const changes = actions.map((action) => action.kind === "update" && action.moveTo
        ? { kind: "move" as const, path: action.path, moveTo: action.moveTo }
        : { kind: action.kind, path: action.path });
    return { summary: `Applied patch: ${actions.map(describe).join(", ")}.`, changes };
}

// ---- tool definition --------------------------------------------------------

export const APPLY_PATCH_TOOL = "apply_patch";

/** Same schema as the Codex tool: one `input` string. */
export const applyPatchParameters = {
    type: "object",
    additionalProperties: false,
    properties: {
        input: { type: "string", description: "Codex apply_patch text beginning with *** Begin Patch and ending with *** End Patch." },
    },
    required: ["input"],
} as const;

/** Every path a patch reads or changes, for serializing with other file tools. */
export function patchTargets(input: string, cwd: string): string[] {
    const paths = new Set<string>();
    for (const action of parsePatch(input)) {
        paths.add(resolvePatchPath(cwd, action.path));
        if (action.kind === "update" && action.moveTo) paths.add(resolvePatchPath(cwd, action.moveTo));
    }
    return [...paths].sort();
}

type MutationQueue = <T>(path: string, fn: () => Promise<T>) => Promise<T>;

export function createApplyPatchToolDefinition(cwd: string, ops: PatchFileOperations, queue?: MutationQueue) {
    return {
        name: APPLY_PATCH_TOOL,
        label: "Apply Patch",
        description: "Apply a Codex-style patch (*** Begin Patch … *** End Patch) with Add File, Update File (optionally *** Move to), and Delete File operations. " +
            "Paths are relative to the working directory. The patch follows the same sandbox file rules as write and edit, is validated in full before anything is written, and never leaves a file half-patched.",
        promptSnippet: "Apply Codex-style multi-file patches using the input argument.",
        promptGuidelines: ["Use apply_patch for multi-file or multi-hunk edits when a Codex-style patch is clearer than separate edit/write calls."],
        parameters: applyPatchParameters,
        async execute(_toolCallId: string, params: { input?: unknown }) {
            if (!params || typeof params.input !== "string") throw new PatchError("apply_patch requires an `input` string.");
            const input = params.input;
            // Hold every target's mutation slot so a parallel edit/write cannot interleave.
            const run = (targets: string[]): Promise<ApplyPatchResult> => queue && targets.length
                ? queue(targets[0]!, () => run(targets.slice(1)))
                : applyPatch(input, cwd, ops);
            const result = await run(patchTargets(input, cwd));
            return { content: [{ type: "text" as const, text: `${result.summary}\nFiles changed: ${result.changes.length}` }], details: result };
        },
    };
}
