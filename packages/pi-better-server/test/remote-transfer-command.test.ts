import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test, type TestContext } from "node:test";
import { SessionManager, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { DaemonClient } from "../src/client.ts";
import { localStateDir, readLocalRecord } from "../src/detach/local-state.ts";
import type { SessionSummary } from "../src/protocol.ts";
import { parseRemoteTransferArgs, runRemoteTransfer, type TransferFrontend } from "../src/remote-client/transfer-command.ts";
import { makeEnv, spawnDaemon, waitFor } from "./helpers.ts";

test("pull defaults to a conversation-only handoff without exposing compression as an option", () => {
  assert.deepEqual(parseRemoteTransferArgs("  pull  "), {
    direction: "pull", host: undefined, copy: false, includeWorkspace: false,
  });
  assert.deepEqual(parseRemoteTransferArgs("pull user@r5"), {
    direction: "pull", host: "user@r5", copy: false, includeWorkspace: false,
  });
  assert.deepEqual(parseRemoteTransferArgs("pull --session selected"), {
    direction: "pull", host: undefined, sessionId: "selected", copy: false, includeWorkspace: false,
  });
});

test("pull parses copy, workspace scope, destination, session, and remote server selectors independently", () => {
  for (const copy of [false, true]) {
    for (const includeWorkspace of [false, true]) {
      const flags = [copy ? "--copy" : "", includeWorkspace ? "--with-workspace" : ""].filter(Boolean).join(" ");
      assert.deepEqual(parseRemoteTransferArgs(`pull --cwd /local/destination ${flags} r5 --session abc --remote-dir /remote/server`), {
        direction: "pull", host: "r5", cwd: "/local/destination", sessionId: "abc", remoteDir: "/remote/server", copy, includeWorkspace,
      });
    }
  }
});

test("transfer command parsing refuses push and other commands rather than opening a transfer", () => {
  for (const text of ["", "push", "push r5 --copy", "connect r5", "list", "r5", "/remote pull r5"]) {
    assert.throws(() => parseRemoteTransferArgs(text), /Use \/remote connect.*\/remote pull/, text);
  }
});

test("pull refuses malformed, unknown, and user-selectable compression options", () => {
  const cases: Array<[string, RegExp | { code: string }]> = [
    ["pull r5 r6", /one SSH host/],
    ["pull ../host", /one SSH host alias/],
    ["pull r5 --cwd relative", /--cwd must be an absolute/],
    ["pull r5 --remote-dir relative", /--remote-dir must be absolute/],
    ["pull r5 --cwd", { code: "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" }],
    ["pull r5 --session", { code: "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" }],
    ["pull r5 --remote-dir", { code: "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" }],
    ["pull r5 --copy=true", { code: "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" }],
    ["pull r5 --with-workspace=true", { code: "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" }],
    ["pull r5 --unknown", { code: "ERR_PARSE_ARGS_UNKNOWN_OPTION" }],
    ["pull r5 --compression gzip", { code: "ERR_PARSE_ARGS_UNKNOWN_OPTION" }],
    ["pull r5 --gzip", { code: "ERR_PARSE_ARGS_UNKNOWN_OPTION" }],
    ["pull r5 --push", { code: "ERR_PARSE_ARGS_UNKNOWN_OPTION" }],
  ];
  for (const [text, error] of cases) assert.throws(() => parseRemoteTransferArgs(text), error, text);
});

function workspaceFiles(cwd: string): Record<string, string> {
  return Object.fromEntries(readdirSync(cwd).sort().map(name => [name, readFileSync(join(cwd, name), "utf8")]));
}

async function transferFixture(t: TestContext) {
  const remote = makeEnv();
  const { child, socketPath } = await spawnDaemon(remote);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
      child.kill("SIGKILL");
      await closed;
    }
  });
  const client = await DaemonClient.connect(socketPath);
  t.after(() => client.close());
  const local = makeEnv();
  const vars = { ...local.vars, PI_REMOTE_STATE_DIR: join(local.root, "transfer-state") };
  const previous = new Map(Object.keys(vars).map(key => [key, process.env[key]]));
  Object.assign(process.env, vars);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  writeFileSync(join(remote.cwd, "remote-only.txt"), "remote workspace stays remote");
  writeFileSync(join(local.cwd, "local-only.txt"), "local work stays untouched");
  writeFileSync(join(local.cwd, ".env"), "DESTINATION_SECRET=untouched");
  const created = await client.call({ type: "create_session", cwd: remote.cwd, name: "Pull fixture", model: { provider: "fake", modelId: "fake-1" } });
  const sessionId = created.sessionId!;
  await client.call({ type: "prompt", sessionId, message: "history to pull" });
  await waitFor("remote fixture reply", async () => {
    const state = await client.call({ type: "get_state", sessionId });
    const messages = await client.call({ type: "get_messages", sessionId });
    return !state.data.isStreaming && JSON.stringify(messages.data.messages).includes("echo:history to pull");
  });
  const sessions = async () => (await client.call({ type: "list_sessions" })).data.sessions as SessionSummary[];
  const source = (await sessions()).find(session => session.sessionId === sessionId)!;
  let closedTargets = 0;
  const resolveTarget: NonNullable<TransferFrontend["resolveTarget"]> = async options => {
    assert.equal(options.host, "fixture-host");
    assert.equal(options.remoteDir, remote.serverDir);
    return {
      socketPath,
      forwardSocket: async () => assert.fail("Unix socket tests must not open SSH forwards"),
      close: async () => { closedTargets++; },
    };
  };
  return { remote, local, source, sessions, resolveTarget, closedTargets: () => closedTargets };
}

