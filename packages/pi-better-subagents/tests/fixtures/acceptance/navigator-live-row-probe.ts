/**
 * Acceptance-only extension. It does not register a product command.
 * After the subagent extension publishes its registered spawn tool and
 * navigator provider, this calls that tool with the live Pi context, reads
 * the provider list while the child is running, then stops and reads the result.
 */
import { writeFileSync } from "node:fs";
import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HOOKS = Symbol.for("pi-better-subagents.acceptance-hooks");

type Row = {
    id: string;
    name?: string;
    model?: string;
    effort?: string;
    status: string;
    primary?: string;
};

type Hooks = {
    subagentSpawn?: { execute: (id: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: undefined, ctx: ExtensionContext) => Promise<unknown> };
    subagentStop?: { execute: (id: string, params: { id: string }) => Promise<unknown> };
    subagentResult?: { execute: (id: string, params: { id: string }) => Promise<unknown> };
    listRows?: () => Row[];
    renderDetail?: (id: string, width?: number) => unknown;
};

function textOf(value: unknown): string {
    const content = (value as { content?: Array<{ text?: string }> } | undefined)?.content;
    if (!Array.isArray(content)) return "";
    return content.map((block) => block.text ?? "").join("\n");
}

function runIdFrom(text: string): string | undefined {
    return text.match(/\bid=(sa_\S+)/)?.[1];
}

export default function navigatorLiveRowProbe(pi: ExtensionAPI) {
    void pi;
    pi.on("session_start", async (_event, ctx) => {
        const out = process.env.PI_ACCEPTANCE_NAV_OUT;
        const phase = process.env.PI_ACCEPTANCE_NAV_PHASE;
        const agentId = process.env.PI_ACCEPTANCE_AGENT_ID || "agent.live-row";
        const evidence: Record<string, unknown> = {
            agentId,
            mode: ctx.mode,
            hasUI: ctx.hasUI,
            cwd: ctx.cwd,
            parentPid: process.pid,
            error: null,
        };
        const write = (target: string | undefined, value: unknown) => {
            if (target) writeFileSync(target, JSON.stringify(value));
        };
        try {
            let hooks = (globalThis as typeof globalThis & Record<symbol, Hooks | undefined>)[HOOKS];
            for (let attempt = 0; !hooks?.subagentSpawn?.execute && attempt < 40; attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, 50));
                hooks = (globalThis as typeof globalThis & Record<symbol, Hooks | undefined>)[HOOKS];
            }
            if (!hooks?.subagentSpawn?.execute || !hooks.listRows || !hooks.renderDetail || !hooks.subagentStop || !hooks.subagentResult) {
                throw new Error("registered spawn, list, detail, stop, or result hook was not published");
            }
            const spawned = await hooks.subagentSpawn.execute("acceptance-live-row", {
                prompt: "Reply with the single word DONE.",
                agent: agentId,
                sandbox: false,
                callback: false,
                clean: true,
                approve: true,
            }, undefined, undefined, ctx);
            evidence.spawn = spawned;
            const spawnText = textOf(spawned);
            evidence.spawnText = spawnText;
            const spawnedId = runIdFrom(spawnText);
            let row: Row | undefined;
            for (let attempt = 0; attempt < 40; attempt += 1) {
                const rows = hooks.listRows();
                row = rows.find((item) => item.status === "running" && (item.id === spawnedId || item.name === "Live Row Agent"));
                if (row) {
                    evidence.providerRowsWhileRunning = rows;
                    evidence.liveRow = row;
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 200));
            }
            if (!row) {
                evidence.providerRowsWhileRunning = hooks.listRows();
                throw new Error(`no running named-agent row after spawn. spawn=${spawnText}`);
            }
            try { (ctx.ui as { requestRender?: () => void }).requestRender?.(); } catch { /* the TUI paints on its own tick */ }
            write(phase, { phase: "running", id: row.id, at: Date.now() });
            await new Promise((resolve) => setTimeout(resolve, 2500));
            const still = hooks.listRows().find((item) => item.id === row!.id);
            evidence.providerRowsAfterPaint = hooks.listRows();
            evidence.stillRunning = still?.status === "running";
            evidence.liveRow = still ?? row;
            if (still?.status !== "running") {
                throw new Error(`named-agent row ${row.id} left running before the list could be read (${still?.status ?? "missing"})`);
            }
            evidence.navigator = hooks.renderDetail(row.id, 100);
            evidence.stopped = await hooks.subagentStop.execute("acceptance-live-row-stop", { id: row.id });
            evidence.result = await hooks.subagentResult.execute("acceptance-live-row-result", { id: row.id });
        } catch (error) {
            evidence.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        }
        write(out, evidence);
        setTimeout(() => {
            try { ctx.shutdown(); } catch { /* the pty driver kills the process */ }
        }, 1200);
    });
}
