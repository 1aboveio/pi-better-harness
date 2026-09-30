import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, test } from "node:test";

import minimalOutputExtension from "../packages/pi-better-harness/extensions/minimal-output/index.ts";
import { installMinimalOutputHook } from "../packages/pi-better-harness/extensions/minimal-output/hook.ts";

const sdk = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
// The SDK may have its own TUI copy; override capabilities on the renderer's instance.
const sdkRequire = createRequire(pathToFileURL(join(sdk, "index.js")));
const { Text, getCapabilities, setCapabilities } = await import(pathToFileURL(sdkRequire.resolve("@earendil-works/pi-tui")).href);
const { ToolExecutionComponent } = await import(pathToFileURL(join(sdk, "modes/interactive/components/tool-execution.js")).href);
const { initTheme } = await import(pathToFileURL(join(sdk, "modes/interactive/theme/theme.js")).href);
const prototype = ToolExecutionComponent.prototype;
const originals = Object.fromEntries(["updateDisplay", "getResultRenderer", "getTextOutput"].map((name) => [name, prototype[name]]));
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
    assert.doesNotMatch(rendered(component), /RESULT_BODY_SENTINEL|second line/);
    assert.match(rendered(component), /read|SUBAGENT_HEADER|MCP_HEADER|unknown_external_tool/);
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
  assert.doesNotMatch(rendered(component), /ERROR_BODY_SENTINEL/);
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
  assert.doesNotMatch(rendered(component), /RESULT_BODY_SENTINEL/);
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
});
