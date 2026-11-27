import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { LineDecoder } from "../src/protocol.ts";

test("agents commands adopt the atomic subscription snapshot after a get/subscribe external edit", { timeout: 30000 }, async () => {
  const parent = resolve("../../.work/758"); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "subscription-handoff-"));
  const transport = mkdtempSync("/tmp/p758-handoff-");
  const agent = join(root, "agent"), cwd = join(root, "project");
  mkdirSync(agent); mkdirSync(join(cwd, ".pi/agents/roles"), { recursive: true });
  const definitionPath = join(cwd, ".pi/agents/roles/fixture.md");
  const definition = (name: string) => `---\nschema: pi-agent/v1\nkind: role\nid: role.fixture\nname: ${name}\n---\n${name} instructions.\n`;
  const child = fork(new URL("./support/work-daemon.ts", import.meta.url), [], {
    execArgv: ["--import", "tsx"], env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_SERVER_DIR: join(transport, "daemon"), TMPDIR: root },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let errors = "", pendingEdit: string | undefined, edits = 0;
  child.stderr!.on("data", data => { errors += data; });
  const sockets = new Set<Socket>();
  let proxy: ReturnType<typeof createServer> | undefined;
  const admissionPath = new URL("../../pi-better-subagents/catalog-host-admission.ts", import.meta.url).href;
  const { noteCatalogHostContext, closeCatalogHost } = await import(admissionPath);
  try {
    const [message] = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(`daemon startup failed: ${errors}`); })]);
    proxy = createServer(frontend => {
      const backend = connect(message.ready);
      for (const socket of [frontend, backend]) { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); }
      frontend.on("error", () => backend.destroy()); backend.on("error", () => frontend.destroy());
      frontend.on("close", () => backend.destroy()); backend.on("close", () => frontend.destroy());
      backend.pipe(frontend);
      const decoder = new LineDecoder(line => {
        const request = JSON.parse(line);
        // The awaited get has returned A. Commit B before forwarding subscribe;
        // the real observer will capture B without any later source mutation.
        if (request.type === "runtime_subscribe_catalog" && pendingEdit) {
          writeFileSync(definitionPath, definition(pendingEdit)); pendingEdit = undefined; edits++;
        }
        backend.write(`${line}\n`);
      }, () => frontend.destroy());
      frontend.setEncoding("utf8"); frontend.on("data", (chunk: string) => decoder.push(chunk));
    });
    proxy.listen(join(transport, "pi-server.sock")); await once(proxy, "listening");
    writeFileSync(join(agent, "server-registration-v1.json"), JSON.stringify({ version: 1, agentDir: agent, serverDir: transport }));
    const commandsPath = new URL("../../pi-better-subagents/agent-commands.ts", import.meta.url).href;
    const { executeAgentsCommand } = await import(commandsPath);
    const cases = [
      { args: "list", ui: false }, { args: "inspect role.fixture", ui: false },
      { args: "show role.fixture", ui: false }, { args: "reload", ui: false },
      { args: "list", ui: true }, { args: "inspect role.fixture", ui: true }, { args: "", ui: true },
    ];
    for (const [index, entry] of cases.entries()) {
      writeFileSync(definitionPath, definition(`Before${index}`));
      const expected = `Subscribed${index}`;
      pendingEdit = expected;
      noteCatalogHostContext({ cwd, isProjectTrusted: () => true }, () => ({}));
      let rendered = "";
      const result = await executeAgentsCommand(entry.args, {
        cwd, isProjectTrusted: () => true, hasUI: entry.ui, mode: entry.ui ? "tui" : "print",
        ui: { notify() {}, setWidget() {}, async custom(factory: Function) {
          const component = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text }, {}, () => {});
          rendered = component.render(120).join("\n");
        } },
      }, { userRoot: agent, sharedCatalog: true });
      assert.equal(result.ok, true);
      assert.equal(pendingEdit, undefined, "the proxy injected exactly the get/subscribe race");
      const data = result.data as any;
      const view = data.entries ? data.entries.find((row: any) => row.id === "role.fixture") : data;
      assert.equal(view.identity.name, expected, `${entry.args || "bare /agents"} must adopt B without a later edit`);
      if (entry.ui) assert.ok(rendered.includes(expected), "the actual initial catalog component renders B");
      closeCatalogHost();
    }
    assert.equal(edits, cases.length, "one external edit per invocation; no second edit repairs the view");
    const settingsPath = new URL("../../pi-better-subagents/agent-session-settings.ts", import.meta.url).href;
    const { createAgentSessionSettings } = await import(settingsPath);
    const sessionSettings = createAgentSessionSettings({ appendEntry() {} });
    noteCatalogHostContext({ cwd, isProjectTrusted: () => true }, () => sessionSettings.snapshot());
    writeFileSync(definitionPath, definition("BeforeEdit")); pendingEdit = "SubscribedEdit";
    const edited = await executeAgentsCommand("inspect role.fixture", {
      cwd, isProjectTrusted: () => true, hasUI: true, mode: "tui",
      ui: { notify() {}, setWidget() {}, custom(factory: Function) {
        return new Promise(resolve => {
          let component: any, awaitingSourceUpdate = false;
          component = factory({ requestRender() {
            const text = component?.render(120).join("\n") ?? "";
            if (awaitingSourceUpdate) {
              awaitingSourceUpdate = false;
              queueMicrotask(() => { component.handleInput("\r"); component.handleInput("\x13"); });
            }
            if (text.includes("catalog-conflict")) resolve(undefined);
          } }, { fg: (_color: string, text: string) => text }, {}, resolve);
          component.render(120);
          component.handleInput("\x1b[B"); component.handleInput("\r");
          awaitingSourceUpdate = true;
          // A separate edit after the picker opens must not reset its starting
          // revision when the live subscription refreshes the underlying view.
          writeFileSync(definitionPath, definition("DuringEdit"));
        });
      } },
    }, { userRoot: agent, sharedCatalog: true, sessionSettings });
    assert.equal(edited.wrote, false, "an in-progress edit retains its old revision and conflicts after a source refresh");
  } finally {
    closeCatalogHost();
    for (const socket of sockets) socket.destroy();
    if (proxy) await new Promise<void>(resolve => proxy!.close(() => resolve()));
    if (child.exitCode === null) { const exited = once(child, "exit"); child.send("stop"); await exited; }
    rmSync(root, { recursive: true, force: true }); rmSync(transport, { recursive: true, force: true });
  }
});
