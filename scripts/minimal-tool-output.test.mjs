import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, test } from "node:test";

import minimalOutputExtension from "../packages/pi-better-harness/extensions/minimal-output/index.ts";
import { installMinimalOutputHook, loadToolPrototype } from "../packages/pi-better-harness/extensions/minimal-output/hook.ts";

const sdk = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
// The SDK may have its own TUI copy; override capabilities on the renderer's instance.
const sdkRequire = createRequire(pathToFileURL(join(sdk, "index.js")));
const { Container, Text, getCapabilities, setCapabilities } = await import(pathToFileURL(sdkRequire.resolve("@earendil-works/pi-tui")).href);
const { AssistantMessageComponent } = await import(pathToFileURL(join(sdk, "modes/interactive/components/assistant-message.js")).href);
const { ToolExecutionComponent } = await import(pathToFileURL(join(sdk, "modes/interactive/components/tool-execution.js")).href);
const { initTheme } = await import(pathToFileURL(join(sdk, "modes/interactive/theme/theme.js")).href);
const prototype = ToolExecutionComponent.prototype;
const originals = Object.fromEntries(["updateDisplay", "getResultRenderer", "getTextOutput", "render"].map((name) => [name, prototype[name]]));
const capabilities = getCapabilities();
const handles = [];
const shutdowns = [];
const payload = Object.freeze({
  content: Object.freeze([{ type: "text", text: "RESULT_BODY_SENTINEL\nsecond line" }]),
  details: Object.freeze({ preserved: "original details" }),
  isError: false,
});

beforeEach(() => {
  initTheme("dark", false);
  setCapabilities({ ...capabilities, images: null });
});
afterEach(async () => {
  for (const stop of shutdowns.splice(0)) await stop();
  for (const handle of handles.splice(0)) handle.dispose();
  setCapabilities(capabilities);
  for (const [name, original] of Object.entries(originals)) assert.equal(prototype[name], original);
});
function install() {
  const handle = installMinimalOutputHook(prototype);
  handles.push(handle);
  return handle;
}
function tool(name, definition, result = payload) {
  const component = new ToolExecutionComponent(name, "call-demo", { path: "/tmp/demo", id: "demo" }, {}, definition, { requestRender() {} }, process.cwd());
  component.updateResult(result, false);
  return component;
}
const rendered = (component) => component.render(100).join("\n");

for (const [name, definition] of [
  ["read", undefined],
  ["subagent_result", { renderCall: () => new Text("SUBAGENT_HEADER", 0, 0), renderResult: (result) => new Text(result.content[0].text, 0, 0) }],
  ["mcp__example__query", { renderShell: "self", renderCall: () => new Text("MCP_HEADER", 0, 0), renderResult: (result) => new Text(result.content[0].text, 0, 0) }],
  ["unknown_external_tool", undefined],
]) {
  test(`minimal mode hides ${name} results, permits expansion, and restores normal rendering`, () => {
    const hook = install();
    const component = tool(name, definition);
    component.setExpanded(true);
    assert.match(rendered(component), /RESULT_BODY_SENTINEL/);
    component.setExpanded(false);
    const normalView = rendered(component);
    hook.setEnabled(true);
    assert.deepEqual(component.render(100), [], "hidden tools must consume zero transcript rows");
    assert.equal(component.result, payload, "the agent-facing result object must remain untouched");
    component.setExpanded(true);
    assert.match(rendered(component), /RESULT_BODY_SENTINEL/);
    component.setExpanded(false);
    assert.doesNotMatch(rendered(component), /RESULT_BODY_SENTINEL/);
    hook.setEnabled(false);
    assert.equal(rendered(component), normalView);
  });
}

