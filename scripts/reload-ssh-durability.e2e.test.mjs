/**
 * #312/#315 state across a real `/reload`, with background work running over SSH (#324).
 *
 * A real Pi AgentSession loads the subagent and background-task extensions from
 * their package entry files, the way `pi -e` does, and `session.reload()` is the
 * same call Pi's `/reload` command makes: session_shutdown, a fresh extension
 * load (jiti with no module cache, so no in-memory state survives), then
 * session_start. What must survive is only what the extensions persisted:
 *
 * - a pending subagent completion callback is delivered exactly once, after the
 *   reload, and its receipt (plus the incident delivery receipt) stops a second
 *   reload from delivering it again;
 * - the incident journal keeps its active incidents and counts: delivery is not
 *   recovery, and an SSH watch incident keeps growing the same record across the
 *   reload until a later successful poll resolves it;
 * - result/log cursors issued before the reload continue after it.
 *
 * Background tasks run through the product's SSH preset: ssh-core builds the ssh
 * argv and the process runner spawns an `ssh` binary from PATH. By default that
 * binary is a local fake that records its argv and runs the remote command with
 * /bin/sh, so the transport is real except for the network hop. Set
 * PI_LIVE_SSH_HOST (and optionally PI_LIVE_SSH_USER) to repeat the SSH scenario
 * against a real host with the system ssh; `npm run test:live-ssh` requires it.
 *
 * The only thing replaced in the session is `sendCustomMessage`: a callback would
 * otherwise start a model turn. The test records what the extensions hand to it.
 *
 * // @covers subagent.completion-callback
 * // @covers subagent.result
 * // @covers background-task.ssh-status
 * // @level integration
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";

// `npm run test:live-ssh` sets PI_LIVE_SSH_REQUIRED so a missing host fails instead of skipping.
const liveHost = process.env.PI_LIVE_SSH_HOST;
if (process.env.PI_LIVE_SSH_REQUIRED === "1" && !liveHost) {
  throw new Error("PI_LIVE_SSH_REQUIRED=1 but PI_LIVE_SSH_HOST is not set");
}

const repoRoot = resolve(import.meta.dirname, "..");
const fixtures = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "pi-reload-ssh-")));
const dir = (name) => { const path = join(fixtures, name); mkdirSync(path, { recursive: true }); return path; };
const tmp = dir("tmp");
const agentDir = dir("agent");
const fakeBin = dir("fake-bin");
const sshLog = join(fixtures, "ssh-argv.log");

// Everything the extensions persist lives under TMPDIR; set it before any product
// module computes a registry path.
process.env.TMPDIR = tmp;
process.env.TMP = tmp;
process.env.TEMP = tmp;
process.env.PI_CODING_AGENT_DIR = agentDir;

writeFileSync(join(fakeBin, "ssh"), [
  "#!/bin/sh",
  `printf '%s\\n' "$*" >> '${sshLog}'`,
  'while [ $# -gt 0 ]; do if [ "$1" = "--" ]; then shift; break; fi; shift; done',
  "shift # target",
  'exec /bin/sh -c "$1"',
  "",
].join("\n"));
chmodSync(join(fakeBin, "ssh"), 0o755);

const originalPath = process.env.PATH ?? "";
const originalWindow = process.env.PI_BETTER_CALLBACK_BATCH_MS;
after(() => {
  process.env.PATH = originalPath;
  if (originalWindow === undefined) delete process.env.PI_BETTER_CALLBACK_BATCH_MS;
  else process.env.PI_BETTER_CALLBACK_BATCH_MS = originalWindow;
  rmSync(fixtures, { recursive: true, force: true });
});

const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
  await import("@earendil-works/pi-coding-agent");
const { InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
// The test's own view of the persisted state: separate module instances from the
// ones the session loads, sharing only the disk.
const subagentRegistry = await import("../packages/pi-better-subagents/registry.ts");
const subagentFailures = await import("../packages/pi-better-subagents/failures.ts");
const observations = await import("../packages/pi-better-subagents/shared-failure-observations.ts");
const bgRegistry = await import("../packages/pi-better-background-tasks/src/registry.ts");
const bgFailures = await import("../packages/pi-better-background-tasks/src/failures.ts");
const bgObservations = await import("../packages/pi-better-background-tasks/src/shared-failure-observations.ts");
const { MULTI_PAGE_ANSWER } = await import("./issue-312-payload-baseline/fixtures.mjs");
const { answerPageBody } = await import("./issue-312-payload-baseline/run.mjs");

const EXTENSIONS = [
  join(repoRoot, "packages/pi-better-subagents/index.ts"),
  join(repoRoot, "packages/pi-better-background-tasks/src/index.ts"),
];
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitFor(what, fn, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(50);
  }
}

/** A real Pi session over the two extensions; `reload()` is what `/reload` runs. */
async function openSession(project) {
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: project, agentDir, settingsManager, additionalExtensionPaths: EXTENSIONS,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-store.json"),
  });
  const { session } = await createAgentSession({
    cwd: project, agentDir, resourceLoader, modelRuntime, settingsManager,
    sessionManager: SessionManager.inMemory(project), noTools: "builtin",
  });
  const sent = [];
  const errors = [];
  session.sendCustomMessage = async (message, options) => { sent.push({ ...message, options }); };
  return {
    session,
    sent,
    errors,
    sessionId: session.sessionManager.getSessionId(),
    start: () => session.bindExtensions({ onError: (error) => errors.push(error) }),
    // Tools are looked up per call: after a reload they belong to the new extension instances.
    async call(name, params) {
      const tool = session.agent.state.tools.find((candidate) => candidate.name === name);
      assert.ok(tool, `${name} is registered`);
      const result = await tool.execute(`call-${name}-${Date.now()}`, params, new AbortController().signal);
      return result.content.map((part) => part.text ?? "").join("\n");
    },
    completions: (id) => sent.filter((m) => m.customType === "background-completion-batch" && String(m.content).includes(id)),
  };
}

