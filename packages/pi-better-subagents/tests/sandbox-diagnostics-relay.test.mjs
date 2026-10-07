// @covers subagent.trusted-runtime-task-boundary
// @level integration
import test from "node:test";
import assert from "node:assert/strict";

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const diagnosticsModule = new URL("../shared-sandbox-diagnostics.ts", import.meta.url).href;
const { SandboxDiagnostics, readDiagnostics, setDiagnosticsEnabled, isDiagnosticReport } = await import(diagnosticsModule);
const { collectRunFailures, failurePath, resetFailureScanCursor } = await import("../failures.ts");
const { runDir, logPathFor, recordTaskRuntimeProvenance, removeTaskRuntimeProvenance } = await import("../registry.ts");
const { buildSandboxCommand, describeSandboxSupport } = await import("../shared-sandbox-core.ts");
const { default: taskGuard } = await import("../task-guard.ts");

let serial = 0;
function fixture(t, trusted = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-diagnostic-relay-")));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const id = `sa_diagnostic_relay_${process.pid}_${++serial}`;
  mkdirSync(runDir(id), { recursive: true });
  writeFileSync(join(runDir(id), "meta.json"), JSON.stringify({ id, status: "running", cwd: root, taskRuntime: true, startedAt: 1 }));
  if (trusted) recordTaskRuntimeProvenance(id);
  setDiagnosticsEnabled(true, { agentDir: () => root });
  t.after(() => {
    resetFailureScanCursor(id);
    removeTaskRuntimeProvenance(id);
    rmSync(runDir(id), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  return { id, root, seams: { agentDir: () => root }, append: (...rows) => appendFileSync(logPathFor(id), rows.map(r => JSON.stringify(r)).join("\n") + "\n") };
}
function reports(f) {
  const rows = [];
  const c = new SandboxDiagnostics({ ...f.seams, context: "worker", version: "1", backend: () => "unknown",
    policy: () => ({ path: "/private/policy-relay-canary" }), relay: r => rows.push(r) });
  const input = { tool: "write", operation: { path: "/private/input-relay-canary" }, resource: "runtime-control-files", basis: "policy-refusal" };
  c.observe({ ...input, outcome: "denied" });
  c.observe({ ...input, outcome: "succeeded" });
  return rows;
}
const start = { type: "tool_execution_start", toolCallId: "real-failure", toolName: "bash", args: { command: "false" } };
const end = { type: "tool_execution_end", toolCallId: "real-failure", toolName: "bash", isError: true, result: { exitCode: 1 } };

test("parent folds trusted relay reports once across incremental reads and reload without altering the failure journal", t => {
  const f = fixture(t);
  f.append(start, end);
  const beforeState = collectRunFailures(f.id, f.root);
  const beforeJournal = readFileSync(failurePath(f.id), "utf8");
  const rows = reports(f);
  f.append(rows[0], { ...rows[0], rawPath: "/private/rejected-report-canary" });
  assert.deepEqual(collectRunFailures(f.id, f.root), beforeState);
  assert.equal(readDiagnostics(f.seams).records.length, 1);
  f.append(rows[1], ...rows, { ...rows[0], basis: "policy-refusal" });
  assert.deepEqual(collectRunFailures(f.id, f.root), beforeState);
  resetFailureScanCursor(f.id);
  assert.deepEqual(collectRunFailures(f.id, f.root), beforeState);
  const data = readDiagnostics(f.seams);
  assert.equal(data.records.length, 2);
  assert.ok(data.records.every(r => r.basis === "agent-reported" && r.context === "worker"));
  assert.equal(data.records[1].recoveryOf, data.records[0].fingerprint);
  assert.equal(readFileSync(failurePath(f.id), "utf8"), beforeJournal);
  assert.doesNotMatch(JSON.stringify(data), /private\//);
  assert.deepEqual(data.issues, []);
});

test("forged runtime metadata without parent provenance and dynamically disabled collection import nothing", t => {
  const f = fixture(t, false);
  const rows = reports(f);
  f.append(...rows);
  assert.equal(collectRunFailures(f.id, f.root).seen.length, 0);
  assert.equal(existsSync(join(f.root, "diagnostics")), false);
  recordTaskRuntimeProvenance(f.id);
  resetFailureScanCursor(f.id);
  setDiagnosticsEnabled(false, f.seams);
  collectRunFailures(f.id, f.root);
  assert.equal(existsSync(join(f.root, "diagnostics")), false);
  setDiagnosticsEnabled(true, f.seams);
  f.append(...rows);
  collectRunFailures(f.id, f.root);
  assert.equal(readDiagnostics(f.seams).records.length, 2);
  const next = reports(f);
  setDiagnosticsEnabled(false, f.seams);
  f.append(...next);
  collectRunFailures(f.id, f.root);
  assert.equal(readDiagnostics(f.seams).records.length, 2);
});

test("parent collection errors warn without sensitive prose and cannot replace tool incidents", t => {
  const f = fixture(t);
  const rows = reports(f);
  writeFileSync(join(f.root, "settings.json"), "{ /private/settings-error-canary");
  const warnings = [];
  t.mock.method(process.stderr, "write", chunk => { warnings.push(String(chunk)); return true; });
  f.append(rows[0], start, rows[1], end, ...rows);
  const state = collectRunFailures(f.id, f.root);
  assert.equal(Object.values(state.observations).length, 1);
  assert.equal(Object.values(state.observations)[0].id, "tool:real-failure");
  assert.equal(Object.values(state.observations)[0].status, "unresolved");
  assert.deepEqual(warnings, ["Sandbox diagnostics collection gap; enforcement unchanged.\n"]);
  assert.equal(existsSync(join(f.root, "diagnostics")), false);
  const before = readFileSync(failurePath(f.id), "utf8");
  writeFileSync(join(f.root, "settings.json"), JSON.stringify({ piBetterHarness: { sandboxDiagnostics: { version: 1, enabled: true } } }));
  resetFailureScanCursor(f.id);
  collectRunFailures(f.id, f.root);
  assert.equal(readFileSync(failurePath(f.id), "utf8"), before);
  assert.equal(readDiagnostics(f.seams).records.length, 2);
});

test("a kernel-confined worker reads global opt-in and relays while global journal mutation remains denied", {
  skip: !describeSandboxSupport().supported,
}, t => {
  const f = fixture(t);
  const project = join(f.root, "project"), control = join(f.root, "control"), agent = join(f.root, "agent");
  for (const dir of [project, control, agent]) mkdirSync(dir);
  const seams = { agentDir: () => agent };
  setDiagnosticsEnabled(true, seams);
  new SandboxDiagnostics({ ...seams, context: "foreground", version: "1", policy: () => ({}), backend: () => "unknown" })
    .observe({ tool: "read", operation: "parent", resource: "unknown", basis: "policy-refusal", outcome: "denied" });
  const journal = join(agent, "diagnostics", "sandbox", "events.jsonl");
  const before = readFileSync(journal, "utf8");
  const script = `
    import assert from 'node:assert/strict';
    import {writeFileSync, readFileSync} from 'node:fs';
    import {SandboxDiagnostics} from ${JSON.stringify(diagnosticsModule)};
    assert.throws(()=>writeFileSync(${JSON.stringify(journal)}, 'forbidden'), {code:/^(EPERM|EACCES|EROFS)$/});
    assert.throws(()=>writeFileSync(${JSON.stringify(join(agent, "settings.json.lock"))}, 'forbidden'), {code:/^(EPERM|EACCES|EROFS)$/});
    const c=new SandboxDiagnostics({context:'worker',version:'1',agentDir:()=>${JSON.stringify(agent)},policy:()=>({path:'/private/confined-policy'}),
      backend:()=> 'unknown',relay:r=>process.stdout.write(JSON.stringify(r)+'\\n'),onError:()=>{process.stderr.write('diagnostics gap\\n');process.exitCode=1;}});
    const input={tool:'write',operation:'/private/confined-input',resource:'runtime-control-files',basis:'policy-refusal'};
    c.observe({...input,outcome:'denied'});c.observe({...input,outcome:'succeeded'});
    assert.equal(readFileSync(${JSON.stringify(journal)},'utf8'),${JSON.stringify(before)});
  `;
  const command = buildSandboxCommand({ execPath: process.execPath,
    execArgs: ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script], profilePath: join(control, "worker.sb"),
    policy: { writableRoot: project, home: homedir(), denyWrite: [agent, control],
      permissions: { projectFiles: "read-write", outsideProject: "read", storedCredentials: "read", commands: true, network: false } } });
  const result = spawnSync(command.file, command.fileArgs, { cwd: project, encoding: "utf8", timeout: 30000,
    env: { ...process.env, TSX_DISABLE_CACHE: "1" } });
  if (result.status === 71 && /sandbox_apply: Operation not permitted/.test(result.stderr)) {
    t.skip("Host refuses nested Seatbelt sandbox_apply; kernel proof requires an unconstrained runner.");
    return;
  }
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(result.stderr, "");
  const rows = result.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(rows.length, 2);
  assert.ok(rows.every(isDiagnosticReport));
  assert.doesNotMatch(result.stdout, /private\//);
  assert.equal(readFileSync(journal, "utf8"), before);
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  try {
    f.append(...rows);
    collectRunFailures(f.id, project);
    const data = readDiagnostics(seams);
    assert.equal(data.records.length, 3, "only the accessible parent persists worker observations");
    assert.deepEqual(data.records.slice(1).map(r => [r.context, r.basis, r.outcome]), [
      ["worker", "agent-reported", "denied"], ["worker", "agent-reported", "succeeded"],
    ]);
    assert.deepEqual(data.issues, []);
  } finally { process.env.PI_CODING_AGENT_DIR = old; }
});

test("task guard emits collector reports through the worker JSON stream and still refuses commands and unverified tools", {
  skip: !describeSandboxSupport().supported,
}, async t => {
  const f = fixture(t);
  const project = join(f.root, "project"), control = join(f.root, "control"), scratch = join(f.root, "scratch");
  for (const dir of [project, control, scratch]) mkdirSync(dir);
  const policy = { version: 1, root: project, home: homedir(), agentDir: f.root, profilePath: join(control, "worker.sb"), scratch,
    permissions: { projectFiles: "read-write", outsideProject: "read", storedCredentials: "read", commands: false, network: false },
    denyWrite: [f.root], tools: ["write", "bash"] };
  const tools = new Map(), handlers = new Map();
  const pi = { registerTool: tool => tools.set(tool.name, { ...tool, sourceInfo: { path: "<inline:task-sandbox>" } }),
    on: (name, handler) => handlers.set(name, handler), events: { on() {}, emit() {} },
    getAllTools: () => [...tools.values()], setActiveTools() {}, getActiveTools: () => ["write", "bash", "failure_disposition"] };
  const rows = [];
  const original = process.stdout.write;
  t.mock.method(process.stdout, "write", function(chunk, ...args) {
    if (String(chunk).startsWith('{"schema":1,"type":"sandbox_diagnostic_report"')) { rows.push(JSON.parse(String(chunk))); return true; }
    if (String(chunk).startsWith('{"type":"task_sandbox_ready"')) return true;
    return original.call(this, chunk, ...args);
  });
  taskGuard(pi, policy, error => { throw error; });
  await handlers.get("session_start")({}, { cwd: project });
  const command = handlers.get("tool_call")({ toolName: "bash", input: { command: "true" } }, { cwd: project });
  assert.equal(command.block, true);
  assert.match(command.reason, /commands.*Off/i);
  const extension = handlers.get("tool_call")({ toolName: "unverified-canary", input: { path: "/private/guard-canary" } }, { cwd: project });
  assert.equal(extension.block, true);
  assert.match(extension.reason, /verified task execution adapter/);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(isDiagnosticReport));
  assert.deepEqual(rows.map(r => r.resource), ["command-execution", "tool-admission"]);
  assert.doesNotMatch(JSON.stringify(rows), /private|unverified-canary/);
  assert.equal(existsSync(join(f.root, "diagnostics")), false);
  assert.equal(JSON.parse(readFileSync(join(f.root, "settings.json"), "utf8")).piBetterHarness.sandboxDiagnostics.enabled, true);
  f.append(...rows);
  collectRunFailures(f.id, project);
  assert.equal(readDiagnostics(f.seams).records.length, 2);
});