test("minimal mode suppresses streaming error bodies and inline images without deleting their payloads", () => {
  setCapabilities({ ...capabilities, images: "iterm2" });
  const hook = install();
  const imageResult = {
    content: [{ type: "text", text: "ERROR_BODY_SENTINEL" }, { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=" }],
    isError: true,
  };
  const component = tool("external_image", undefined, imageResult);
  assert.equal(component.imageComponents.length, 1);
  hook.setEnabled(true);
  component.updateResult(imageResult, true);
  assert.deepEqual(component.render(100), []);
  assert.equal(component.imageComponents.length, 0);
  assert.equal(component.result, imageResult);
  assert.equal(component.result.isError, true);
  assert.equal(component.showImages, true, "the user's image preference must not be changed");
  component.setExpanded(true);
  assert.match(rendered(component), /ERROR_BODY_SENTINEL/);
  assert.equal(component.imageComponents.length, 1);
});

test("new tool rows and streaming updates stay hidden, and custom renderer reuse survives expansion", () => {
  const hook = install();
  hook.setEnabled(true);
  const seenComponents = [];
  const definition = {
    renderCall: () => new Text("STATEFUL_HEADER", 0, 0),
    renderResult: (result, _options, _theme, context) => {
      seenComponents.push(context.lastComponent);
      const component = context.lastComponent ?? new Text("", 0, 0);
      component.setText(result.content[0].text);
      return component;
    },
  };
  const component = tool("stateful_extension", definition);
  assert.deepEqual(component.render(100), []);
  assert.equal(seenComponents.length, 0, "hidden result renderers should not run");
  component.setExpanded(true);
  assert.match(rendered(component), /RESULT_BODY_SENTINEL/);
  const cached = component.resultRendererComponent;
  component.setExpanded(false);
  const updated = { content: [{ type: "text", text: "STREAMING_UPDATE_SENTINEL" }], details: { progress: 2 } };
  component.updateResult(updated, true);
  assert.doesNotMatch(rendered(component), /STREAMING_UPDATE_SENTINEL/);
  assert.equal(component.result, updated);
  component.setExpanded(true);
  assert.equal(seenComponents.at(-1), cached);
  assert.match(rendered(component), /STREAMING_UPDATE_SENTINEL/);
});

test("minimal mode hides a running tool before any result arrives", () => {
  const hook = install();
  hook.setEnabled(true);
  const component = new ToolExecutionComponent("bash", "running-bash", { command: "ls -la" }, {}, undefined, { requestRender() {} }, process.cwd());
  assert.deepEqual(component.render(100), []);
  component.updateResult(payload, true);
  assert.deepEqual(component.render(100), []);
  component.setExpanded(true);
  assert.match(rendered(component), /ls -la/);
  assert.match(rendered(component), /RESULT_BODY_SENTINEL/);
  component.setExpanded(false);
  assert.deepEqual(component.render(100), []);
});

test("duplicate hook owners do not stack wrappers and the last disposal restores ordinary output", () => {
  const first = install();
  const wrapped = prototype.updateDisplay;
  const second = install();
  assert.equal(prototype.updateDisplay, wrapped);
  const component = tool("unknown_external_tool");
  second.setEnabled(true);
  first.dispose();
  assert.doesNotMatch(rendered(component), /RESULT_BODY_SENTINEL/);
  second.dispose();
  second.dispose();
  assert.match(rendered(component), /RESULT_BODY_SENTINEL/);
});

test("an incompatible Pi display API is refused without installing a partial hook", () => {
  const incompatible = { updateDisplay() {} };
  const original = incompatible.updateDisplay;
  assert.throws(() => installMinimalOutputHook(incompatible), /incompatible: missing getResultRenderer/);
  assert.equal(incompatible.updateDisplay, original);
});

test("slash-command argument completion offers both modes and filters partial arguments", () => {
  let command;
  minimalOutputExtension({
    on() {},
    registerCommand: (_name, definition) => { command = definition; },
  });
  const complete = command.getArgumentCompletions;
  assert.deepEqual(complete("").map((option) => option.value), ["minimal", "normal"]);
  assert.deepEqual(complete("mi").map((option) => option.value), ["minimal"]);
  assert.deepEqual(complete("nor").map((option) => option.value), ["normal"]);
  assert.deepEqual(complete("   MI").map((option) => option.value), ["minimal"]);
  assert.equal(complete("unknown"), null);
  assert.equal(complete("minimal extra"), null);
  assert.match(command.description, /^\[minimal\|normal\] — /);
});

test("print and RPC modes refuse the toggle without changing saved preferences", async () => {
  for (const mode of ["print", "rpc"]) {
    let command;
    const lifecycle = new Map();
    const saved = [];
    const notices = [];
    minimalOutputExtension({
      on: (name, handler) => lifecycle.set(name, handler),
      registerCommand: (_name, definition) => { command = definition; },
      appendEntry: (...args) => saved.push(args),
    });
    await lifecycle.get("session_start")({}, { mode });
    await command.handler("minimal", { mode, ui: { notify: (message) => notices.push(message) } });
    assert.match(notices[0], /only in Pi's interactive TUI/);
    assert.equal(saved.length, 0);
  }
});

test("the command toggles existing rows, persists session preference, and restores the hook on reload", async () => {
  const commands = new Map();
  const handlers = new Map();
  const entries = [];
  const notices = [];
  let expanded = false;
  const existing = tool("unknown_external_tool");
  const ctx = {
    mode: "tui", cwd: process.cwd(),
    sessionManager: { getBranch: () => entries },
    ui: {
      notify: (message) => notices.push(message), setStatus() {},
      getToolsExpanded: () => expanded,
      setToolsExpanded(value) { if (expanded === value) return; expanded = value; existing.setExpanded(value); },
    },
  };
  minimalOutputExtension({
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
  });
  shutdowns.push(() => handlers.get("session_shutdown")());
  await handlers.get("session_start")({}, ctx);
  await commands.get("tool-output").handler("minimal", ctx);
  assert.doesNotMatch(rendered(existing), /RESULT_BODY_SENTINEL/);
  assert.equal(entries.at(-1).data.enabled, true);
  assert.equal(expanded, false);
  await handlers.get("session_shutdown")();
  assert.match(rendered(existing), /RESULT_BODY_SENTINEL/);
  await handlers.get("session_start")({}, ctx);
  assert.doesNotMatch(rendered(existing), /RESULT_BODY_SENTINEL/);
  await commands.get("tool-output").handler("", ctx);
  assert.match(rendered(existing), /RESULT_BODY_SENTINEL/);
  assert.equal(entries.at(-1).data.enabled, false);
  assert.match(notices.at(-1), /Normal tool output restored/);
  assert.match(notices.find((message) => message.startsWith("Minimal tool output on")), /Tool blocks are hidden/);
});

const bundledCli = process.env.PI_MINIMAL_OUTPUT_HOST_CLI ?? join(sdk, "bundle/cli.js");
test("minimal mode patches the running bundled host and removes its bash block entirely", {
  skip: !process.env.PI_MINIMAL_OUTPUT_HOST_CLI && !existsSync(bundledCli)
    ? "This SDK has no bundled CLI; set PI_MINIMAL_OUTPUT_HOST_CLI to test one" : false,
}, async () => {
  const argv = process.argv[1];
  let hook;
  try {
    process.argv[1] = bundledCli;
    const host = await import(pathToFileURL(join(dirname(bundledCli), "index.js")).href);
    host.initTheme("dark", false);
    const toolPrototype = await loadToolPrototype();
    assert.equal(toolPrototype, host.ToolExecutionComponent.prototype, "patch the class actually used by the CLI");
    const originalRender = toolPrototype.render;
    const HostContainer = Object.getPrototypeOf(host.ToolExecutionComponent.prototype).constructor;
    hook = installMinimalOutputHook(toolPrototype);
    const chat = new HostContainer();
    const ui = { requestRender() {}, children: [chat] };
    const component = new host.ToolExecutionComponent("bash", "bundled-bash", { command: "ls -la" }, {}, host.createBashToolDefinition(process.cwd()), ui, process.cwd());
    component.updateResult(payload, false);
    chat.addChild(component);
    assert.match(rendered(chat), /RESULT_BODY_SENTINEL/);
    hook.setEnabled(true);
    assert.deepEqual(chat.render(100), [], "no header, result, summary, or spacer survives");
    const message = new host.AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text: "BUNDLED_MODEL_TEXT" }], stopReason: "stop" });
    chat.addChild(message);
    assert.deepEqual(chat.render(100), message.render(100));
    component.setExpanded(true);
    assert.match(rendered(chat), /RESULT_BODY_SENTINEL/);
    component.setExpanded(false);
    hook.setEnabled(false);
    assert.match(rendered(chat), /RESULT_BODY_SENTINEL/);
    assert.equal(component.result, payload);
    hook.dispose();
    assert.equal(toolPrototype.render, originalRender);
    assert.match(rendered(chat), /RESULT_BODY_SENTINEL/);
    hook = installMinimalOutputHook(await loadToolPrototype());
    hook.setEnabled(true);
    assert.deepEqual(chat.render(100), message.render(100), "reinstalling after reload must still hide restored tools");
  } finally {
    hook?.dispose();
    process.argv[1] = argv;
  }
});

