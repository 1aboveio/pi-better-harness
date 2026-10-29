import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parse } from "shell-quote";
import { STEER_FILE_ENV } from "./child-steer.ts";

export const WORKER_HANDOFF = "Worker ownership: complete your assigned implementation or diagnosis, run focused checks, push only when authorized, write the requested result, then return. Pending CI is a handoff, not a failed implementation or a CI pass. The coordinator owns CI/PR monitoring, review scheduling, readiness, enqueueing and merge. Do not start external delivery watchers or background monitoring. Short status reads and failed-log retrieval for diagnosis are allowed. Legitimate local tests and builds may run to completion within their command limits.";
const REFUSAL = "Worker ownership: CI/PR monitoring belongs to the coordinator. Return the PR/run ID, pushed HEAD and current evidence with CI pending; do not retry the watcher through another tool or script. Local tests/builds and short diagnostic status/log reads remain allowed.";
const WATCH_SCRIPTS = new Set(["watch-pr-delivery.mjs", "watch-delivery.mjs", "watch-candidate-delivery.mjs"]);
const nameOf = (value: string) => value.replaceAll("\\", "/").split("/").at(-1)!.replace(/\.exe$/i, "");

// Preserve command boundaries without treating multiline strings or heredoc data as commands.
function commandLines(command: string): string[] {
    const lines: string[] = [];
    const documents: { delimiter: string; tabs: boolean }[] = [];
    let quote = "", escaped = false, out = "";
    for (const line of command.split("\n")) {
        if (documents.length) {
            const document = documents[0]!;
            if ((document.tabs ? line.replace(/^\t+/, "") : line) === document.delimiter) documents.shift();
            continue;
        }
        let comment = false;
        for (const char of `${line}\n`) {
            if (!quote && !escaped && char === "#" && (!out || /[\s;&|()<>]$/.test(out))) comment = true;
            if (comment && char !== "\n") continue;
            if (escaped) { out += char === "\n" ? "" : `\\${char}`; escaped = false; continue; }
            if (char === "\\" && quote !== "'") { escaped = true; continue; }
            if (char === quote) quote = "";
            else if (!quote && (char === "'" || char === '"')) quote = char;
            if (char !== "\n" || quote) { out += char; continue; }
            lines.push(out);
            try {
                const tokens = parse(out);
                for (let i = 0; i < tokens.length; i++) {
                    const token = tokens[i], delimiter = tokens[i + 1];
                    if (typeof token === "object" && "op" in token && ["<<", "<<-"].includes(token.op) && typeof delimiter === "string") {
                        documents.push({ delimiter, tabs: token.op === "<<-" });
                    }
                }
            } catch { /* The command tool, not this operational guard, validates shell syntax. */ }
            out = "";
        }
    }
    if (out) lines.push(out);
    return lines;
}

function shellWatcher(command: string, depth: number): boolean {
    if (depth > 3) return false;
    let tokens;
    try { tokens = commandLines(command).flatMap((line) => [...parse(line), { op: ";" as const }]); } catch { return false; }
    let words: string[] = [];
    let redirect = false;
    for (const token of tokens) {
        if (typeof token === "string" || ("op" in token && token.op === "glob")) {
            if (redirect) { redirect = false; continue; }
            words.push(typeof token === "string" ? token : token.pattern);
        } else if ("op" in token && ["<", ">", ">>", ">&", "<&", ">|", "<>", "&>", "&>>", "<<", "<<-", "<<<"].includes(token.op)) {
            if (words.length === 1 && /^\d+$/.test(words[0]!)) words = [];
            redirect = true;
        } else {
            if (argvWatcher(words, depth + 1)) return true;
            words = [];
            redirect = false;
        }
    }
    return argvWatcher(words, depth + 1);
}

function argvWatcher(input: readonly string[], depth = 0): boolean {
    if (depth > 4) return false;
    let words = [...input];
    while (/^[A-Za-z_][A-Za-z_0-9]*=/.test(words[0] ?? "")) words.shift();
    if (nameOf(words[0] ?? "") === "env") {
        words.shift();
        while (words.length) {
            if (["-u", "--unset", "-C", "--chdir"].includes(words[0]!)) words.splice(0, 2);
            else if (words[0] === "--" || words[0]!.startsWith("-") || /^[A-Za-z_][A-Za-z_0-9]*=/.test(words[0]!)) words.shift();
            else break;
        }
    }
    const program = nameOf(words.shift() ?? "");
    if (["bash", "sh", "zsh", "dash"].includes(program)) {
        const at = words.findIndex((word) => /^-[^-]*c/.test(word));
        return at >= 0 && typeof words[at + 1] === "string" && shellWatcher(words[at + 1]!, depth + 1);
    }
    if (words.includes("--help") || words.includes("-h")) return false;
    if (program === "gh") {
        while (words.length) {
            if (["--repo", "-R", "--hostname"].includes(words[0]!)) words.splice(0, 2);
            else if (/^(?:--repo=.+|--hostname=.+|-R.+)$/.test(words[0]!)) words.shift();
            else break;
        }
        return (words[0] === "run" && words[1] === "watch") ||
            (words[0] === "pr" && words[1] === "checks" && words.slice(2).some((word) => ["--watch", "--watch=true"].includes(word)));
    }
    if (WATCH_SCRIPTS.has(program)) return true;
    if (program === "node" || program === "nodejs") {
        while (words[0]?.startsWith("-")) {
            if (["-e", "--eval", "-p", "--print"].includes(words[0])) return false;
            const takesValue = ["--import", "--loader", "--require", "-r"].includes(words[0]);
            words.splice(0, takesValue ? 2 : 1);
        }
        return WATCH_SCRIPTS.has(nameOf(words[0] ?? ""));
    }
    return false;
}

/** Recognizes supported watcher entrypoints, not arbitrary program semantics or a security boundary. */
export function workerMonitoringRefusal(toolName: string, input: unknown): string | undefined {
    if (!input || typeof input !== "object") return;
    const value = input as Record<string, unknown>;
    const argv = toolName === "run_application" && typeof value.executable === "string" &&
        (value.args === undefined || (Array.isArray(value.args) && value.args.every((arg) => typeof arg === "string")))
        ? [value.executable, ...((value.args ?? []) as string[])] : undefined;
    if (argv && argvWatcher(argv)) return REFUSAL;
    if (["bash", "remote_bash", "bg_task", "bg_task_spawn", "bg_task_watch"].includes(toolName)) {
        if (typeof value.command === "string" && shellWatcher(value.command, 0)) return REFUSAL;
        if (Array.isArray(value.argv) && value.argv.every((arg) => typeof arg === "string") && argvWatcher(value.argv)) return REFUSAL;
    }
}

export default function childOwnership(pi: Pick<ExtensionAPI, "on">, env: NodeJS.ProcessEnv = process.env): void {
    // This marker is supplied by the parent on every child launch, including clean/unsandboxed runs.
    if (!env[STEER_FILE_ENV]) return;
    pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${WORKER_HANDOFF}` }));
    pi.on("tool_call", (event) => {
        const reason = workerMonitoringRefusal(event.toolName, event.input);
        if (reason) return { block: true, reason };
    });
}
