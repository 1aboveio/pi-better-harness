/**
 * Guarded direct application execution.
 *
 * `run_application` starts one executable with a literal argument list through
 * the same confined executor as bash: no shell parses the arguments, the task
 * environment and scratch directory apply, and cancellation, timeouts and the
 * process group behave identically. The profile's commands switch gates it like
 * any other command path, and while Shell scripts is Off a shell interpreter is
 * refused by requested and resolved identity. Descendants of an application can
 * still start a shell: this is an interface restriction, not an OS exec deny.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
const { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } = PiCodingAgent;
import { validateTimeout, type TaskExec } from "./exec.ts";

export const RUN_APPLICATION_TOOL = "run_application";

const MAX_EXECUTABLE_CHARS = 4096;
const MAX_ARGS = 1024;
const MAX_ARG_CHARS = 131_072;
const UPDATE_THROTTLE_MS = 100;

const parameters = {
    type: "object",
    additionalProperties: false,
    properties: {
        executable: {
            type: "string", minLength: 1, maxLength: MAX_EXECUTABLE_CHARS,
            description: "Executable name or absolute path. Started directly, never through a shell.",
        },
        args: {
            type: "array", items: { type: "string", maxLength: MAX_ARG_CHARS }, maxItems: MAX_ARGS,
            description: "Literal arguments, passed verbatim. No quoting, expansion, globbing, pipes or redirects.",
        },
        timeout: {
            type: "number",
            description: "Timeout in seconds (optional). The sandbox command time limit still applies.",
        },
    },
    required: ["executable"],
} as const;

export interface RunApplicationParams {
    executable: string;
    args: string[];
    timeout: number | undefined;
}

export function validateRunApplicationParams(params: unknown): RunApplicationParams {
    if (!params || typeof params !== "object" || Array.isArray(params) ||
        Reflect.ownKeys(params).some((key) => key !== "executable" && key !== "args" && key !== "timeout")) {
        throw new Error("run_application accepts only executable, args, and timeout.");
    }
    // Models send optional fields as explicit null; null means "not declared".
    const { executable, args: declaredArgs, timeout: declaredTimeout } =
        params as { executable?: unknown; args?: unknown; timeout?: unknown };
    const args = declaredArgs ?? undefined;
    const timeout = declaredTimeout ?? undefined;
    if (typeof executable !== "string" || !executable.trim() || executable.length > MAX_EXECUTABLE_CHARS ||
        executable.includes("\u0000")) {
        throw new Error(`run_application executable must be a non-empty string of at most ${MAX_EXECUTABLE_CHARS} characters.`);
    }
    if (args !== undefined && (!Array.isArray(args) || args.length > MAX_ARGS ||
        args.some((arg) => typeof arg !== "string" || arg.includes("\u0000") || arg.length > MAX_ARG_CHARS))) {
        throw new Error(`run_application args must be an array of at most ${MAX_ARGS} strings, each at most ${MAX_ARG_CHARS} characters.`);
    }
    if (timeout !== undefined && typeof timeout !== "number") {
        throw new Error("Invalid timeout: must be a positive, supported number of seconds");
    }
    validateTimeout(timeout as number | undefined);
    return { executable, args: (args as string[] | undefined) ?? [], timeout: timeout as number | undefined };
}

type OutputSnapshot = { content: string; truncation: any; fullOutputPath?: string };

export function createRunApplicationToolDefinition(cwd: string, run: TaskExec) {
    return {
        name: RUN_APPLICATION_TOOL,
        label: "Run application",
        description: `Run one executable directly with a literal argument list. No shell parses the arguments, so pipes, redirects, globs, variables and quoting are not interpreted. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first); if truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
        promptSnippet: "Run an executable directly with literal arguments (no shell parsing).",
        parameters,
        async execute(_toolCallId: string, params: unknown, signal?: AbortSignal,
            onUpdate?: (update: { content: { type: "text"; text: string }[]; details?: unknown }) => void) {
            const { executable, args, timeout } = validateRunApplicationParams(params);
            const { OutputAccumulator } = await import(pathToFileURL(
                join(PiCodingAgent.getPackageDir(), "dist", "core", "tools", "output-accumulator.js")).href);
            const output = new OutputAccumulator({ tempFilePrefix: "pi-run-application" });
            let acceptingOutput = true;
            let updateTimer: NodeJS.Timeout | undefined;
            let updateDirty = false;
            let lastUpdateAt = 0;
            const emitOutputUpdate = () => {
                if (!onUpdate || !updateDirty) return;
                updateDirty = false;
                lastUpdateAt = Date.now();
                const snapshot = output.snapshot({ persistIfTruncated: true });
                onUpdate({
                    content: [{ type: "text", text: snapshot.content || "" }],
                    details: {
                        truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
                        fullOutputPath: snapshot.fullOutputPath,
                    },
                });
            };
            const scheduleOutputUpdate = () => {
                if (!onUpdate) return;
                updateDirty = true;
                const delay = UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
                if (delay <= 0) {
                    if (updateTimer) { clearTimeout(updateTimer); updateTimer = undefined; }
                    emitOutputUpdate();
                    return;
                }
                updateTimer ??= setTimeout(() => { updateTimer = undefined; emitOutputUpdate(); }, delay);
            };
            onUpdate?.({ content: [], details: undefined });
            const handleData = (data: Buffer) => {
                if (!acceptingOutput) return;
                output.append(data);
                scheduleOutputUpdate();
            };
            let finishing: Promise<OutputSnapshot> | undefined;
            const finishOutput = () => finishing ??= (async () => {
                acceptingOutput = false;
                output.finish();
                if (updateTimer) { clearTimeout(updateTimer); updateTimer = undefined; }
                emitOutputUpdate();
                const snapshot = output.snapshot({ persistIfTruncated: true });
                await output.closeTempFile();
                return snapshot as OutputSnapshot;
            })();
            const formatOutput = (snapshot: OutputSnapshot, emptyText = "(no output)") => {
                const truncation = snapshot.truncation;
                let text = snapshot.content || emptyText;
                let details;
                if (truncation.truncated) {
                    details = { truncation, fullOutputPath: snapshot.fullOutputPath };
                    const startLine = truncation.totalLines - truncation.outputLines + 1;
                    const endLine = truncation.totalLines;
                    if (truncation.lastLinePartial) {
                        const lastLineSize = formatSize(output.getLastLineBytes());
                        text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
                    } else if (truncation.truncatedBy === "lines") {
                        text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
                    } else {
                        text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
                    }
                }
                return { text, details };
            };
            const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;
            try {
                let exitCode: number | null;
                try {
                    const result = await run({ kind: "argv", execPath: executable, execArgs: args }, cwd,
                        { onData: handleData, signal, timeout });
                    exitCode = result.exitCode;
                } catch (error) {
                    const snapshot = await finishOutput();
                    const { text } = formatOutput(snapshot, "");
                    if (error instanceof Error && error.message === "aborted") {
                        throw new Error(appendStatus(text, "Command aborted"));
                    }
                    if (error instanceof Error && error.message.startsWith("timeout:")) {
                        const timeoutSeconds = error.message.split(":")[1];
                        throw new Error(appendStatus(text, `Command timed out after ${timeoutSeconds} seconds`));
                    }
                    throw error;
                }
                const snapshot = await finishOutput();
                const { text, details } = formatOutput(snapshot);
                if (exitCode !== 0 && exitCode !== null) {
                    throw new Error(appendStatus(text, `Command exited with code ${exitCode}`));
                }
                return { content: [{ type: "text" as const, text }], details: { ...details, exitCode } };
            } finally {
                if (updateTimer) { clearTimeout(updateTimer); updateTimer = undefined; }
            }
        },
    };
}
