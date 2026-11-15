/**
 * Child-side harness control: deliver a parent steer into the running child session.
 *
 * Loaded into every subagent child (`--extension`) by the parent. It registers no
 * tools and performs no command I/O. The parent writes a request file (path in
 * PI_SUBAGENT_STEER_FILE) under the run directory; this extension polls it and
 * hands the text to Pi's own steering queue (`sendUserMessage` with
 * `deliverAs: "steer"`), which the agent loop reads after the current tool call
 * finishes. When the steer actually enters the conversation (its user
 * `message_end`), it writes a receipt file next to the request, so the parent
 * can start the grace period from real delivery rather than from the moment the
 * steer was queued behind a long tool call. A file, not a log line: in print
 * mode an extension's stdout writes are not flushed to the log until exit.
 * This extension runs in the trusted Pi process; the child's confined tools
 * cannot write the run directory, so they cannot forge a receipt.
 *
 * Each request id is delivered at most once per child process, and only while
 * the agent is working: an idle print-mode child is about to exit, and a new
 * prompt there would start work instead of steering it.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export const STEER_FILE_ENV = "PI_SUBAGENT_STEER_FILE";
const POLL_MS = 2_000;

type SteerApi = {
    on(event: string, handler: (event: any, ctx: { isIdle?: () => boolean }) => unknown): void;
    sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void;
};

/** Where the child records that a steer entered its conversation. */
export function steerReceiptPath(requestPath: string): string {
    return `${requestPath}.delivered`;
}

export function readSteerReceipt(requestPath: string): { id: string; at: number } | undefined {
    try {
        const value = JSON.parse(readFileSync(steerReceiptPath(requestPath), "utf8")) as { id?: unknown; at?: unknown };
        return typeof value?.id === "string" && typeof value.at === "number" && Number.isFinite(value.at) ? { id: value.id, at: value.at } : undefined;
    } catch {
        return undefined;
    }
}

export function readSteerRequest(path: string): { id: string; text: string } | undefined {
    try {
        const value = JSON.parse(readFileSync(path, "utf8")) as { id?: unknown; text?: unknown };
        return typeof value?.id === "string" && typeof value.text === "string" && value.text.trim() !== ""
            ? { id: value.id, text: value.text }
            : undefined;
    } catch {
        return undefined;
    }
}

export default function childSteer(pi: SteerApi): void {
    const path = process.env[STEER_FILE_ENV];
    if (!path) return;
    const delivered = new Set<string>();
    /** Queued steer text → request id, until the steer shows up as a user message. */
    const queued = new Map<string, string>();
    let timer: ReturnType<typeof setInterval> | undefined;
    let isIdle: (() => boolean) | undefined;
    const check = () => {
        const request = readSteerRequest(path);
        if (!request || delivered.has(request.id)) return;
        try { if (isIdle?.() === true) return; } catch { return; }
        delivered.add(request.id);
        try {
            queued.set(request.text, request.id);
            pi.sendUserMessage(request.text, { deliverAs: "steer" });
        } catch {
            queued.delete(request.text);
            delivered.delete(request.id);
        }
    };
    pi.on("message_end", (event) => {
        const message = event?.message;
        if (message?.role !== "user" || queued.size === 0) return;
        const content = message.content;
        const text = typeof content === "string" ? content
            : Array.isArray(content) ? content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n") : "";
        const id = queued.get(text);
        if (id === undefined) return;
        queued.delete(text);
        try {
            const receipt = steerReceiptPath(path);
            writeFileSync(`${receipt}.tmp`, JSON.stringify({ id, at: Date.now() }));
            renameSync(`${receipt}.tmp`, receipt);
        } catch { /* the parent falls back to grace from the request */ }
    });
    pi.on("session_start", (_event, ctx) => {
        isIdle = typeof ctx?.isIdle === "function" ? () => ctx.isIdle!() : undefined;
        if (timer) clearInterval(timer);
        timer = setInterval(check, POLL_MS);
        timer.unref?.();
    });
    pi.on("session_shutdown", () => {
        if (timer) clearInterval(timer);
        timer = undefined;
    });
}
