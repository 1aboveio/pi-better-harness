/**
 * Whole-session demonstration: the harness starts foreground execution
 * inactive, then a human opt-in write-confines every first-party foreground
 * execution path at once. Default-on subagents remain independently confined.
 *
 * Nothing here is a stand-in for the product. The extension set is read out of
 * the published meta package's own manifest and loaded through its own shims, in
 * its own order; the tools are the ones those extensions register; the writes are
 * real writes checked against the real filesystem; and the confinement is the
 * kernel's, not a string check. The only scaffolding is the ExtensionAPI surface
 * pi itself would provide.
 *
 * Fixtures live under the canonical /var/tmp — never os.tmpdir(), which on macOS
 * is /private/var/folders and is always writable inside the profile, so an
 * "outside the project" probe placed there would false-pass.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test, { after, before } from "node:test";

import { describeSandboxSupport } from "../packages/sandbox-core/index.ts";

const repoRoot = resolve(import.meta.dirname, "..");
const support = describeSandboxSupport();

// A platform CI lane sets this so a runner without the backend fails here rather
// than reporting the whole demonstration as skipped.
const requiredBackend = process.env.PI_SANDBOX_REQUIRE_BACKEND;
if (requiredBackend !== undefined && requiredBackend !== "") {
  if (!support.supported) {
    throw new Error(
      `PI_SANDBOX_REQUIRE_BACKEND=${requiredBackend} but no sandbox backend is available: ${support.reason}`,
    );
  }
  if (support.backend !== requiredBackend) {
    throw new Error(
      `PI_SANDBOX_REQUIRE_BACKEND=${requiredBackend} but this runner selected ${support.backend}.`,
    );
  }
}

const skip = support.supported ? false : `requires a real sandbox backend: ${support.reason}`;

const fixtures = realpathSync(mkdtempSync(join(realpathSync("/var/tmp"), "pi-harness-session-")));
const projectRoot = join(fixtures, "project");
const outside = join(fixtures, "outside");
mkdirSync(join(projectRoot, ".git", "hooks"), { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(projectRoot, ".env"), "SECRET=original\n");
writeFileSync(join(projectRoot, "editable.txt"), "first line\n");
writeFileSync(join(outside, "readable.txt"), "readable from inside the sandbox\n");

// Every extension in the set reads pi's agent directory. Redirecting it keeps
// this test off the developer's real ~/.pi state — deny-rule overrides,
// background-task registries and all.
const agentDir = join(fixtures, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const originalCwd = process.cwd();
after(() => {
  process.chdir(originalCwd);
  rmSync(fixtures, { recursive: true, force: true });
});

/**
 * The default extension set, resolved the way pi resolves it: the published meta
 * package's `pi.extensions`, through the shims it ships, in manifest order.
 */
function defaultExtensionEntries() {
  const harnessDir = join(repoRoot, "packages/pi-better-harness");
  const manifest = JSON.parse(readFileSync(join(harnessDir, "package.json"), "utf8"));
  return manifest.pi.extensions.map((entry) => {
    const shim = readFileSync(join(harnessDir, entry), "utf8");
    const match = /\.\.\/\.\.\/node_modules\/([^/"]+)\/([^"]+)/.exec(shim);
    assert.ok(match, `${entry} must re-export a bundled dependency's entry point`);
    // The shim points into the staged tarball copy; the same file in the
    // workspace is what the tarball is packed from.
    return { packageName: match[1], source: join(repoRoot, "packages", match[1], match[2]) };
  });
}

const tools = new Map();
const commands = new Map();
const sessionStartHandlers = [];
const userBashHandlers = [];
const events = new EventEmitter();
const loaded = [];
const notifications = [];
let initialForegroundPolicy;

const ctx = {
  cwd: projectRoot,
  hasUI: true,
  mode: "tui",
  model: { provider: "test-provider", id: "test-model" },
  thinkingLevel: "off",
  sessionManager: {
    getSessionId: () => "harness-session",
    getSessionFile: () => join(fixtures, "harness-session.jsonl"),
    getBranch: () => [],
    getMessages: () => [],
  },
  isIdle: () => true,
  ui: {
    theme: { fg: (_color, text) => text },
    notify: (message) => notifications.push(message),
    setStatus: () => undefined,
    setWidget: () => undefined,
    getEditorComponent: () => undefined,
    setEditorComponent: () => undefined,
    custom: () => Promise.resolve(null),
    confirm: async () => true,
  },
};

const pi = {
  events: {
    emit: (channel, payload) => events.emit(channel, payload),
    on: (channel, handler) => {
      events.on(channel, handler);
      return () => events.off(channel, handler);
    },
  },
  registerTool: (tool) => tools.set(tool.name, tool),
  registerCommand: (name, command) => commands.set(name, command),
  on: (event, handler) => {
    if (event === "session_start") sessionStartHandlers.push(handler);
    if (event === "user_bash") userBashHandlers.push(handler);
  },
  sendMessage: () => undefined,
};