const nextCursor = (content) => String(content).match(/\bnextCursor=(\S+)/)?.[1];
/** The continuation cursor while a page says more retained bytes follow (a final page's cursor only tails later appends). */
const continuation = (content) => (/\bhasMore=true\b/.test(String(content)) ? nextCursor(content) : undefined);
const taskId = (content) => String(content).match(/\((bg_[^)]+)\)/)?.[1];

test("a real /reload keeps pending callback receipts, the incident journal, and result cursors", async () => {
  const project = dir("subagent-project");
  const host = await openSession(project);
  const { sessionId } = host;
  const now = Date.now();
  const seedRun = (id, finalText, extras) => {
    mkdirSync(subagentRegistry.runDir(id), { recursive: true });
    writeFileSync(subagentRegistry.logPathFor(id), [
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: finalText }] } },
      { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: finalText }] }] },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");
    subagentRegistry.writeMeta({
      id, name: id, status: "completed", exitCode: 0, pid: 0, spawnPid: process.pid, cwd: project,
      promptPreview: "reload durability", startedAt: now - 2_000, endedAt: now - 1_000,
      logPath: subagentRegistry.logPathFor(id), sessionId: `${id}-child`,
      callbackOrigin: { cwd: project, sessionId }, ...extras,
    });
  };

  // A completed run whose completion callback is durable-pending, with one active incident.
  const pendingId = "sa_reload_pending";
  seedRun(pendingId, "reload-durability answer", { callback: true, completionCallbackPendingAt: now - 1_000 });
  observations.observeFailures(subagentFailures.failurePath(pendingId), [
    { id: "tool:npm-test", operation: "npm-test", kind: "failure", summary: "reload-durability tests failed" },
  ], now - 1_000);
  // A completed run whose answer spans several result pages.
  const pagedId = "sa_reload_paged";
  seedRun(pagedId, MULTI_PAGE_ANSWER, { callback: false });

  // A long batch window keeps the recovered callback pending across the reload.
  process.env.PI_BETTER_CALLBACK_BATCH_MS = "600000";
  await host.start();
  const activeBefore = observations.activeFailures(subagentFailures.readRunFailures(pendingId)).map((o) => o.id);
  assert.equal(activeBefore.length, 1);
  const resultBefore = await host.call("subagent_result", { id: pendingId });
  assert.match(resultBefore, /reload-durability tests failed/);

  const page1 = await host.call("subagent_result", { id: pagedId });
  const cursor = nextCursor(page1);
  assert.ok(cursor, "the answer needs more than one page");
  const page2Before = await host.call("subagent_result", { id: pagedId, cursor });
  await delay(300);
  assert.equal(host.completions(pendingId).length, 0, "nothing is delivered before the reload");
  assert.equal(subagentRegistry.readMeta(pendingId).completionCallbackSentAt, undefined);

  process.env.PI_BETTER_CALLBACK_BATCH_MS = "50";
  await host.session.reload();

  // Pending callback: delivered once by the reloaded extension, with both receipts written.
  await waitFor("the recovered completion callback", () => host.completions(pendingId).length > 0);
  assert.equal(host.completions(pendingId).length, 1);
  assert.match(host.completions(pendingId)[0].content, /reload-durability tests failed|action required/i);
  await waitFor("the completion receipt", () => subagentRegistry.readMeta(pendingId).completionCallbackSentAt > 0);
  const journal = subagentFailures.readRunFailures(pendingId);
  assert.ok(journal.delivered[activeBefore[0]] > 0, "incident delivery receipt is durable");
  assert.equal(observations.pendingFailureAttention(journal, Date.now(), { terminal: true }), undefined);

  // Incident journal: the same incident is still active after reload and delivery.
  assert.deepEqual(observations.activeFailures(journal).map((o) => o.id), activeBefore, "delivery is not recovery");
  assert.match(await host.call("subagent_result", { id: pendingId }), /reload-durability tests failed/);

  // Cursors: the pre-reload cursor replays the same page and the chain reconstructs the answer.
  assert.equal(await host.call("subagent_result", { id: pagedId, cursor }), page2Before);
  const pages = [page1];
  for (let next = cursor; next; next = continuation(pages.at(-1))) {
    pages.push(await host.call("subagent_result", { id: pagedId, cursor: next }));
    assert.ok(pages.length <= 20, "cursor chain must terminate");
  }
  assert.ok(pages.length >= 3, `expected at least three pages, got ${pages.length}`);
  assert.equal(pages.map(answerPageBody).join(""), MULTI_PAGE_ANSWER);

  // A second reload finds the receipt and delivers nothing new.
  await host.session.reload();
  await delay(400);
  assert.equal(host.completions(pendingId).length, 1, "receipts survive a second reload");
  assert.deepEqual(host.errors, []);
  host.session.dispose();
});

