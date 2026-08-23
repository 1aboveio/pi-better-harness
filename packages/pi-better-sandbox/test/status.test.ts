import assert from "node:assert/strict";
import test from "node:test";

import { footerTone, formatFooterStatus, formatSandboxReport } from "../status.ts";
import type { ForegroundSandboxStatus } from "../state.ts";

function status(overrides: Partial<ForegroundSandboxStatus> = {}): ForegroundSandboxStatus {
    return {
        state: "enabled",
        projectRoot: "/work/acme-api",
        writableRoot: "/work/acme-api",
        denyWrite: ["/work/acme-api/.env"],
        platform: "darwin",
        backend: "macos-seatbelt",
        executable: "/usr/bin/sandbox-exec",
        readPolicy: "unrestricted",
        networkPolicy: "unrestricted",
        reason: "Writes are confined.",
        ...overrides,
    };
}

test("the footer names the project only while protection is actually active", () => {
    assert.equal(formatFooterStatus(status()), "sandbox · on · acme-api");
    assert.equal(formatFooterStatus(status({ state: "disabled" })), "sandbox · OFF");
    assert.equal(formatFooterStatus(status({ state: "unavailable" })), "sandbox · UNAVAILABLE");
    assert.equal(formatFooterStatus(status({ state: "failed" })), "sandbox · FAILED");
});

test("every state that is not enabled is painted for attention", () => {
    assert.equal(footerTone(status()), "accent");
    assert.equal(footerTone(status({ state: "unavailable" })), "warning");
    assert.equal(footerTone(status({ state: "disabled" })), "error");
    assert.equal(footerTone(status({ state: "failed" })), "error");
});

test("the footer applies the caller's styling", () => {
    const painted = formatFooterStatus(status(), (tone, text) => `<${tone}>${text}</${tone}>`);
    assert.equal(painted, "<accent>sandbox · on · acme-api</accent>");
});

test("the report never presents intent as enforcement when no backend resolved", () => {
    const report = formatSandboxReport(
        status({
            state: "unavailable",
            writableRoot: undefined,
            backend: undefined,
            executable: undefined,
            reason: "Linux sandbox requires executable bubblewrap (bwrap) on PATH.",
        }),
    );

    assert.match(report, /Foreground sandbox: UNAVAILABLE/);
    assert.match(report, /Writable root: \(none while not enabled\)/);
    assert.match(report, /Backend: +\(none resolved\)/);
    assert.match(report, /Executable: +\(none resolved\)/);
});

test("the report lists the effective policy and states what is not confined", () => {
    const report = formatSandboxReport(status());

    assert.match(report, /Project root: +\/work\/acme-api/);
    assert.match(report, /Reads: +unrestricted \(every filesystem path\)/);
    assert.match(report, /Network: +unrestricted/);
    assert.match(report, /Backend: +macos-seatbelt/);
    assert.match(report, /\/work\/acme-api\/\.env/);
    assert.match(report, /Confined: the built-in bash tool and user-entered ! \/ !! commands\./);
    assert.match(report, /Not confined: pi's own process, pi\.exec calls/);
});

test("a project with no denied paths says so rather than showing an empty list", () => {
    assert.match(formatSandboxReport(status({ denyWrite: [] })), /Write-denied paths:\n {2}\(none\)/);
});