before(async () => {
  if (!support.supported) return;
  // Tools bind their cwd when the extension factory runs, exactly as they do
  // when pi is launched from a project directory.
  process.chdir(projectRoot);

  for (const { packageName, source } of defaultExtensionEntries()) {
    const extension = (await import(source)).default;
    assert.equal(typeof extension, "function", `${packageName} must export an extension factory`);
    extension(pi);
    loaded.push(packageName);
  }

  for (const handler of sessionStartHandlers) {
    await handler({ type: "session_start", reason: "startup" }, ctx);
  }

  const { currentForegroundSandboxPolicy } = await import(
    "../packages/pi-better-background-tasks/src/sandbox.ts"
  );
  initialForegroundPolicy = currentForegroundSandboxPolicy(pi);
  await commands.get("sandbox").handler("on", ctx);
});

async function runTool(name, params) {
  const tool = tools.get(name);
  assert.ok(tool, `the harness must register a ${name} tool`);
  try {
    const result = await tool.execute(`call-${Math.random()}`, params, undefined, undefined, ctx);
    const text = (result.content ?? []).map((part) => part.text ?? "").join("\n");
    return { ok: result.isError !== true, text };
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) };
  }
}

// @covers harness.default-capability
// @level e2e
test("the harness loads the sandbox alongside every other default extension", { skip }, () => {
  assert.deepEqual(loaded, [
    "pi-better-sandbox",
    "pi-better-subagents",
    "pi-better-background-tasks",
    "pi-better-goal",
  ]);
  for (const name of ["bash", "write", "edit", "subagent_spawn", "bg_task_spawn"]) {
    assert.ok(tools.has(name), `a harness session must have the ${name} tool`);
  }
  assert.ok(commands.has("sandbox"), "the human-only /sandbox command must be registered");
});

// @covers harness.default-capability
// @level e2e
test("the harness starts inactive, then one opt-in policy governs the whole session", { skip }, async () => {
  assert.equal(initialForegroundPolicy.state, "disabled");
  assert.match(initialForegroundPolicy.reason, /inactive by default/);

  notifications.length = 0;
  await commands.get("sandbox").handler("", ctx);
  const text = notifications.join("\n");

  assert.match(text, /enabled|on/i, `/sandbox must report protection as active: ${text}`);
  assert.ok(text.includes(projectRoot), `/sandbox must name the canonical project root: ${text}`);
  assert.ok(text.includes(support.executable), `/sandbox must name the resolved backend: ${text}`);

  // The same policy, as the other harness extensions receive it over pi.events.
  const { currentForegroundSandboxPolicy } = await import(
    "../packages/pi-better-background-tasks/src/sandbox.ts"
  );
  const policy = currentForegroundSandboxPolicy(pi);
  assert.equal(policy.state, "enabled");
  assert.equal(policy.writableRoot, projectRoot, "consumers must see the same writable root");
  assert.ok(
    policy.denyWrite.includes(join(projectRoot, ".env")),
    `consumers must see the packaged deny rules: ${JSON.stringify(policy.denyWrite)}`,
  );
});

// @covers sandbox.foreground-shell
// @level e2e
test("shell: writes stay inside the project and reads stay unrestricted", { skip }, async () => {
  const inside = join(projectRoot, "shell-allowed.txt");
  const escaped = join(outside, "shell-escaped.txt");

  const allowed = await runTool("bash", { command: `printf 'inside\n' > ${JSON.stringify(inside)}` });
  const read = await runTool("bash", { command: `cat ${JSON.stringify(join(outside, "readable.txt"))}` });
  const denied = await runTool("bash", { command: `printf 'escaped\n' > ${JSON.stringify(escaped)}` });

  assert.equal(allowed.ok, true, allowed.text);
  assert.equal(readFileSync(inside, "utf8"), "inside\n");
  assert.equal(read.ok, true, read.text);
  assert.match(read.text, /readable from inside the sandbox/, "reads outside the root must keep working");
  assert.equal(denied.ok, false, "a write outside the project root must not report success");
  assert.equal(existsSync(escaped), false, "no host artifact may appear outside the project root");
});

// @covers sandbox.foreground-shell
// @level e2e
test("shell: user-entered ! commands use the same confined backend", { skip }, async () => {
  assert.equal(userBashHandlers.length, 1, "exactly one extension may own user_bash");
  const result = userBashHandlers[0]({ type: "user_bash", command: "printf ok" }, ctx);
  assert.ok(result?.operations, "user_bash must be routed through the sandboxed operations");
});

