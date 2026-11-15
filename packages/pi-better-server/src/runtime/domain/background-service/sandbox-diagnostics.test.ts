import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FOREGROUND_SANDBOX_POLICY_CHANNEL, observeForegroundSandboxPolicy, resolveForegroundSandboxPlan } from "./sandbox.js";
import { readDiagnostics, setDiagnosticsEnabled } from "./shared-sandbox-diagnostics.js";

it("background preflight collects only opt-in structured refusals with the correct tool and no task success claims", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bg-diagnostics-")));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const events = new EventEmitter();
  const pi = { events };
  observeForegroundSandboxPolicy(pi);
  const status = { state: "enabled", writableRoot: root, denyWrite: [], permissions: {
    enabled: true, commands: false, network: false, projectFiles: "read-write", outsideProject: "read", storedCredentials: "read",
  } };
  try {
    events.emit(FOREGROUND_SANDBOX_POLICY_CHANNEL, status);
    expect(() => resolveForegroundSandboxPlan(pi, false, { command: "PRIVATE-CANARY" })).toThrow();
    expect(readDiagnostics().records).toEqual([]);
    setDiagnosticsEnabled(true);
    expect(() => resolveForegroundSandboxPlan(pi, false, { command: "PRIVATE-CANARY" })).toThrow();
    status.permissions.commands = true;
    events.emit(FOREGROUND_SANDBOX_POLICY_CHANNEL, status);
    expect(() => resolveForegroundSandboxPlan(pi, true, { ssh: { host: "PRIVATE-HOST" } }, "bg_task_watch")).toThrow();
    const records = readDiagnostics().records;
    expect(records.map(record => [record.context, record.tool, record.resource, record.basis])).toEqual([
      ["background", "bg_task_spawn", "command-execution", "policy-refusal"],
      ["background", "bg_task_watch", "network-access", "policy-refusal"],
    ]);
    status.permissions.network = true;
    events.emit(FOREGROUND_SANDBOX_POLICY_CHANNEL, status);
    expect(resolveForegroundSandboxPlan(pi, false, { command: "PRIVATE-CANARY" }, "bg_task_watch").confined).toBe(true);
    expect(readDiagnostics().records.length).toBe(2);
    expect(JSON.stringify(records)).not.toMatch(/PRIVATE-CANARY|PRIVATE-HOST/);
    setDiagnosticsEnabled(false);
    status.permissions.commands = false;
    events.emit(FOREGROUND_SANDBOX_POLICY_CHANNEL, status);
    expect(() => resolveForegroundSandboxPlan(pi, false, {})).toThrow();
    expect(readDiagnostics().records.length).toBe(2);
  } finally {
    events.removeAllListeners();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});