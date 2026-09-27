/**
 * Child-side harness control: deliver a parent steer into the running child session.
 *
 * Loaded into every subagent child (`--extension`) by the parent. It registers no
 * tools and performs no command I/O. The parent writes a request file (path in
 * PI_SUBAGENT_STEER_FILE) under the run directory; this extension polls it and
 * hands the text to Pi's own steering queue (`sendUserMessage` with
 * `deliverAs: "steer"`), which the agent loop reads after the current tool call
 * finishes. It then writes a typed marker line to the child's JSON event stream
 * so the parent can see the steer was delivered.
 *
 * Each request id is delivered at most once per child process, and only while
 * the agent is working: an idle print-mode child is about to exit, and a new
 * prompt there would start work instead of steering it.
 */
import { readFileSync } from "node:fs";

export const STEER_FILE_ENV = "PI_SUBAGENT_STEER_FILE";
const POLL_MS = 2_000;

type SteerApi = {
    on(event: string, handler: (event: unknown, ctx: { isIdle?: () => boolean }) => unknown): void;
    sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void;
};

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
    let timer: ReturnType<typeof setInterval> | undefined;
    let isIdle: (() => boolean) | undefined;
    const check = () => {
        const request = readSteerRequest(path);
        if (!request || delivered.has(request.id)) return;
        try { if (isIdle?.() === true) return; } catch { return; }
        delivered.add(request.id);
        try {
            pi.sendUserMessage(request.text, { deliverAs: "steer" });
            process.stdout.write(`${JSON.stringify({ type: "subagent_steer_delivered", id: request.id, at: Date.now() })}\n`);
        } catch {
            delivered.delete(request.id);
        }
    };
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