// @covers sandbox.write-containment
// @level e2e
test("write: outside the root and packaged deny paths are refused", { skip }, async () => {
  const escaped = join(outside, "write-escaped.txt");
  const denied = join(projectRoot, ".env");
  const allowed = join(projectRoot, "write-allowed.txt");

  const outsideResult = await runTool("write", { path: escaped, content: "escaped\n" });
  const denyResult = await runTool("write", { path: denied, content: "STOLEN=1\n" });
  const insideResult = await runTool("write", { path: allowed, content: "inside\n" });

  assert.equal(outsideResult.ok, false, outsideResult.text);
  assert.equal(existsSync(escaped), false, "a refused write must leave nothing on disk");
  assert.equal(denyResult.ok, false, denyResult.text);
  assert.equal(readFileSync(denied, "utf8"), "SECRET=original\n");
  assert.equal(insideResult.ok, true, insideResult.text);
  assert.equal(readFileSync(allowed, "utf8"), "inside\n");
});

// @covers sandbox.write-containment
// @level e2e
test("edit: a packaged deny path cannot be edited, an ordinary file can", { skip }, async () => {
  const denied = join(projectRoot, ".env");
  const allowed = join(projectRoot, "editable.txt");

  const denyResult = await runTool("edit", {
    path: denied,
    edits: [{ oldText: "SECRET=original", newText: "SECRET=stolen" }],
  });
  const allowedResult = await runTool("edit", {
    path: allowed,
    edits: [{ oldText: "first line", newText: "edited line" }],
  });

  assert.equal(denyResult.ok, false, denyResult.text);
  assert.equal(readFileSync(denied, "utf8"), "SECRET=original\n");
  assert.equal(allowedResult.ok, true, allowedResult.text);
  assert.equal(readFileSync(allowed, "utf8"), "edited line\n");
});

// @covers background-task.sandbox-policy-contract
// @level e2e
test("local background tasks inherit the same policy", { skip }, async () => {
  const { resolveForegroundSandboxPlan } = await import(
    "../packages/pi-better-background-tasks/src/sandbox.ts"
  );

  // The plan the task runtime resolves at launch, from the policy the sandbox
  // extension published into this same session.
  const plan = resolveForegroundSandboxPlan(pi);
  assert.equal(plan.confined, true, "a local task launched now must be confined");
  assert.equal(plan.writableRoot, projectRoot);
  assert.ok(plan.denyWrite.includes(join(projectRoot, ".env")));

  // And the same policy, proved by a real detached task doing real writes.
  const { readMeta } = await import("../packages/pi-better-background-tasks/src/registry.ts");
  const inside = join(projectRoot, "task-allowed.txt");
  const escaped = join(outside, "task-escaped.txt");
  const denied = join(projectRoot, ".env");

  const launch = await runTool("bg_task_spawn", {
    command: [
      `printf 'inside\n' > ${JSON.stringify(inside)}`,
      `printf 'escaped\n' > ${JSON.stringify(escaped)} 2>&1 || true`,
      `printf 'STOLEN=1\n' > ${JSON.stringify(denied)} 2>&1 || true`,
      "printf 'PROBE-COMPLETE\n'",
    ].join("; "),
    callback: false,
  });
  assert.equal(launch.ok, true, launch.text);

  const id = launch.text.match(/bg_[a-z0-9_]+/)?.[0];
  assert.ok(id, `no task id in: ${launch.text}`);

  const deadline = Date.now() + 30_000;
  let meta;
  while (Date.now() < deadline) {
    meta = readMeta(id);
    if (meta?.status === "succeeded" || meta?.status === "failed") break;
    await new Promise((wake) => setTimeout(wake, 25));
  }
  assert.equal(meta?.status, "succeeded", `task never finished: ${JSON.stringify(meta)}`);
  assert.equal(meta.launchArgv?.[0], support.executable, "the task must launch under the backend wrapper");
  assert.match(readFileSync(meta.logPath, "utf8"), /PROBE-COMPLETE/);
  assert.equal(readFileSync(inside, "utf8"), "inside\n");
  assert.equal(existsSync(escaped), false, "a background task must not write outside the project root");
  assert.equal(readFileSync(denied, "utf8"), "SECRET=original\n", "a background task must not write a denied path");
});

// @covers sandbox.spawn-policy
// @level e2e
test("subagents run through the same shared mechanism", { skip }, async () => {
  const { maybeBuildSandboxCommand, sandboxSupported } = await import(
    "../packages/pi-better-subagents/sandbox.ts"
  );

  assert.equal(sandboxSupported(), true, "the subagent path must see the same backend");
  const command = maybeBuildSandboxCommand(
    {
      profilePath: join(fixtures, "subagent.sb"),
      writableDir: projectRoot,
      home: fixtures,
      piBin: "/bin/echo",
      piArgs: ["ok"],
    },
    { sandboxEnabled: true, explicitSandbox: false },
  );

  assert.ok(command, "a default-on subagent spawn must be wrapped, never bare");
  assert.equal(command.file, support.executable);
});

// @covers sandbox.human-only-control
// @level e2e
test("nothing the model can call changes sandbox state", { skip }, () => {
  const controlNames = [...tools.keys()].filter((name) => /sandbox/i.test(name));
  assert.deepEqual(controlNames, [], `sandbox control must not be model-callable: ${controlNames}`);
});
