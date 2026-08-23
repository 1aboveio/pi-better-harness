/**
 * How the effective sandbox status is shown to a human.
 *
 * Both surfaces read the same snapshot, so the footer chip and the `/sandbox`
 * report can never disagree, and neither can present configured intent as
 * active kernel enforcement: every line below is rendered from evidence the
 * controller collected at call time.
 */

import { basename } from "node:path";

import type { ForegroundSandboxStatus } from "./state.ts";

/** Emphasis for one piece of status text, mapped to a theme colour by the caller. */
export type StatusTone = "accent" | "warning" | "error";

/** Applies terminal styling. Defaults to plain text so the formatters stay testable. */
export type StatusPainter = (tone: StatusTone, text: string) => string;

const plain: StatusPainter = (_tone, text) => text;

/** The tone the footer uses for a given state. */
export function footerTone(status: ForegroundSandboxStatus): StatusTone {
    if (status.state === "enabled") return "accent";
    if (status.state === "unavailable") return "warning";
    return "error";
}

/**
 * The compact footer chip.
 *
 * `sandbox · on · <project>` when protection is active; anything else is
 * visually prominent, because the absence of protection is the surprising case.
 */
export function formatFooterStatus(
    status: ForegroundSandboxStatus,
    paint: StatusPainter = plain,
): string {
    const tone = footerTone(status);
    if (status.state === "enabled" && status.writableRoot !== undefined) {
        return paint(tone, `sandbox · on · ${basename(status.writableRoot)}`);
    }
    if (status.state === "disabled") return paint(tone, "sandbox · OFF");
    if (status.state === "unavailable") return paint(tone, "sandbox · UNAVAILABLE");
    return paint(tone, "sandbox · FAILED");
}

/** The full `/sandbox` report. */
export function formatSandboxReport(status: ForegroundSandboxStatus): string {
    const lines = [
        `Foreground sandbox: ${status.state.toUpperCase()}`,
        `  ${status.reason}`,
        "",
        `Project root:  ${status.projectRoot ?? "(not captured yet)"}`,
        `Writable root: ${status.writableRoot ?? "(none while not enabled)"}`,
        `Reads:         ${status.readPolicy} (every filesystem path)`,
        `Network:       ${status.networkPolicy}`,
        `Platform:      ${status.platform}`,
        `Backend:       ${status.backend ?? "(none resolved)"}`,
        `Executable:    ${status.executable ?? "(none resolved)"}`,
        "Write-denied paths:",
    ];
    if (status.denyWrite.length === 0) lines.push("  (none)");
    else for (const path of status.denyWrite) lines.push(`  ${path}`);

    lines.push(
        "",
        "Confined: the built-in bash tool and user-entered ! / !! commands.",
        "Not confined: pi's own process, pi.exec calls, and unrelated extension code.",
    );
    return lines.join("\n");
}