test("real daemon: standalone pull copies then hands off conversation history without changing either workspace", async t => {
  const fixture = await transferFixture(t);
  const { local, remote, source } = fixture;
  const sourceTranscript = readFileSync(source.sessionFile!, "utf8");
  const localFiles = workspaceFiles(local.cwd);
  const remoteFiles = workspaceFiles(remote.cwd);
  for (const copy of [true, false]) {
    const notices: string[] = [];
    let approvals = 0;
    const ui = {
      select: async () => assert.fail("An explicit session must bypass session selection"),
      input: async () => assert.fail("An explicit destination must bypass destination input"),
      confirm: async (title: string, body: string) => {
        approvals++;
        assert.match(title, copy ? /Copy/ : /Move/);
        assert.ok(body.includes(`To: local:${local.cwd}`));
        assert.match(body, /Scope: conversation only/);
        assert.match(body, /Compression: gzip/);
        return true;
      },
      notify: (message: string) => { notices.push(message); },
    } as unknown as ExtensionUIContext;
    const result = await runRemoteTransfer(parseRemoteTransferArgs(`pull fixture-host --session ${source.sessionId} --cwd ${local.cwd} --remote-dir ${remote.serverDir}${copy ? " --copy" : ""}`), {
      ui, cwd: local.cwd, resolveTarget: fixture.resolveTarget,
    });
    assert.ok(result?.sessionFile, "standalone pull provides an exact resumable transcript");
    assert.equal(result.direction, "pull");
    assert.equal(result.copy, copy);
    assert.equal(result.host, "fixture-host");
    assert.equal(result.cwd, local.cwd);
    assert.equal(approvals, 1);
    if (copy) assert.notEqual(result.sessionId, source.sessionId);
    else assert.equal(result.sessionId, source.sessionId);
    const resumed = SessionManager.open(result.sessionFile);
    assert.equal(resumed.getSessionId(), result.sessionId);
    assert.equal(resumed.getCwd(), local.cwd);
    assert.match(readFileSync(result.sessionFile, "utf8"), /echo:history to pull/);
    assert.equal(readLocalRecord(localStateDir(), result.sessionId)?.state, "owned");
    const after = (await fixture.sessions()).find(session => session.sessionId === source.sessionId)!;
    assert.equal(after.ownership, copy ? undefined : "moved");
    assert.equal(after.live, copy);
    assert.equal(readFileSync(source.sessionFile!, "utf8"), sourceTranscript);
    assert.deepEqual(workspaceFiles(local.cwd), localFiles);
    assert.deepEqual(workspaceFiles(remote.cwd), remoteFiles);
    assert.ok(notices.some(message => message.includes(`pi --session '${result.sessionFile}'`)), "completion gives a runnable resume command");
    assert.ok(notices.some(message => message.startsWith(copy ? "Copied session" : "Moved session")));
  }
  assert.equal(fixture.closedTargets(), 2);
});

test("real daemon: cancelling session, destination, or scope confirmation leaves source ownership and files unchanged", async t => {
  const fixture = await transferFixture(t);
  const { local, remote, source } = fixture;
  const before = await fixture.sessions();
  const transcript = readFileSync(source.sessionFile!, "utf8");
  const localFiles = workspaceFiles(local.cwd);
  const remoteFiles = workspaceFiles(remote.cwd);
  const cases = [
    { cancel: "session", copy: false, includeWorkspace: false },
    { cancel: "destination", copy: false, includeWorkspace: false },
    { cancel: "confirmation", copy: false, includeWorkspace: false },
    { cancel: "confirmation", copy: true, includeWorkspace: true },
  ];
  for (const { cancel, copy, includeWorkspace } of cases) {
    const prompts: string[] = [];
    const ui = {
      select: async (_title: string, options: string[]) => {
        prompts.push("session");
        assert.equal(options.length, 1);
        assert.ok(options[0]!.includes(source.sessionId));
        return cancel === "session" ? undefined : options[0];
      },
      input: async (_title: string, defaultValue: string) => {
        prompts.push("destination");
        assert.equal(defaultValue, includeWorkspace ? join(local.cwd, `${basename(remote.cwd)}-${source.sessionId.slice(0, 8)}-copy`) : local.cwd);
        return cancel === "destination" ? undefined : defaultValue;
      },
      confirm: async (title: string, body: string) => {
        prompts.push("confirmation");
        assert.match(title, copy ? /Copy/ : /Move/);
        assert.match(body, includeWorkspace ? /Scope: conversation and workspace files/ : /Scope: conversation only/);
        assert.match(body, /Compression: gzip/);
        return false;
      },
      notify: () => {},
    } as unknown as ExtensionUIContext;
    const result = await runRemoteTransfer(parseRemoteTransferArgs(`pull fixture-host --remote-dir ${remote.serverDir}${copy ? " --copy" : ""}${includeWorkspace ? " --with-workspace" : ""}`), {
      ui, cwd: local.cwd, resolveTarget: fixture.resolveTarget,
    });
    assert.equal(result, undefined);
    assert.deepEqual(prompts, cancel === "session" ? ["session"] : cancel === "destination" ? ["session", "destination"] : ["session", "destination", "confirmation"]);
    assert.deepEqual(await fixture.sessions(), before);
    assert.equal(readFileSync(source.sessionFile!, "utf8"), transcript);
    assert.equal(readLocalRecord(localStateDir(), source.sessionId), undefined);
    assert.deepEqual(workspaceFiles(local.cwd), localFiles);
    assert.deepEqual(workspaceFiles(remote.cwd), remoteFiles);
  }
  assert.equal(fixture.closedTargets(), cases.length);
});
