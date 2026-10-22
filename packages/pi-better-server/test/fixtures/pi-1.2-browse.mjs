import assert from "node:assert/strict";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { getPi12Bridge, installPi12Bridge } from "../../src/remote-client/pi-1.2-bridge.ts";
import { browseRemoteSessions } from "../../src/remote-client/session-browser.ts";

// Run only inside the native test's isolated Pi process, never a user's runtime.
export default function (pi) {
  installPi12Bridge();
  const root = process.env.PI12_BROWSE_FIXTURE_ROOT;
  let shutdowns = 0;
  pi.on("session_shutdown", () => { shutdowns++; });
  const report = (name, value) => {
    const path = join(root, `${name}.json`);
    writeFileSync(`${path}.next`, JSON.stringify(value));
    renameSync(`${path}.next`, path);
  };
  pi.registerCommand("bridge-seed", {
    description: "Seed a dirty native local screen",
    handler: async (_args, ctx) => {
      const mode = getPi12Bridge(ctx.sessionManager).mode;
      const render = mode.editorContainer.render;
      mode.editorContainer.render = function (width) {
        const lines = render.call(this, width);
        report("frame", { columns: width, rows: mode.ui.terminal.rows });
        return lines;
      };
      pi.sendMessage({ customType: "browse-proof", content: "LOCAL_TRANSCRIPT_SENTINEL", display: true }, { triggerTurn: false });
      ctx.ui.notify("LOCAL_WARNING_SENTINEL", "warning");
      ctx.ui.setWidget("browse-proof", ["LOCAL_WIDGET_SENTINEL"]);
      ctx.ui.setStatus("browse-proof", "LOCAL_FOOTER_SENTINEL");
      ctx.ui.setEditorText("LOCAL_DRAFT_SENTINEL");
      report("seed", { ready: true });
    },
  });
  pi.registerCommand("bridge-browse", {
    description: "Exercise a native browser scope",
    handler: async (args, ctx) => {
      const bridge = getPi12Bridge(ctx.sessionManager);
      const mode = bridge.mode;
      const local = mode.runtimeHost.session;
      const identities = [local, local.agent, mode.renderer, mode.ui, mode.editor, mode.unsubscribe, local.prompt, local.executeBash];
      const history = JSON.stringify(ctx.sessionManager.getEntries());
      ctx.ui.setEditorText("LOCAL_DRAFT_SENTINEL");
      const cleanup = bridge.beginBrowse();
      try {
        const choice = await browseRemoteSessions(ctx.ui, { call: async () => ({ data: { sessions: [] } }) }, "bridge-native", { cwd: ctx.cwd });
        assert.equal(choice, undefined);
        if (args === "fail") await ctx.ui.custom(() => { throw new Error("expected browser failure"); });
      } catch (error) {
        if (args !== "fail" || error.message !== "expected browser failure") {
          report("error", { message: String(error), stack: error.stack });
          throw error;
        }
      } finally {
        cleanup();
        cleanup();
      }
      assert.deepEqual([mode.runtimeHost.session, local.agent, mode.renderer, mode.ui, mode.editor, mode.unsubscribe, local.prompt, local.executeBash], identities);
      assert.equal(JSON.stringify(ctx.sessionManager.getEntries()), history);
      assert.equal(ctx.ui.getEditorText(), "LOCAL_DRAFT_SENTINEL");
      assert.equal(shutdowns, 0);
      const result = await local.executeBash("printf native-local-executor");
      assert.equal(result.output, "native-local-executor");
      report(args === "fail" ? "failure" : "cancel", { historyUnchanged: true, runtimeUnchanged: true, localExecutorWorks: true, shutdowns });
    },
  });
  pi.registerCommand("bridge-attach", {
    description: "Check native attachment transcript rendering",
    handler: async (_args, ctx) => {
      try {
        const bridge = getPi12Bridge(ctx.sessionManager);
        const agentDir = join(root, "remote-agent");
        mkdirSync(agentDir, { recursive: true });
        const manager = SessionManager.inMemory(ctx.cwd);
        manager.appendMessage({ role: "user", content: "REMOTE_TRANSCRIPT_SENTINEL", timestamp: 0 });
        // A separate native session stands in for the adapter here. No model turn
        // or tools run remotely; this test owns renderer/lifecycle proof, not SSH.
        const { session: remote } = await createAgentSession({ cwd: ctx.cwd, agentDir, sessionManager: manager });
        const cleanup = bridge.beginBrowse();
        await bridge.attach(remote);
        cleanup();
        report("attach", { attached: true, shutdowns });
      } catch (error) {
        report("error", { message: String(error), stack: error.stack });
        throw error;
      }
    },
  });
}
