/**
 * Acceptance-only extension. It does not register a product command.
 * After the subagent extension's session_start publishes its registered
 * tool and navigator renderer, this writes their output and exits.
 */
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HOOKS = Symbol.for("pi-better-subagents.acceptance-hooks");

type Hooks = {
    subagentResult?: { execute: (toolCallId: string, params: { id: string }) => Promise<unknown> };
    renderDetail?: (id: string, width?: number) => unknown;
};

export default function navigatorReloadProbe(pi: ExtensionAPI) {
    pi.on("session_start", async (_event, ctx) => {
        const out = process.env.PI_ACCEPTANCE_NAV_OUT;
        const id = process.env.PI_ACCEPTANCE_RUN_ID || "sa_muff44v8_1";
        const evidence: Record<string, unknown> = {
            runId: id,
            mode: ctx.mode,
            hasUI: ctx.hasUI,
            cwd: ctx.cwd,
            sessionId: undefined,
            error: null,
        };
        try {
            evidence.sessionId = ctx.sessionManager?.getSessionId?.() ?? null;
        } catch {
            evidence.sessionId = null;
        }
        try {
            let hooks = (globalThis as typeof globalThis & Record<symbol, Hooks | undefined>)[HOOKS];
            for (let attempt = 0; !hooks?.renderDetail && attempt < 40; attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, 50));
                hooks = (globalThis as typeof globalThis & Record<symbol, Hooks | undefined>)[HOOKS];
            }
            if (!hooks?.renderDetail || !hooks.subagentResult) {
                throw new Error("registered navigator/result hooks were not published");
            }
            evidence.navigator = hooks.renderDetail(id, 100);
            evidence.result = await hooks.subagentResult.execute("acceptance-reload", { id });
        } catch (error) {
            evidence.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        }
        if (out) writeFileSync(out, JSON.stringify(evidence));
        setTimeout(() => {
            try { ctx.shutdown(); } catch { /* the pty driver kills the process */ }
        }, 1200);
    });
}
