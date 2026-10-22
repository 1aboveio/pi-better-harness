import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The workspace SDK may be 0.82. Opt in with the actual installed 1.2 CLI:
// PI12_NATIVE_CLI=/path/to/pi node --import tsx --test test/pi-1.2-bridge.native.test.ts
const cli = process.env.PI12_NATIVE_CLI;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const fixture = fileURLToPath(new URL("./fixtures/pi-1.2-browse.mjs", import.meta.url));

for (const mode of ["regular", "fullscreen"]) {
  test(`native Pi 1.2 ${mode}: clean browse, Escape/failure restore, resize, attach`, { skip: !cli && "Set PI12_NATIVE_CLI to a Pi 1.2.0 CLI", timeout: 60_000 }, async t => {
    assert.match(execFileSync(cli!, ["--version"], { encoding: "utf8" }), /^1\.2\.0\s*$/);
    assert.equal(spawnSync("tmux", ["-V"]).status, 0, "native screen proof requires tmux");
    const root = mkdtempSync(join(tmpdir(), "pi12-browse-"));
    const socket = `pi12-browse-${process.pid}-${mode}`;
    const tmux = (...args: string[]) => execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
    t.after(() => {
      spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
      rmSync(join(process.env.TMUX_TMPDIR ?? "/tmp", `tmux-${process.getuid?.() ?? 0}`, socket), { force: true });
      rmSync(root, { recursive: true, force: true });
    });
    // Keep source and the native fixture off the workspace's older SDK resolver.
    const source = fileURLToPath(new URL("../src/remote-client/", import.meta.url));
    mkdirSync(join(root, "src", "remote-client"), { recursive: true });
    mkdirSync(join(root, "test", "fixtures"), { recursive: true });
    for (const name of ["pi-1.2-bridge.ts", "session-browser.ts", "remote-progress.ts"]) cpSync(join(source, name), join(root, "src", "remote-client", name));
    const stagedFixture = join(root, "test", "fixtures", "pi-1.2-browse.ts");
    cpSync(fixture, stagedFixture);
    let sdkRoot = dirname(realpathSync(cli!));
    while (!existsSync(join(sdkRoot, "package.json"))) {
      const parent = dirname(sdkRoot);
      assert.notEqual(parent, sdkRoot, "PI12_NATIVE_CLI must belong to an installed Pi package");
      sdkRoot = parent;
    }
    symlinkSync(resolve(sdkRoot, "../.."), join(root, "node_modules"));
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ tuiMode: mode, quietStartup: false, checkForUpdates: false }));
    const command = `cd ${quote(root)} && exec env PI_CODING_AGENT_DIR=${quote(agentDir)} PI12_BROWSE_FIXTURE_ROOT=${quote(root)} PI_OFFLINE=1 ${quote(cli!)} --no-extensions --no-skills --no-context-files -e ${quote(stagedFixture)} --session-dir ${quote(join(root, "sessions"))}`;
    tmux("new-session", "-d", "-s", "proof", "-x", "100", "-y", "32");
    tmux("set-option", "-t", "proof", "remain-on-exit", "on");
    tmux("send-keys", "-t", "proof", "-l", command);
    tmux("send-keys", "-t", "proof", "Enter");
    const screen = () => tmux("capture-pane", "-t", "proof", "-p");
    const wait = async (label: string, check: () => boolean) => {
      const deadline = performance.now() + 15_000;
      while (performance.now() < deadline) {
        const error = join(root, "error.json");
        assert.equal(existsSync(error), false, existsSync(error) ? readFileSync(error, "utf8") : "");
        if (check()) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.fail(`Timed out: ${label}\n${screen()}`);
    };
    const send = (text: string) => {
      tmux("send-keys", "-t", "proof", "C-u");
      tmux("send-keys", "-t", "proof", "-l", text);
      tmux("send-keys", "-t", "proof", "Enter");
    };
    const local = ["LOCAL_TRANSCRIPT_SENTINEL", "LOCAL_WARNING_SENTINEL", "LOCAL_WIDGET_SENTINEL", "LOCAL_FOOTER_SENTINEL", "LOCAL_DRAFT_SENTINEL"];
    const isLocal = () => local.every(text => screen().includes(text));
    const isBrowser = () => screen().includes("Remote: bridge-native");
    const resize = async (columns: number, rows: number) => {
      tmux("resize-window", "-t", "proof", "-x", String(columns), "-y", String(rows));
      await wait(`Pi rendered ${columns}x${rows}`, () => {
        const path = join(root, "frame.json");
        if (!existsSync(path)) return false;
        const frame = JSON.parse(readFileSync(path, "utf8"));
        return frame.columns === columns && frame.rows === rows && isBrowser();
      });
    };
    const cleanBrowser = () => {
      const actual = screen();
      assert.match(actual.trimStart(), /^Remote: bridge-native/);
      for (const marker of [...local, "startup help", "Pi can explain", "to interrupt"]) assert.equal(actual.includes(marker), false, actual);
    };
    await wait("startup", () => screen().includes("Pi can explain"));
    send("/bridge-seed");
    await wait("dirty local underlay", isLocal);
    assert.match(screen(), /startup help/);
    for (const failure of [false, true]) {
      send(`/bridge-browse${failure ? " fail" : ""}`);
      await wait("browser", isBrowser);
      cleanBrowser();
      await resize(42, 18);
      cleanBrowser();
      await resize(100, 32);
      cleanBrowser();
      tmux("send-keys", "-t", "proof", "Escape");
      const report = join(root, `${failure ? "failure" : "cancel"}.json`);
      await wait("restored local view and executor", () => existsSync(report) && isLocal());
      assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), { historyUnchanged: true, runtimeUnchanged: true, localExecutorWorks: true, shutdowns: 0 });
      assert.match(screen(), /startup help/);
    }
    send("/bridge-attach");
    await wait("native remote transcript", () => existsSync(join(root, "attach.json")) && screen().includes("REMOTE_TRANSCRIPT_SENTINEL"));
    assert.deepEqual(JSON.parse(readFileSync(join(root, "attach.json"), "utf8")), { attached: true, shutdowns: 1 });
    const attached = screen();
    for (const marker of [...local, "startup help", "Pi can explain", "to interrupt"]) assert.equal(attached.includes(marker), false, attached);
    t.diagnostic(`Pi 1.2.0 ${mode}: actual tmux screen clean at 100x32 and 42x18; Escape/failure restore; native attach clean`);
  });
}