/**
 * SSH transports for the background-task scenario. `fake` always runs; `live`
 * runs only with PI_LIVE_SSH_HOST and uses the system ssh against that host.
 */
function fakeTransport() {
  const remote = dir("fake-remote");
  const marker = join(remote, "done");
  return {
    name: "fake ssh on PATH",
    ssh: { host: "fake-remote.test" },
    path: `${fakeBin}:${originalPath}`,
    markerPath: marker,
    setDone: () => writeFileSync(marker, ""),
    cleanup() {},
    argvLines: () => readFileSync(sshLog, "utf8").trim().split("\n").filter(Boolean),
  };
}

function liveTransport() {
  const host = process.env.PI_LIVE_SSH_HOST;
  const user = process.env.PI_LIVE_SSH_USER || undefined;
  const target = user ? `${user}@${host}` : host;
  const marker = `/tmp/pi-reload-ssh-${process.pid}-${Date.now()}.done`;
  const run = (command) => execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-T", "--", target, command], { encoding: "utf8" });
  return {
    name: `live ssh to ${target}`,
    ssh: { host, ...(user ? { user } : {}) },
    path: originalPath,
    markerPath: marker,
    setDone: () => run(`touch ${marker}`),
    cleanup: () => { try { run(`rm -f ${marker}`); } catch { /* best-effort */ } },
    argvLines: undefined,
  };
}

