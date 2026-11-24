import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
export function openSupervisorClient(cwd: string, sessionId: string, signal: AbortSignal): Promise<{
    close(): void;
    decision(action: string, scope: Record<string, string>, token?: string, answer?: string): Promise<{
        status: string; token?: string; workspace?: string; expires?: number; timeoutMs?: number; durationMinutes?: number;
    }>;
    sharedReadDiagnosis(): Promise<{ status: string; incident?: { id: string; recommendation: string } }>;
    review(scenario: string, action: "begin" | "finish" | "release", token?: string): Promise<{ status: string; token?: string }>;
    role(pi: ExtensionAPI, ctx: ExtensionContext): Promise<{ revision: string; instructions: string; model?: string | null; effort?: ThinkingLevel | "off" | null } | undefined>;
}>;
