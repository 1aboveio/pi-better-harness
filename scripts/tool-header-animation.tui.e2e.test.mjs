import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = process.env.PI_TOOL_ANIMATION_CLI ?? process.env.PI_HARNESS_SETTINGS_CLI ?? join(root, "node_modules/.bin/pi");
const tui = dirname(createRequire(realpathSync(cli)).resolve("@earendil-works/pi-tui"));
const fullscreen = existsSync(join(tui, "tui-alt-screen.js"));
const q = text => `'${text.replaceAll("'", "'\\''")}'`;
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// @covers harness.minimal-tool-animation
// @level e2e
for (const theme of ["system", "dark", "light"]) test(`${theme}: fullscreen tool names shimmer without moving text or editor focus`, {
  skip: !fullscreen ? "This Pi SDK has no fullscreen viewport" : spawnSync("tmux", ["-V"], { stdio: "ignore" }).status !== 0 ? "tmux is unavailable" : false,
}, () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-tool-animation-"));
  const socket = `tool-animation-${process.pid}`;
  const agent = join(dir, "agent");
  const ready = join(dir, "ready");
  const fixture = join(dir, "fixture.mjs");
  mkdirSync(agent);
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ theme, tuiMode: "fullscreen", packages: [], quietStartup: true,
    piBetterHarness: { toolOutput: { version: 1, enabled: true } } }));
  writeFileSync(fixture, `import { writeFileSync } from 'node:fs';
import { Type } from ${JSON.stringify(import.meta.resolve("typebox"))};
import { createAssistantMessageEventStream } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
function streamSimple(model, context) {
  const stream = createAssistantMessageEventStream();
  const finished = context.messages.at(-1)?.role === 'toolResult';
  const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
    content: finished ? [{type:'text',text:'Header proof complete'}]
      : [{type:'toolCall',id:'header-shine',name:'header_probe',arguments:{path:'header-proof'}}],
    stopReason: finished ? 'stop' : 'toolUse', timestamp: Date.now(),
    usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}} };
  queueMicrotask(() => { stream.push({type:'start',partial:message}); stream.push({type:'done',reason:message.stopReason,message}); stream.end(); });
  return stream;
}
export default function(pi) {
  pi.registerProvider('header-test',{api:'header-test-api',apiKey:'fake',baseUrl:'http://localhost:0',streamSimple,
    models:[{id:'local',name:'Local header proof',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:100000,maxTokens:4096}]});
  pi.registerTool({name:'header_probe',label:'Header probe',description:'Local delayed tool fixture',parameters:Type.Object({path:Type.String()}),
    async execute(){await new Promise(resolve=>setTimeout(resolve,5000));return {content:[{type:'text',text:'BODY_SENTINEL'}]};}});
  pi.on('session_start',async(_event,ctx)=>{await pi.setModel(ctx.modelRegistry.find('header-test','local'));writeFileSync(${JSON.stringify(ready)},'ready');});
}`);
  const tmux = (...args) => execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
  const capture = () => tmux("capture-pane", "-t", "test", "-p", "-e");
  const send = text => tmux("send-keys", "-t", "test", "-l", text);
  const key = name => tmux("send-keys", "-t", "test", name);
  const wait = predicate => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const frame = capture(); if (predicate(stripVTControlCharacters(frame))) return frame; sleep(30); }
    throw new Error(`Terminal condition timed out:\n${capture()}`);
  };
  const header = frame => frame.split("\n").find(line => stripVTControlCharacters(line).includes("Header probe"));
  try {
    const command = ["exec env", `PI_CODING_AGENT_DIR=${q(agent)}`, "PI_OFFLINE=1", "COLORTERM=truecolor", q(cli),
      "--approve --no-skills --no-context-files", "-e", q(join(root, "packages/pi-better-harness/extensions/minimal-output/index.ts")), "-e", q(fixture)].join(" ");
    tmux("new-session", "-d", "-s", "test", "-x", "100", "-y", "32", command);
    tmux("set-option", "-w", "-t", "test", "remain-on-exit", "on");
    wait(() => existsSync(ready));
    send("Run the local header fixture"); key("Enter");
    const first = wait(frame => frame.includes("Header probe") && frame.includes("(running)"));
    const firstHeader = header(first);
    const seen = new Set([firstHeader]);
    for (let sample = 0; sample < 8; sample++) {
      sleep(100);
      const frame = capture();
      const row = header(frame);
      assert.equal(stripVTControlCharacters(row), stripVTControlCharacters(firstHeader), "only foreground color changes");
      assert.equal(frame.split("\n").findIndex(line => line === row), first.split("\n").findIndex(line => line === firstHeader), "the tool row stays fixed");
      seen.add(row);
    }
    assert.ok(seen.size >= 3, "the real terminal paints multiple shimmer frames");
    send("draft stays in editor");
    wait(frame => frame.includes("draft stays in editor") && frame.includes("(running)"));
    key("C-u");
    tmux("resize-window", "-t", "test", "-x", "45", "-y", "20");
    wait(frame => frame.includes("Header probe"));
    tmux("resize-window", "-t", "test", "-x", "100", "-y", "32");
    wait(frame => frame.includes("Header probe") && frame.includes("(running)"));
    const finished = wait(frame => frame.includes("Header proof complete") && frame.includes("1 tool call"));
    assert.doesNotMatch(stripVTControlCharacters(finished), /BODY_SENTINEL|\(running\)/);
    const finalRow = finished.split("\n").find(line => line.includes("1 tool call"));
    sleep(300);
    assert.equal(capture().split("\n").find(line => line.includes("1 tool call")), finalRow);
  } finally {
    spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
    rmSync(dir, { recursive: true, force: true });
  }
});
