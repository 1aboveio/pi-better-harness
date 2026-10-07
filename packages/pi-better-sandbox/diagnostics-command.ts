import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { diagnosticsEnabled, exportDiagnostics, formatDiagnosticsSummary, readDiagnostics, setDiagnosticsEnabled } from "./shared-sandbox-diagnostics.ts";

export const DIAGNOSTICS_ACTIONS = ["status", "on", "off", "summary", "export"] as const;

export async function handleDiagnosticsCommand(argument: string, ctx: ExtensionCommandContext): Promise<void> {
    const action = argument.trim().toLowerCase() || "status";
    try {
        if (action === "on" || action === "off") {
            setDiagnosticsEnabled(action === "on");
            ctx.ui.notify(action === "on"
                ? "Sandbox diagnostics enabled. Redacted observations stay on this machine; nothing is uploaded."
                : "Sandbox diagnostics disabled. Existing observations are retained locally.", "info");
        } else if (action === "status") {
            ctx.ui.notify(`Sandbox diagnostics: ${diagnosticsEnabled() ? "On" : "Off"}. Local-only, redacted collection.\n` +
                formatDiagnosticsSummary(readDiagnostics()), "info");
        } else if (action === "summary") {
            ctx.ui.notify(formatDiagnosticsSummary(readDiagnostics()), "info");
        } else if (action === "export") {
            ctx.ui.notify(`Redacted sandbox diagnostics exported to ${exportDiagnostics()}. Nothing was uploaded.`, "info");
        } else {
            ctx.ui.notify("Usage: /sandbox diagnostics [status|on|off|summary|export]", "error");
        }
    } catch {
        ctx.ui.notify("Sandbox diagnostics could not be read or saved. Collection may have a gap; enforcement is unchanged.", "error");
    }
}