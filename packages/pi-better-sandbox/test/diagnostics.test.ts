import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { handleDiagnosticsCommand } from "../diagnostics-command.ts";
import { sandboxArgumentCompletions } from "../commands.ts";
import { installTaskTools } from "../shared-task-sandbox.ts";
import { SandboxDiagnostics, diagnosticsEnabled, readDiagnostics } from "../shared-sandbox-diagnostics.ts";

test("human diagnostics command enables collection, summarizes guard refusals, and exports redacted evidence", async (t) => {
    const agent = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-diagnostics-command-")));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agent;
    t.after(() => {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
        rmSync(agent, { recursive: true, force: true });
    });
    const notifications: string[] = [];
    const ctx = { ui: { notify: (message: string) => notifications.push(message) } } as unknown as ExtensionCommandContext;
    assert.equal(diagnosticsEnabled(), false);
    await handleDiagnosticsCommand("on", ctx);
    assert.equal(diagnosticsEnabled(), true);
    const registered = new Map<string, { name: string; parameters: object }>();
    const handlers = new Map<string, (event: any, ctx?: { cwd: string }) => any>();
    const pi = {
        registerTool: (tool: { name: string; parameters: object }) => registered.set(tool.name, tool),
        on: (event: string, handler: (event: any, ctx?: { cwd: string }) => any) => handlers.set(event, handler),
        getAllTools: () => [...registered.values()].map(tool => ({ ...tool, sourceInfo: { path: "<fixture>" } })),
    } as unknown as ExtensionAPI;
    const policy = { writableRoot: agent, home: agent, denyWrite: [], permissions: {
        projectFiles: "read-write" as const, outsideProject: "read" as const, storedCredentials: "read" as const,
        commands: false, network: false,
    } };
    const diagnostics = new SandboxDiagnostics({ context: "foreground", version: "0.11.1",
        policy: () => policy, backend: () => "macos-seatbelt" });
    installTaskTools(pi, { controller: { requireLaunchPlan: () => ({ confined: true, policy, profilePath: join(agent, "profile.sb") }) },
        cwd: agent, trustedSources: ["<fixture>"], diagnostics });
    const input = { command: "sensitive-command-canary", env: { TOKEN: "secret-token-canary" } };
    const refusal = handlers.get("tool_call")!({ toolName: "bash", input });
    assert.equal(refusal.block, true);
    assert.match(refusal.reason, /commands & applications is Off/);
    assert.equal(readDiagnostics().records.length, 1);
    assert.equal(readDiagnostics().records[0]?.resource, "command-execution");
    handlers.get("tool_result")!({ toolName: "bash", input, isError: true });
    assert.equal(readDiagnostics().records.length, 1, "error results must not double-count a preflight refusal");
    handlers.get("tool_result")!({ toolName: "bash", input, isError: false }, { cwd: join(agent, "other-project") });
    assert.equal(readDiagnostics().records.length, 1, "another project cannot recover the same relative input");
    handlers.get("tool_result")!({ toolName: "bash", input, isError: false });
    assert.equal(readDiagnostics().records.at(-1)?.outcome, "succeeded");
    await handleDiagnosticsCommand("summary", ctx);
    assert.match(notifications.at(-1)!, /policy-refusal/);
    await handleDiagnosticsCommand("export", ctx);
    const exported = readFileSync(join(agent, "diagnostics/sandbox/export.json"), "utf8");
    assert.doesNotMatch(exported, /sensitive-command-canary|secret-token-canary/);
    await handleDiagnosticsCommand("off", ctx);
    assert.equal(diagnosticsEnabled(), false);
    handlers.get("tool_call")!({ toolName: "bash", input });
    assert.equal(readDiagnostics().records.length, 2, "off must stop recording without deleting history");
    assert.deepEqual(sandboxArgumentCompletions("diagnostics e").map(item => item.value), ["diagnostics export"]);
    const saved = readFileSync(join(agent, "settings.json"), "utf8");
    writeFileSync(join(agent, "settings.json"), '{"secret":"SENSITIVE-ERROR-CANARY" invalid}');
    await handleDiagnosticsCommand("on", ctx);
    assert.match(notifications.at(-1)!, /Enforcement|enforcement/);
    assert.doesNotMatch(notifications.at(-1)!, /SENSITIVE-ERROR-CANARY|settings\.json/);
    writeFileSync(join(agent, "settings.json"), saved);
});