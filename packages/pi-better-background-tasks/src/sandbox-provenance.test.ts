import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { backgroundProcessDiagnosticsAccess, FOREGROUND_SANDBOX_POLICY_CHANNEL, FOREGROUND_SANDBOX_POLICY_REQUEST_CHANNEL,
  resolveForegroundSandboxPlan, sandboxProvenance } from "./sandbox.js";

function publisher() {
  const events = new EventEmitter();
  const permissions = { enabled: false, commands: true, network: true, processAccess: "read", projectFiles: "read-write", outsideProject: "read", storedCredentials: "read" };
  let policy: Record<string, unknown> = { state: "disabled", denyWrite: [], reason: "off", permissions };
  events.on(FOREGROUND_SANDBOX_POLICY_REQUEST_CHANNEL, () => events.emit(FOREGROUND_SANDBOX_POLICY_CHANNEL, policy));
  return { pi: { events }, permissions, set(next: Record<string, unknown>) { policy = next; } };
}

describe("background sandbox provenance", () => {
  it("uses the independent Background tasks column and preserves the launch-time policy after settings change", () => {
    const h = publisher();
    h.set({ state: "disabled", permissions: h.permissions, background: { state: "enabled", writableRoot: "/tmp", denyWrite: [], reason: "on",
      permissions: { ...h.permissions, enabled: true, network: false } } });
    const plan = resolveForegroundSandboxPlan(h.pi);
    expect(plan).toMatchObject({ confined: true, permissions: { network: false } });
    h.set({ state: "disabled", permissions: h.permissions, background: { state: "disabled", denyWrite: [], reason: "off", permissions: h.permissions } });
    expect(resolveForegroundSandboxPlan(h.pi)).toEqual({ confined: false });
    expect(sandboxProvenance(plan)).toMatchObject({ confinement: "confined", policySource: "background", changesAffectTask: false });
    expect(sandboxProvenance(plan).policySummary).toContain("network=off");
  });

  it("does not silently fall back to Main for a malformed Background tasks policy", () => {
    const h = publisher();
    h.set({ state: "disabled", background: null });
    expect(() => resolveForegroundSandboxPlan(h.pi)).toThrow(/Invalid Background tasks sandbox policy/);
    h.set({ state: "disabled", permissions: h.permissions, background: { state: "disabled", permissions: { ...h.permissions, processAccess: "invalid" } } });
    expect(() => resolveForegroundSandboxPlan(h.pi)).toThrow(/Invalid .*sandbox permission profile/);
  });

  it("names the controlling Background tasks column when commands are blocked", () => {
    const h = publisher();
    h.set({ state: "disabled", permissions: h.permissions, background: { state: "enabled", writableRoot: "/tmp", denyWrite: [],
      permissions: { ...h.permissions, enabled: true, commands: false } } });
    expect(() => resolveForegroundSandboxPlan(h.pi)).toThrow(/Background tasks profile disables commands/);
  });

  it("requires both current columns to allow process reads, even when their sandboxes are off", () => {
    const h = publisher();
    const base = { state: "disabled", denyWrite: [], reason: "off", permissions: h.permissions };
    h.set({ ...base, background: base });
    expect(backgroundProcessDiagnosticsAccess(h.pi)).toBe("read");
    for (const column of ["main", "background"]) {
      const restricted = { ...base, permissions: { ...h.permissions, processAccess: "off" } };
      h.set(column === "main" ? { ...restricted, background: base } : { ...base, background: restricted });
      expect(backgroundProcessDiagnosticsAccess(h.pi)).toBe("off");
    }
    h.set({ ...base, state: "enabled", writableRoot: "/tmp", background: base });
    expect(backgroundProcessDiagnosticsAccess(h.pi)).toBe("confined");
  });

  it("labels legacy, missing and remote launch evidence without inventing confinement", () => {
    const h = publisher();
    expect(sandboxProvenance(resolveForegroundSandboxPlan(h.pi))).toMatchObject({ confinement: "unconfined", policySource: "main-legacy" });
    expect(sandboxProvenance(resolveForegroundSandboxPlan({}))).toMatchObject({ confinement: "unconfined", policySource: "no-publisher" });
    expect(sandboxProvenance(resolveForegroundSandboxPlan(h.pi, true), true)).toMatchObject({ confinement: "unknown", policySource: "remote" });
  });
});