function modelText(text, extra = []) {
  return new AssistantMessageComponent({
    role: "assistant",
    content: [{ type: "text", text }, ...extra],
    stopReason: "stop",
  });
}
function placedTool(name, ui, result = payload) {
  const component = new ToolExecutionComponent(name, `call-${name}`, { path: `/tmp/${name}-arg` }, {}, undefined, ui, process.cwd());
  component.updateResult(result, false);
  component.setExpanded(false);
  return component;
}

test("minimal mode removes completed and live tool rows without adding summaries or spacers", () => {
  const hook = installMinimalOutputHook(prototype);
  handles.push(hook);
  const ui = { requestRender() {}, children: [] };
  const chat = new Container();
  ui.children.push(chat);
  const read = placedTool("read", ui);
  const edit = placedTool("edit", ui, { content: [{ type: "text", text: "EDIT_BODY" }], isError: true });
  const live = placedTool("live_probe", ui, { content: [{ type: "text", text: "LIVE_BODY" }], isError: false });
  const first = modelText("FIRST_MODEL_TEXT");
  const thinking = new AssistantMessageComponent({ role: "assistant", content: [{ type: "thinking", thinking: "ONLY_THINKING" }], stopReason: "toolUse" });
  const second = modelText("SECOND_MODEL_TEXT");
  for (const component of [first, thinking, read, edit, second, live]) chat.addChild(component);
  const normal = chat.render(100);
  hook.setEnabled(true);

  for (const width of [20, 100]) {
    assert.deepEqual(chat.render(width), [first, thinking, second].flatMap((component) => component.render(width)), "tool rows must add no transcript height");
  }
  assert.equal(read.result, payload);
  assert.equal(edit.result.isError, true);

  read.setExpanded(true);
  edit.setExpanded(true);
  assert.match(rendered(chat), /RESULT_BODY_SENTINEL/);
  assert.match(rendered(chat), /EDIT_BODY/);
  assert.doesNotMatch(rendered(chat), /LIVE_BODY|live_probe-arg/);
  read.setExpanded(false);
  edit.setExpanded(false);
  assert.deepEqual(chat.render(100), [first, thinking, second].flatMap((component) => component.render(100)));

  hook.dispose();
  assert.deepEqual(chat.render(100), normal);
});