async function sshScenario(transport) {
  process.env.PATH = transport.path;
  process.env.PI_BETTER_CALLBACK_BATCH_MS = "50";
  const project = dir(`bg-project-${transport.ssh.host}`);
  const host = await openSession(project);
  try {
    await host.start();
    const watchCommand = `if [ -f ${transport.markerPath} ]; then echo '{"status":"done"}'; else echo '{"status":"pending"}'; exit 7; fi`;
    const watchId = taskId(await host.call("bg_task_watch", {
      name: "reload-watch", command: watchCommand, ssh: transport.ssh, interval_seconds: 1,
      success_when: { type: "json_path_equals", path: "$.status", value: "done" },
    }));
    const spawnId = taskId(await host.call("bg_task_spawn", {
      name: "reload-seq", command: "seq 1 3000", ssh: transport.ssh, remote: { session: "direct" }, callback: false,
    }));
    assert.ok(watchId && spawnId);

    // Before reload: the failing polls journal one incident that counts retries.
    const incident = await waitFor("the watch-poll incident", () => Object.values(readBgJournal(watchId).observations)
      .find((o) => o.operation === "watch-poll" && o.status === "unresolved" && o.count >= 2));
    await waitFor("the remote process task", () => bgRegistry.readMeta(spawnId)?.status === "succeeded");
    const logPages = await followLog(host, spawnId);

    await host.session.reload();

    // The reloaded extension resumes the same SSH watcher; the journal record keeps growing.
    const grown = await waitFor("a post-reload poll on the same incident", () => {
      const record = Object.values(readBgJournal(watchId).observations).find((o) => o.id === incident.id);
      return record && record.count > incident.count ? record : undefined;
    });
    assert.equal(grown.status, "unresolved");
    const polls = transport.argvLines ? countPolls(transport) : undefined;
    await delay(2_200);
    if (polls !== undefined) {
      // One poller at a 1 s interval: a leftover pre-reload timer would roughly double this.
      const extra = countPolls(transport) - polls;
      assert.ok(extra <= 4, `expected one resumed poller, saw ${extra} polls in 2.2 s`);
    }
    transport.setDone();
    await waitFor("the watch to succeed", () => bgRegistry.readMeta(watchId)?.status === "succeeded");
    const resolved = Object.values(readBgJournal(watchId).observations).find((o) => o.id === incident.id);
    assert.equal(resolved.status, "resolved", "a later successful poll resolves the pre-reload incident");
    assert.ok(resolved.count >= grown.count);

    await waitFor("the watch completion callback", () => host.completions(watchId).length > 0);
    await delay(300);
    assert.equal(host.completions(watchId).length, 1, "one completion across the reload");

    // Log cursors issued before the reload replay identically after it.
    const replayed = [logPages[0]];
    for (let next = continuation(logPages[0]); next; next = continuation(replayed.at(-1))) {
      replayed.push(await host.call("bg_task_log", { id: spawnId, raw: true, max_bytes: 4096, cursor: next }));
      assert.ok(replayed.length <= 20, "log cursor chain must terminate");
    }
    assert.deepEqual(replayed, logPages);
    const numbers = logPages.flatMap((page) => page.split("\n").filter((line) => /^\d+$/.test(line))).map(Number);
    assert.deepEqual(numbers, Array.from({ length: 3000 }, (_, i) => i + 1), "raw pages carry every remote line once, in order");

    if (transport.argvLines) {
      const argv = transport.argvLines();
      assert.ok(argv.some((line) => line.includes("-o BatchMode=yes") && line.includes(`-- ${transport.ssh.host} `)),
        "tasks went through the product's ssh argv");
    }
    await host.session.reload();
    await delay(300);
    assert.equal(host.completions(watchId).length, 1, "the watch receipt survives another reload");
    assert.deepEqual(host.errors, []);
  } finally {
    host.session.dispose();
    transport.cleanup();
    process.env.PATH = originalPath;
  }
}

function readBgJournal(id) {
  return bgObservations.readFailureState(bgFailures.failurePath(id));
}

function countPolls(transport) {
  return transport.argvLines().filter((line) => line.includes(transport.markerPath)).length;
}

async function followLog(host, id) {
  const pages = [await host.call("bg_task_log", { id, raw: true, max_bytes: 4096 })];
  for (let next = continuation(pages[0]); next; next = continuation(pages.at(-1))) {
    pages.push(await host.call("bg_task_log", { id, raw: true, max_bytes: 4096, cursor: next }));
    assert.ok(pages.length <= 20, "log cursor chain must terminate");
  }
  assert.ok(pages.length >= 3, `expected the 3000-line log to span pages, got ${pages.length}`);
  return pages;
}

test("an SSH watch and SSH task keep their journal, callback receipt, and log cursors across /reload", () =>
  sshScenario(fakeTransport()));

test("live SSH: the same reload scenario against PI_LIVE_SSH_HOST", {
  skip: liveHost ? false : "opt-in: set PI_LIVE_SSH_HOST (see docs/development-and-release.md)",
  timeout: 120_000,
}, () => sshScenario(liveTransport()));
