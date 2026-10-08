import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, test } from "node:test";
import { EventEmitter } from "node:events";
import { stripVTControlCharacters } from "node:util";
import { createSettingsRegistry } from "../packages/pi-better-harness/extensions/settings/registry.ts";
import { chooseHarnessSetting } from "../packages/pi-better-harness/extensions/settings/page.ts";

import minimalOutputExtension from "../packages/pi-better-harness/extensions/minimal-output/index.ts";
import { installMinimalOutputHook, loadToolPrototype, loadCompactionPrototype, loadCustomMessagePrototype } from "../packages/pi-better-harness/extensions/minimal-output/hook.ts";
import { toolIdentity } from "../packages/pi-better-harness/extensions/minimal-output/tool-identity.ts";
import { toolVisibility } from "../packages/pi-better-harness/extensions/minimal-output/tool-visibility.ts";
import subagentsExtension from "../packages/pi-better-subagents/index.ts";
import backgroundTasksExtension from "../packages/pi-better-background-tasks/src/index.ts";
import goalExtension from "../packages/pi-better-goal/src/index.ts";
import planExtension from "../packages/pi-better-plan/src/index.ts";
import sshExtension from "../packages/pi-better-ssh/src/index.ts";

const sdk = process.env.PI_MINIMAL_OUTPUT_TEST_SDK_DIR
  ? join(process.env.PI_MINIMAL_OUTPUT_TEST_SDK_DIR, "dist")
  : dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
// The SDK may have its own TUI copy; override capabilities on the renderer's instance.
const sdkRequire = createRequire(pathToFileURL(join(sdk, "index.js")));
const { Box, Container, Text, TUI, TuiMainScreen, getCapabilities, setCapabilities, visibleWidth } = await import(pathToFileURL(sdkRequire.resolve("@earendil-works/pi-tui")).href);
const { dispatchMouseEvent } = await import(pathToFileURL(join(dirname(sdkRequire.resolve("@earendil-works/pi-tui")), "tui.js")).href);
const originalArgv = process.argv[1];
const { SessionManager } = await import(pathToFileURL(join(sdk, "index.js")).href);
const { AssistantMessageComponent } = await import(pathToFileURL(join(sdk, "modes/interactive/components/assistant-message.js")).href);
const { ToolExecutionComponent } = await import(pathToFileURL(join(sdk, "modes/interactive/components/tool-execution.js")).href);
const { CompactionSummaryMessageComponent } = await import(pathToFileURL(join(sdk, "modes/interactive/components/compaction-summary-message.js")).href);
const { CustomMessageComponent } = await import(pathToFileURL(join(sdk, "modes/interactive/components/custom-message.js")).href);
const themeModule = await import(pathToFileURL(join(sdk, "modes/interactive/theme/theme.js")).href);
const { initTheme } = themeModule;
function events() {
  const bus = new EventEmitter();
  return { on(name, handler) { bus.on(name, handler); return () => bus.off(name, handler); }, emit: (name, data) => bus.emit(name, data) };
}
const prototype = ToolExecutionComponent.prototype;
const originals = Object.fromEntries(["updateDisplay", "getResultRenderer", "getTextOutput", "setExpanded", "render", ...(typeof prototype.handleMouse === "function" ? ["handleMouse"] : [])].map((name) => [name, prototype[name]]));
const capabilities = getCapabilities();
const handles = [];
const shutdowns = [];
let settingsRoot;
let originalAgentDir;
const payload = Object.freeze({
  content: Object.freeze([{ type: "text", text: "RESULT_BODY_SENTINEL\nsecond line" }]),
  details: Object.freeze({ preserved: "original details" }),
  isError: false,
});

beforeEach(() => {
  originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  settingsRoot = mkdtempSync(join(tmpdir(), "tool-output-settings-"));
  process.env.PI_CODING_AGENT_DIR = settingsRoot;
  if (process.env.PI_MINIMAL_OUTPUT_TEST_SDK_DIR) process.argv[1] = join(sdk, "cli.js");
  initTheme("dark", false);
  setCapabilities({ ...capabilities, images: null });
});
afterEach(async () => {
  process.argv[1] = originalArgv;
  for (const stop of shutdowns.splice(0)) await stop();
  for (const handle of handles.splice(0)) handle.dispose();
  setCapabilities(capabilities);
  for (const [name, original] of Object.entries(originals)) assert.equal(prototype[name], original);
  rmSync(settingsRoot, { recursive: true, force: true });
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
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
function animationUI(components, requestRender) {
  const rect = { x: 0, y: 0, width: 100, height: 100 };
  return { mode: "fullscreen", requestRender, get currentLayout() {
    return { root: { component: {}, rect, clip: rect, children: components().filter(Boolean).map((component, index) => ({
      component, rect: { ...rect, y: index, height: 1 }, clip: rect, children: [],
    })) } };
  } };
}
const rendered = (component) => component.render(100).join("\n");

test("fallback tools show arguments even with a definition but no custom call renderer", () => {
  const hook = install();
  hook.setEnabled(true);
  for (const definition of [undefined, { renderResult: () => new Text("RESULT_BODY_SENTINEL", 0, 0) }]) {
    const component = new ToolExecutionComponent("compaction", "fallback", { reason: "manual", note: "first\nsecond" }, {}, definition, { requestRender() {} }, process.cwd());
    component.updateResult(payload, false);
    assert.match(rendered(component), /Compaction.*manual.*first/);
    assert.equal(component.render(100).length, 1);
    assert.doesNotMatch(rendered(component), /RESULT_BODY_SENTINEL|\x1b\[(?:48|4[0-7])[;m]/);
    component.updateArgs({ path: "/tmp/new-target" });
    assert.match(rendered(component), /new-target/);
    assert.doesNotMatch(rendered(component), /manual/);
    component.setExpanded(true);
    assert.match(rendered(component), /RESULT_BODY_SENTINEL/);
  }
});

test("compaction summaries fold to one quiet row, expand original details, and restore on disposal", () => {
  const prototype = CompactionSummaryMessageComponent.prototype;
  const original = prototype.render;
  const hook = installMinimalOutputHook(ToolExecutionComponent.prototype, () => themeModule.theme, prototype);
  handles.push(hook);
  const message = { summary: "COMPACTION_SUMMARY_SENTINEL", tokensBefore: 12345 };
  const component = new CompactionSummaryMessageComponent(message);
  const normal = rendered(component);
  hook.setEnabled(true);
  for (const width of [0, 1, 8, 24, 100]) {
    const lines = component.render(width);
    assert.equal(lines.length, width > 0 ? 1 : 0);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    assert.doesNotMatch(lines.join("\n"), /COMPACTION_SUMMARY_SENTINEL|\x1b\[(?:48|4[0-7])[;m]/);
  }
  assert.match(stripVTControlCharacters(rendered(component)), /Compaction.*12,345 tokens/);
  assert.equal(component.message, message);
  component.setExpanded(true);
  assert.match(rendered(component), /COMPACTION_SUMMARY_SENTINEL/);
  hook.setEnabled(true);
  assert.equal(component.expanded, false);
  hook.setEnabled(false);
  assert.equal(rendered(component), normal);
  hook.dispose();
  assert.equal(prototype.render, original);
  assert.equal(rendered(component), normal);
});

test("custom messages fold generically, preserve payloads and native renderers, and expand through transcript controls", async () => {
  const customPrototype = await loadCustomMessagePrototype();
  assert.equal(customPrototype, CustomMessageComponent.prototype);
  const original = customPrototype.render;
  const renderDescriptor = Object.getOwnPropertyDescriptor(customPrototype, "render");
  const mouseDescriptor = Object.getOwnPropertyDescriptor(customPrototype, "handleMouse");
  const hook = installMinimalOutputHook(prototype, () => themeModule.theme, undefined, customPrototype);
  handles.push(hook);
  const cases = [
    ["background-completion-batch", "\n1 background completion is ready:\nCALLBACK_DETAIL_SENTINEL"],
    ["subagent-stuck", "Worker stalled\nCALLBACK_DETAIL_SENTINEL"],
    ["external_extension_message", Object.freeze([
      Object.freeze({ type: "text", text: "\u72b6\u6001 ready\nCALLBACK_DETAIL_SENTINEL" }),
      Object.freeze({ type: "image", mimeType: "image/png", data: "preserved" }),
    ])],
    ["empty_notice", []],
  ];
  const components = cases.map(([customType, content]) => new CustomMessageComponent(
    Object.freeze({ role: "custom", customType, content, display: true }), undefined, undefined, 2));
  const custom = new CustomMessageComponent(
    Object.freeze({ customType: "third_party", content: "Custom renderer preview\nCALLBACK_DETAIL_SENTINEL" }),
    (_message, { expanded }) => new Text(expanded ? "NATIVE_EXPANDED_SENTINEL" : "NATIVE_COLLAPSED_SENTINEL", 0, 0));
  components.push(custom);
  const normal = components.map(rendered);
  hook.setEnabled(true);
  for (const component of components) {
    const message = component.message;
    for (const width of [0, 1, 8, 24, 100]) {
      const lines = component.render(width);
      assert.equal(lines.length, width > 0 ? 1 : 0);
      assert.ok(lines.every(line => visibleWidth(line) <= width));
      assert.doesNotMatch(lines.join("\n"), /CALLBACK_DETAIL_SENTINEL|NATIVE_.*SENTINEL|\x1b\[(?:48|4[0-7])[;m]/);
    }
    assert.equal(component.message, message);
    component.setExpanded(true);
    if (component === custom) assert.match(rendered(component), /NATIVE_EXPANDED_SENTINEL/);
    else if (message.customType !== "empty_notice") assert.match(rendered(component), /CALLBACK_DETAIL_SENTINEL/);
    component.setExpanded(false);
  }
  assert.match(stripVTControlCharacters(rendered(components[0])), /^ {4}.*Background completion batch.*1 background completion/);
  assert.match(stripVTControlCharacters(rendered(components[2])), /\u72b6\u6001 ready/);
  const event = { type: "click", button: "left", x: 4, y: 0, screenX: 4, screenY: 0, width: 100 };
  assert.equal(components[0].handleMouse({ ...event, ctrl: true }), undefined);
  assert.equal(components[0].render(100).length, 1);
  assert.equal(components[0].handleMouse(event).handled, true);
  assert.match(rendered(components[0]), /CALLBACK_DETAIL_SENTINEL/);
  hook.setEnabled(true);
  assert.equal(components[0].render(100).length, 1, "re-enabling folds existing messages");
  hook.setEnabled(false);
  assert.deepEqual(components.map(rendered), normal);
  hook.dispose();
  assert.equal(customPrototype.render, original);
  assert.deepEqual(Object.getOwnPropertyDescriptor(customPrototype, "render"), renderDescriptor);
  assert.deepEqual(Object.getOwnPropertyDescriptor(customPrototype, "handleMouse"), mouseDescriptor);
  assert.deepEqual(components.map(rendered), normal);
});

test("fullscreen container dispatch expands a generic custom-message disclosure", {
  skip: typeof dispatchMouseEvent !== "function" ? "This Pi SDK has no fullscreen mouse routing" : false,
}, () => {
  const hook = installMinimalOutputHook(prototype, undefined, undefined, CustomMessageComponent.prototype);
  handles.push(hook);
  const chat = new Container();
  const component = new CustomMessageComponent({ customType: "external_notice", content: "Preview\nMOUSE_CALLBACK_DETAIL" });
  chat.addChild(component);
  hook.setEnabled(true);
  assert.equal(chat.render(80).length, 1);
  const result = dispatchMouseEvent(chat, {
    type: "click", button: "left", x: 4, y: 0, screenX: 4, screenY: 0,
    width: 80, height: 1, shift: false, ctrl: false, alt: false,
  });
  assert.equal(result.handled, true);
  assert.match(rendered(chat), /MOUSE_CALLBACK_DETAIL/);
});

test("custom-message hook owners share wrappers and disposal preserves a later extension wrapper", () => {
  const customPrototype = CustomMessageComponent.prototype;
  const originalDescriptor = Object.getOwnPropertyDescriptor(customPrototype, "render");
  const original = customPrototype.render;
  const first = installMinimalOutputHook(prototype, undefined, undefined, customPrototype);
  const second = installMinimalOutputHook(prototype, undefined, undefined, customPrototype);
  handles.push(first, second);
  const wrapped = customPrototype.render;
  const component = new CustomMessageComponent({ customType: "external_notice", content: "Preview\nOWNER_DETAIL_SENTINEL" });
  first.setEnabled(true);
  first.dispose();
  assert.equal(customPrototype.render, wrapped);
  assert.equal(component.render(100).length, 1);
  const later = function(width) { return wrapped.call(this, width); };
  customPrototype.render = later;
  try {
    second.dispose();
    assert.equal(customPrototype.render, later);
    assert.match(rendered(component), /OWNER_DETAIL_SENTINEL/, "the retained wrapper falls back to normal output");
  } finally {
    if (originalDescriptor) Object.defineProperty(customPrototype, "render", originalDescriptor);
    else Reflect.deleteProperty(customPrototype, "render");
  }
  assert.equal(customPrototype.render, original);
});

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
    assert.equal(component.render(100).length, 1, "collapsed tools retain exactly one header row");
    assert.match(rendered(component), name === "read" ? /demo/ : name === "subagent_result" ? /SUBAGENT_HEADER/ : name === "mcp__example__query" ? /MCP_HEADER/ : /Unknown external tool/);
    assert.doesNotMatch(rendered(component), /RESULT_BODY_SENTINEL/);
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
  assert.equal(component.render(100).length, 1);
  assert.equal(component.imageComponents.length, 0);
  assert.equal(component.result, imageResult);
  assert.equal(component.result.isError, true);
  assert.equal(component.showImages, true, "the user's image preference must not be changed");
  component.setExpanded(true);
  assert.match(rendered(component), /ERROR_BODY_SENTINEL/);
  assert.equal(component.imageComponents.length, 1);
});

test("actual Harness tools retain useful compact calls, hide results, and expand their native renderers", () => {
  const definitions = new Map();
  const pi = {
    events: events(), registerTool(definition) { definitions.set(definition.name, definition); },
    registerCommand() {}, registerShortcut() {}, on() {},
  };
  for (const extension of [subagentsExtension, backgroundTasksExtension, goalExtension, planExtension, sshExtension]) extension(pi);
  const hook = install();
  hook.setEnabled(true);
  const cases = [
    ["subagent_spawn", { role: "developer", name: "checkout", prompt: "Investigate checkout failures", model: "provider/model", thinking: "high" }, /developer.*checkout.*Investigate checkout failures/],
    ["subagent_spawn_batch", { jobs: [{ role: "developer", prompt: "First job" }, { role: "reviewer", prompt: "Second job" }] }, /2 jobs/],
    ["subagent_result", { id: "sa-checkout" }, /sa-checkout/],
    ["subagent_output", { id: "sa-checkout" }, /sa-checkout/],
    ["subagent_stop", { id: "sa-checkout" }, /sa-checkout/],
    ["subagent_list", { status: ["running"], all: true }, /running.*all/],
    ["agents_catalog", { action: "inspect", id: "role.developer" }, /inspect.*role.developer/],
    ["bg_task_spawn", { command: "npm test", name: "unit-tests" }, /unit-tests.*npm test/],
    ["bg_task_watch", { command: "deploy status", ssh: { user: "ops", host: "builder" } }, /ops@builder.*deploy status/],
    ["bg_task_status", { id: "bg-tests" }, /bg-tests/],
    ["bg_task_log", { id: "bg-tests" }, /bg-tests/],
    ["bg_task_stop", { id: "bg-tests" }, /bg-tests/],
    ["bg_task_list", {}, /Bg task list/],
    ["bg_task", { action: "log", id: "bg-tests" }, /log.*bg-tests/],
    ["bg_status", { action: "status", id: "bg-tests" }, /status.*bg-tests/],
    ["get_goal", {}, /Get goal/],
    ["update_goal", { status: "complete" }, /complete/],
    ["goal_resume", { reason: "Continue verification" }, /Continue verification/],
    ["get_background_activity", {}, /Get background activity/],
    ["release_workflow", {}, /Release workflow/],
    ["update_plan", { plan: [{ step: "Verify checkout", status: "in_progress" }] }, /1 steps/],
    ["get_plan", {}, /Get plan/],
    ["remote_bash", { host: "builder", command: "git status" }, /builder.*git status/],
    ["ssh_profile", { action: "use", host: "builder" }, /use.*builder/],
    ["ssh_mux", { action: "status", host: "builder" }, /status.*builder/],
  ];
  const chat = new Container();
  const ui = { children: [chat], requestRender() {} };
  for (const [name, args, expected] of cases) {
    const definition = definitions.get(name);
    assert.ok(definition, `${name} is registered by its real extension`);
    const component = new ToolExecutionComponent(name, `harness-${name}`, args, {}, definition, ui, process.cwd());
    chat.addChild(component);
    component.updateResult(payload, true);
    assert.match(rendered(component), /running/, `${name} retains streaming state without showing its result`);
    assert.doesNotMatch(rendered(component), /RESULT_BODY_SENTINEL/);
    component.updateResult(payload, false);
    const compact = stripVTControlCharacters(rendered(component));
    assert.equal(component.render(100).length, 1, `${name} stays on one line`);
    assert.match(compact, expected, `${name} keeps its call identity`);
    assert.doesNotMatch(compact, /RESULT_BODY_SENTINEL/);
    assert.equal(component.result, payload);
    for (const width of [1, 24, 60]) assert.ok(component.render(width).every(line => visibleWidth(line) <= width));
    component.setExpanded(true);
    assert.match(rendered(component), /RESULT_BODY_SENTINEL/, `${name} expands its original result`);
    component.setExpanded(false);
    assert.doesNotMatch(rendered(component), /RESULT_BODY_SENTINEL/);
  }
  hook.completeRun();
  assert.equal(chat.render(100).length, 1, "settled Harness calls share one folded block");
  assert.match(rendered(chat), new RegExp(`${cases.length} tool calls`));
  chat.children[0].setExpanded(true);
  assert.match(rendered(chat), /RESULT_BODY_SENTINEL/, "native expansion still works inside a settled Harness block");
  chat.children[0].setExpanded(false);
  assert.equal(chat.render(100).length, 1);
});

test("new tool headers survive streaming updates, and custom renderer reuse survives expansion", () => {
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
  assert.equal(component.render(100).length, 1);
  assert.match(rendered(component), /STATEFUL_HEADER/);
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

test("minimal mode retains a running tool header before any result arrives", () => {
  const hook = install();
  hook.setEnabled(true);
  const component = new ToolExecutionComponent("bash", "running-bash", { command: "ls -la" }, {}, undefined, { requestRender() {} }, process.cwd());
  assert.match(rendered(component), /ls -la/);
  assert.equal(component.render(100).length, 1);
  component.updateResult(payload, true);
  assert.match(rendered(component), /ls -la/);
  assert.equal(component.render(100).length, 1);
  component.setExpanded(true);
  assert.match(rendered(component), /ls -la/);
  assert.match(rendered(component), /RESULT_BODY_SENTINEL/);
  component.setExpanded(false);
  assert.match(rendered(component), /ls -la/);
  assert.equal(component.render(100).length, 1);
});

test("compact headers truncate long and multiline calls without wrapping or background boxes", () => {
  const hook = install();
  hook.setEnabled(true);
  const command = `ls -la /tmp/${"long-directory/".repeat(20)}\necho second-command`;
  const component = new ToolExecutionComponent("bash", "long-bash", { command }, {}, undefined, { requestRender() {} }, process.cwd());
  for (const width of [1, 10, 40, 100]) {
    const lines = component.render(width);
    assert.equal(lines.length, 1);
    assert.ok(visibleWidth(lines[0]) <= width);
    assert.doesNotMatch(lines[0], /\x1b\[(?:48|4[0-7])[;m]/, "call headers have no box background");
    if (width >= 20) {
      assert.match(lines[0], /ls -l/);
      assert.match(lines[0], /\.\.\.|\u2026/, "long calls show truncation");
    }
  }
  assert.deepEqual(component.render(0), []);
  component.updateArgs({ command: "git status --short" });
  assert.match(rendered(component), /git status --short/);
  assert.doesNotMatch(rendered(component), /long-directory/);
  const custom = tool("multiline_call", {
    renderCall: () => new Text("FIRST_HEADER\nSECOND_HEADER", 0, 0),
    renderResult: () => new Text("BODY", 0, 0),
  });
  assert.equal(custom.render(40).length, 1);
  assert.match(rendered(custom), /FIRST_HEADER/);
  assert.doesNotMatch(rendered(custom), /SECOND_HEADER|BODY/);
  const wide = tool("wide_call", {
    renderCall: () => new Text("\u4e2d\u6587 ".repeat(40), 0, 0),
  });
  for (const width of [1, 2, 7, 20]) {
    const lines = wide.render(width);
    assert.equal(lines.length, 1);
    assert.ok(visibleWidth(lines[0]) <= width, "wide characters must fit the supplied terminal columns");
  }
});

test("compact custom call headers discard styled box padding and backgrounds", () => {
  const hook = install();
  const component = tool("boxed_call", {
    renderCall: () => {
      const box = new Box(2, 1, (text) => `\x1b[48;2;100;20;20m${text}\x1b[0m`);
      box.addChild(new Text("BOXED_HEADER", 0, 0));
      return box;
    },
    renderResult: () => new Text("BOXED_RESULT", 0, 0),
  });
  const normal = rendered(component);
  hook.setEnabled(true);
  assert.deepEqual(component.render(40), ["    \u25c7 Boxed call  BOXED_HEADER"]);
  assert.doesNotMatch(rendered(component), /BOXED_RESULT|\x1b/);
  component.setExpanded(true);
  assert.match(rendered(component), /BOXED_HEADER/);
  assert.match(rendered(component), /BOXED_RESULT/);
  assert.match(rendered(component), /\x1b\[48;2;/);
  component.setExpanded(false);
  hook.setEnabled(false);
  assert.equal(rendered(component), normal);
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

test("compact rows color the tool icon and name together, while arguments remain dim", () => {
  const hook = installMinimalOutputHook(prototype, () => themeModule.theme);
  handles.push(hook);
  hook.setEnabled(true);
  hook.setAnimationEnabled(false);
  const component = new ToolExecutionComponent("bash", "styled-call", { command: "git status --short" }, {}, undefined, { requestRender() {} }, process.cwd());
  for (const name of ["dark", "light"]) {
    initTheme(name, false);
    for (const [result, partial, suffix, color] of [
      [payload, true, " (running)", "accent"],
      [payload, false, "", "muted"],
      [{ ...payload, isError: true }, false, " (failed)", "error"],
    ]) {
      component.updateResult(result, partial);
      const line = component.render(80)[0];
      const plain = stripVTControlCharacters(line);
      assert.match(plain, /^ {4}\u2318 Shell/);
      if (suffix) assert.ok(plain.endsWith(suffix));
      else assert.doesNotMatch(plain, /\(running\)|\(failed\)/);
      assert.ok(line.includes(themeModule.theme.fg(color, "\u2318 Shell")), "the icon and tool name share their state color");
      assert.ok(line.includes(themeModule.theme.fg("dim", "$ git status --short")) || line.includes(themeModule.theme.fg("dim", "git status --short")));
      assert.notEqual(themeModule.theme.fg("muted", "tone"), themeModule.theme.fg("dim", "tone"), "names and arguments have distinct grayscale tones on both themes");
      assert.doesNotMatch(line, /\x1b\[(?:48|4[0-7])[;m]/);
    }
  }
  assert.doesNotMatch(rendered(component), /RESULT_BODY_SENTINEL/);
  for (const width of [1, 6, 10, 20, 80]) {
    assert.equal(component.render(width).length, 1);
    assert.ok(visibleWidth(component.render(width)[0]) <= width);
  }
  component.setExpanded(true);
  assert.match(rendered(component), /RESULT_BODY_SENTINEL/);
});

test("running names shimmer through both themes without changing text, width, or argument color", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  const hook = installMinimalOutputHook(prototype, () => themeModule.theme);
  handles.push(hook);
  hook.setEnabled(true);
  const components = [];
  let redraws = 0;
  const frames = [];
  const ui = animationUI(() => components, () => { redraws++; frames.push(components.map(component => component.render(100)[0])); });
  for (const name of ["read", "external_tool"]) {
    const component = new ToolExecutionComponent(name, `shimmer-${name}`, { path: "/tmp/demo" }, {}, undefined, ui, process.cwd());
    components.push(component);
  }
  for (const name of ["dark", "light"]) {
    initTheme(name, false);
    const first = components.map(component => component.render(100)[0]);
    frames.length = 0;
    redraws = 0;
    for (let frame = 0; frame < 10; frame++) t.mock.timers.tick(80);
    assert.equal(redraws, 10, "two tools share one render request per 80ms tick");
    for (let index = 0; index < components.length; index++) {
      assert.ok(frames.some(frame => frame[index] !== first[index]), "highlight travels through each running name");
      for (const frame of frames) {
        assert.equal(stripVTControlCharacters(frame[index]), stripVTControlCharacters(first[index]));
        assert.equal(visibleWidth(frame[index]), visibleWidth(first[index]));
        assert.ok(frame[index].includes(themeModule.theme.fg("dim", "/tmp/demo")));
        assert.doesNotMatch(frame[index], /\x1b\[(?:48|4[0-7])[;m]/);
      }
    }
    for (const width of [0, 1, 4, 8, 12, 30]) {
      for (const component of components) assert.ok(component.render(width).every(line => visibleWidth(line) <= width));
    }
  }
  for (const component of components) component.updateResult(payload, false);
  redraws = 0;
  t.mock.timers.tick(800);
  assert.equal(redraws, 0, "completed tools stop the shared clock immediately");
});

test("tool-name shimmer preserves Unicode and degrades to static color for terminal-defined palettes", () => {
  for (const name of ["dark", "light"]) {
    initTheme(name, false);
    const label = "\u67e5\u8be2 \ud83d\udc69\u200d\ud83d\udcbb e\u0301";
    for (const time of [0, 400, 800, 1600, 2400]) {
      const line = toolIdentity("\u25c7", label, "accent", themeModule.theme, time);
      assert.equal(stripVTControlCharacters(line), `\u25c7 ${label}`);
      assert.ok(line.includes("\ud83d\udc69\u200d\ud83d\udcbb"));
      assert.ok(line.includes("e\u0301"));
      assert.equal(visibleWidth(line), visibleWidth(`\u25c7 ${label}`));
    }
    for (const tone of ["muted", "error"]) {
      assert.equal(toolIdentity("\u25c7", label, tone, themeModule.theme, 800), themeModule.theme.fg(tone, `\u25c7 ${label}`));
    }
  }
  const theme = { fg: (_tone, text) => `\x1b[38;5;6m${text}\x1b[39m`, getFgAnsi: () => "\x1b[38;5;6m" };
  assert.equal(toolIdentity("*", "Read", "accent", theme, 800), theme.fg("accent", "* Read"));
});

test("animation stops on expansion, disable, settled runs, history restore, and final disposal", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  const first = installMinimalOutputHook(prototype, () => themeModule.theme);
  const second = installMinimalOutputHook(prototype, () => themeModule.theme);
  handles.push(first, second);
  first.setEnabled(true);
  let component;
  let redraws = 0;
  const ui = animationUI(() => [component], () => { redraws++; component?.render(80); });
  const running = () => {
    component = new ToolExecutionComponent("bash", `lifecycle-${Date.now()}`, { command: "sleep 10" }, {}, undefined, ui, process.cwd());
    component.render(80);
    redraws = 0;
    t.mock.timers.tick(80);
    assert.equal(redraws, 1);
  };
  const stopped = () => { redraws = 0; t.mock.timers.tick(800); assert.equal(redraws, 0); };
  running();
  component.setExpanded(true);
  stopped();
  component.setExpanded(false);
  component.render(80);
  t.mock.timers.tick(80);
  first.setAnimationEnabled(false);
  stopped();
  assert.ok(component.render(80)[0].includes(themeModule.theme.fg("accent", "\u2318 Shell")));
  first.setAnimationEnabled(true);
  component.render(80);
  first.setEnabled(false);
  stopped();
  first.setEnabled(true);
  running();
  first.completeRun();
  stopped();
  component.render(80);
  stopped();
  running();
  first.restoreCompletedCalls([]);
  stopped();
  running();
  first.dispose();
  redraws = 0;
  t.mock.timers.tick(80);
  assert.equal(redraws, 1, "disposing one owner does not remove another owner's animation");
  second.dispose();
  stopped();
});

test("animation stops when a running row is no longer rendered and resumes when it returns", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  const hook = installMinimalOutputHook(prototype, () => themeModule.theme);
  handles.push(hook);
  hook.setEnabled(true);
  let redraws = 0;
  let component;
  const ui = animationUI(() => [component], () => { redraws++; });
  component = new ToolExecutionComponent("read", "stale-render", {}, {}, undefined, ui, process.cwd());
  component.render(80);
  for (let frame = 0; frame < 10; frame++) t.mock.timers.tick(80);
  const count = redraws;
  assert.ok(count > 0);
  t.mock.timers.tick(800);
  assert.equal(redraws, count);
  component.render(80);
  t.mock.timers.tick(80);
  assert.equal(redraws, count + 1);
  component.updateResult({ ...payload, isError: true }, false);
  const failure = component.render(80)[0];
  assert.ok(failure.includes(themeModule.theme.fg("error", "\u25a4 Read")));
  redraws = 0;
  t.mock.timers.tick(800);
  assert.equal(redraws, 0);
  assert.equal(component.render(80)[0], failure);
});

test("scrollback hosts and unresolved palettes never start a redundant animation clock", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  let theme = themeModule.theme;
  const hook = installMinimalOutputHook(prototype, () => theme);
  handles.push(hook);
  hook.setEnabled(true);
  let redraws = 0;
  const component = new ToolExecutionComponent("read", "static-host", {}, {}, undefined, { requestRender() { redraws++; } }, process.cwd());
  const line = component.render(80)[0];
  t.mock.timers.tick(800);
  assert.equal(redraws, 0);
  assert.equal(component.render(80)[0], line);
  const ui = animationUI(() => [component], () => { redraws++; component.render(80); });
  component.ui = ui;
  component.render(80);
  t.mock.timers.tick(80);
  assert.equal(redraws, 1);
  theme = Object.create(themeModule.theme);
  Object.defineProperty(theme, "colors", { value: undefined });
  theme.getFgAnsi = () => "\x1b[38;5;6m";
  redraws = 0;
  t.mock.timers.tick(800);
  assert.equal(redraws, 0, "switching to an unresolved palette stops an existing clock");
  component.render(80);
  t.mock.timers.tick(800);
  assert.equal(redraws, 0);
  theme = themeModule.theme;
  component.render(80);
  t.mock.timers.tick(80);
  assert.equal(redraws, 1);
});

test("clipped running rows do not redraw even when the host keeps rendering them, and custom call renderers are not rebuilt", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  const hook = installMinimalOutputHook(prototype, () => themeModule.theme);
  handles.push(hook);
  hook.setEnabled(true);
  let component;
  let frame;
  let redraws = 0;
  let calls = 0;
  const ui = { mode: "fullscreen", get currentLayout() { return frame; }, requestRender() { redraws++; component.render(80); } };
  component = new ToolExecutionComponent("read", "clipped-call", {}, {}, {
    renderCall() { calls++; return new Text("Read /tmp/demo", 0, 0); },
  }, ui, process.cwd());
  const clip = { x: 0, y: 0, width: 80, height: 10 };
  const at = y => ({ root: { component, rect: { ...clip, y, height: 1 }, clip, children: [] } });
  frame = at(0);
  component.render(80);
  const callsBefore = calls;
  t.mock.timers.tick(80);
  assert.equal(redraws, 1);
  assert.equal(calls, callsBefore);
  frame = at(-21);
  redraws = 0;
  for (let tick = 0; tick < 20; tick++) { component.render(80); t.mock.timers.tick(80); }
  assert.equal(redraws, 0);
  assert.equal(calls, callsBefore, "animation never invalidates/recreates a native custom call renderer");
  frame = at(0);
  component.render(80);
  t.mock.timers.tick(80);
  assert.equal(redraws, 1);
});

test("real scrollback TUI leaves off-screen running rows unchanged without scrollback clears", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  const hook = installMinimalOutputHook(prototype, () => themeModule.theme);
  handles.push(hook);
  hook.setEnabled(true);
  const writes = [];
  const ScrollbackTUI = TuiMainScreen ?? TUI;
  const ui = new ScrollbackTUI({ columns: 80, rows: 10, write: text => writes.push(text), hideCursor() {}, showCursor() {}, stop() {} });
  const component = new ToolExecutionComponent("read", "offscreen-scroll", { path: "/tmp/demo" }, {}, undefined, ui, process.cwd());
  ui.addChild(component);
  ui.addChild(new Text(Array.from({ length: 30 }, (_, index) => `Filler ${index}`).join("\n"), 0, 0));
  ui.doRender();
  const count = writes.length;
  const fullRedraws = ui.fullRedraws;
  for (let frame = 0; frame < 20; frame++) { t.mock.timers.tick(80); ui.doRender(); }
  assert.equal(writes.length, count);
  assert.equal(ui.fullRedraws, fullRedraws);
  ui.stop();
});

test("fullscreen visibility follows painted clips and cached legacy row offsets without re-rendering", () => {
  const tool = {};
  const filler = {};
  const container = { mouseLayout: { children: [{ component: tool, height: 1 }, { component: filler, height: 30 }] } };
  const clip = { x: 0, y: 0, width: 80, height: 10 };
  const ui = { mode: "fullscreen", currentLayout: { root: { component: container,
    rect: { ...clip, y: -21, height: 31 }, clip, children: [] } } };
  assert.equal(toolVisibility(ui, tool), false, "rendered but off-screen rows stay static");
  ui.currentLayout = { root: { component: container, rect: { ...clip, height: 31 }, clip, children: [] } };
  assert.equal(toolVisibility(ui, tool), true);
  ui.hasOverlay = () => true;
  assert.equal(toolVisibility(ui, tool), false);
  ui.hasOverlay = () => false;
  ui.hasActiveSelection = () => true;
  assert.equal(toolVisibility(ui, tool), false);
  ui.hasActiveSelection = () => false;
  ui.currentLayout = { root: { component: {}, rect: clip, clip, children: [] } };
  assert.equal(toolVisibility(ui, tool), undefined, "newly mounted rows wait for the next painted frame");
});

test("the highlight approaches the foreground more closely without changing its base or period", () => {
  const getFgAnsi = tone => tone === "accent" ? "\x1b[38;2;102;144;184m" : "\x1b[38;2;244;244;244m";
  const theme = { getFgAnsi, getColorMode: () => "truecolor", fg: (tone, text) => `${getFgAnsi(tone)}${text}\x1b[39m` };
  const baseline = toolIdentity("*", "Read", "accent", theme, 0);
  const peak = toolIdentity("*", "Read", "accent", theme, 600);
  assert.ok(baseline.includes("\x1b[38;2;102;144;184mR"));
  assert.ok(peak.includes("\x1b[38;2;238;240;242mR"), "the peak blends 96% toward the foreground");
  assert.ok(peak.startsWith(`${getFgAnsi("accent")}* `), "the icon keeps its original state color");
  assert.equal(peak, toolIdentity("*", "Read", "accent", theme, 3000));
  assert.equal(stripVTControlCharacters(baseline), stripVTControlCharacters(peak));
});

test("256-color shimmer uses indexed foreground colors and keeps text stable", () => {
  const getFgAnsi = tone => tone === "accent" ? "\x1b[38;5;75m" : "\x1b[38;5;255m";
  const theme = { getFgAnsi, getColorMode: () => "256color", fg: (tone, text) => `${getFgAnsi(tone)}${text}\x1b[39m` };
  const frames = [0, 400, 800, 1600].map(time => toolIdentity("*", "Header probe", "accent", theme, time));
  assert.ok(new Set(frames).size > 1);
  for (const frame of frames) {
    assert.equal(stripVTControlCharacters(frame), "* Header probe");
    assert.doesNotMatch(frame, /\x1b\[38;2;/);
  }
});

test("modern indexed themes shimmer with native brightness without inventing terminal colors", () => {
  const getFgAnsi = token => token === "accent" ? "\x1b[38;5;5m" : "\x1b[39m";
  const theme = { colors: { accent: { kind: "indexed", index: 5 }, text: { kind: "rgb", r: 229, g: 229, b: 231 } },
    getFgAnsi, getColorMode: () => "truecolor", fg: (tone, text) => `${getFgAnsi(tone)}${text}\x1b[39m` };
  const frames = [0, 400, 800, 1600].map(time => toolIdentity("*", "Header probe", "accent", theme, time));
  assert.ok(new Set(frames).size > 1);
  for (const frame of frames) {
    assert.equal(stripVTControlCharacters(frame), "* Header probe");
    assert.doesNotMatch(frame, /\x1b\[38;2;/);
    assert.ok(frame.startsWith("\x1b[38;5;5m* "));
    assert.ok(frame.endsWith("\x1b[22m\x1b[39m"), "brightness attributes do not leak into arguments");
  }
});

test("default tools keep one identity icon across states and expose running and failure without color", () => {
  const hook = install();
  hook.setEnabled(true);
  for (const [name, icon, label] of [
    ["bash", "\u2318", "Shell"], ["read", "\u25a4", "Read"],
    ["write", "\u2710", "Write"], ["edit", "\u270e", "Edit"],
    ["grep", "\u2315", "Grep"], ["find", "\u2316", "Find"],
    ["ls", "\u2261", "Ls"], ["external_tool", "\u25c7", "External tool"],
  ]) {
    const component = tool(name);
    assert.equal(visibleWidth(icon), 1, "tool icons occupy one terminal column");
    assert.ok(rendered(component).startsWith(`    ${icon} ${label}`));
    assert.doesNotMatch(rendered(component), /\(running\)|\(failed\)/);
    component.updateResult(payload, true);
    assert.ok(rendered(component).startsWith(`    ${icon} ${label}`));
    assert.match(rendered(component), /\(running\)$/);
    component.updateResult({ ...payload, isError: true }, false);
    assert.ok(rendered(component).startsWith(`    ${icon} ${label}`));
    assert.match(rendered(component), /\(failed\)$/);
    for (const width of [1, 8, 20, 80]) {
      assert.ok(visibleWidth(component.render(width)[0]) <= width);
    }
  }
});

test("fullscreen hover highlights only the pointed row and clears on pointer exit and view changes", {
  skip: typeof prototype.handleMouse !== "function" ? "This Pi SDK has no fullscreen mouse routing" : false,
}, () => {
  const hook = installMinimalOutputHook(prototype, () => themeModule.theme);
  handles.push(hook);
  const chat = new Container();
  const viewportInput = data => data;
  const ui = { children: [chat], requestRender() {}, handleViewportInput: viewportInput };
  const first = placedTool("first", ui);
  const second = placedTool("second", ui);
  chat.addChild(first);
  chat.addChild(second);
  hook.setEnabled(true);
  const move = (y, width = 80) => dispatchMouseEvent(chat, {
    type: "move", button: "none", x: 4, y, screenX: 4, screenY: y,
    width, height: chat.render(width).length, shift: false, ctrl: false, alt: false,
  });
  for (const name of ["dark", "light", "system"]) {
    initTheme(name, false);
    const plain = chat.render(80);
    assert.equal(move(0).render, true);
    let lines = chat.render(80);
    assert.notEqual(lines[0], plain[0]);
    assert.equal(lines[1], plain[1]);
    assert.equal(visibleWidth(lines[0]), 80, "hover fills the row without changing its geometry");
    assert.equal(stripVTControlCharacters(lines[0]).trimEnd(), stripVTControlCharacters(plain[0]));
    assert.equal(first.expanded, false);
    assert.equal(move(0).render, false, "moving within a row does not redraw");
    assert.equal(ui.handleViewportInput("\x1b[<35;15;1M"), "\x1b[<35;15;1M", "input is forwarded unchanged");
    assert.deepEqual(chat.render(80), lines, "motion within the hovered row keeps its highlight");
    move(1);
    lines = chat.render(80);
    assert.equal(lines[0], plain[0]);
    assert.notEqual(lines[1], plain[1]);
    ui.handleViewportInput("\x1b[<35;5;5M");
    assert.deepEqual(chat.render(80), plain, "moving onto non-tool content clears hover");
    for (const input of ["\x1b[<64;5;2M", "\x1b[<0;5;2M", "\x1b[<51;5;2M", "\x0f"]) {
      move(1);
      ui.handleViewportInput(input);
      assert.deepEqual(chat.render(80), plain, "scroll, click, modified move and keyboard input clear hover");
    }
    move(0);
    assert.ok(chat.render(20).every(line => visibleWidth(line) <= 20));
    assert.deepEqual(chat.render(80), plain, "resize clears stale pointer bounds");
    move(0);
    first.setExpanded(true);
    first.setExpanded(false);
    assert.deepEqual(chat.render(80), plain, "expansion clears hover");
    move(0);
    hook.setEnabled(false);
    hook.setEnabled(true);
    assert.deepEqual(chat.render(80), plain, "mode switches clear hover");
  }
  hook.completeRun();
  const summary = chat.render(80);
  move(0);
  assert.notDeepEqual(chat.render(80), summary, "block summaries have hover feedback too");
  ui.handleViewportInput("\x1b[<0;5;1M");
  dispatchMouseEvent(chat, { type: "click", button: "left", x: 4, y: 0, screenX: 4, screenY: 0,
    width: 80, height: 1, shift: false, ctrl: false, alt: false });
  assert.equal(chat.render(80).length, 3);
  move(1);
  const open = chat.render(80);
  assert.equal(visibleWidth(open[1]), 80);
  assert.ok(visibleWidth(open[0]) < 80);
  assert.ok(visibleWidth(open[2]) < 80);
  hook.dispose();
  assert.equal(ui.handleViewportInput, viewportInput, "disposal restores fullscreen input routing");
  assert.match(rendered(chat), /RESULT_BODY_SENTINEL/);
});

test("fullscreen mouse dispatch expands a folded row to all original detail and collapses it again", {
  skip: typeof prototype.handleMouse !== "function" ? "This Pi SDK has no fullscreen mouse routing" : false,
}, () => {
  const hook = install();
  const result = { content: [{ type: "text", text: Array.from({ length: 20 }, (_, i) => `DETAIL_LINE_${i}`).join("\n") }], isError: false };
  const component = tool("unknown_external_tool", undefined, result);
  const chat = new Container();
  chat.addChild(component);
  const normal = chat.render(80);
  hook.setEnabled(true);
  assert.equal(chat.render(80).length, 1);
  const event = (y, extra = {}) => ({ type: "click", button: "left", x: 1, y,
    screenX: 1, screenY: y, width: 80, height: chat.render(80).length,
    shift: false, ctrl: false, alt: false, ...extra });
  for (const extra of [{ type: "wheel", button: "none", wheelDelta: 1 }, { type: "drag" }, { ctrl: true }, { button: "right" }]) {
    assert.equal(dispatchMouseEvent(chat, event(0, extra)), undefined);
    assert.equal(component.expanded, false);
  }
  assert.equal(dispatchMouseEvent(chat, event(0)).handled, true);
  assert.equal(component.expanded, true);
  const expanded = chat.render(80);
  assert.match(expanded.join("\n"), /DETAIL_LINE_0/);
  assert.match(expanded.join("\n"), /DETAIL_LINE_19/);
  assert.equal(component.result, result);
  const headerY = expanded.findIndex(line => stripVTControlCharacters(line).includes("unknown_external_tool"));
  assert.ok(headerY >= 0);
  assert.equal(dispatchMouseEvent(chat, event(headerY)).handled, true);
  assert.equal(component.expanded, false);
  assert.equal(chat.render(80).length, 1);
  hook.setEnabled(false);
  assert.deepEqual(chat.render(80), normal);
});

test("the contributed hub control changes real tool rows, shares command state, restores branches and rolls back failed saves", async () => {
  const handlers = new Map();
  const commands = new Map();
  const entries = [];
  const sessionManager = SessionManager.inMemory(process.cwd());
  let failSave = false;
  const pi = { events: events(), on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    appendEntry(customType, data) {
      entries.push({ type: "custom", customType, data });
      sessionManager.appendCustomEntry(customType, data);
      if (failSave) throw new Error("Disk write failed");
    } };
  minimalOutputExtension(pi);
  const registry = createSettingsRegistry(pi);
  registry.refresh();
  const component = tool("unknown_external_tool");
  let expanded = false;
  let page;
  const ctx = { mode: "tui", sessionManager, ui: {
    theme: themeModule.theme, notify() {}, setStatus() {}, getToolsExpanded: () => expanded,
    setToolsExpanded(value) { expanded = value; component.setExpanded(value); },
    custom(build) { return new Promise(resolve => { page = build({ requestRender() {} }, themeModule.theme, {}, resolve); }); },
  } };
  shutdowns.push(() => handlers.get("session_shutdown")());
  await handlers.get("session_start")({}, ctx);
  const outputControl = () => registry.controls().find(control => control.id === "tool-output");
  const opening = chooseHarnessSetting(ctx, [], undefined, undefined, [outputControl()]);
  assert.match(stripVTControlCharacters(page.render(80).join("\n")), /Tool output.*Normal/);
  page.handleInput(" ");
  await new Promise(resolve => setImmediate(resolve));
  assert.match(stripVTControlCharacters(page.render(80).join("\n")), /Tool output.*Minimal/);
  assert.doesNotMatch(rendered(component), /RESULT_BODY_SENTINEL/);
  assert.equal(entries.at(-1).data.enabled, true);
  assert.equal(entries.length, 1);
  const minimalLeaf = sessionManager.getLeafId();
  failSave = true;
  page.handleInput("\r");
  await new Promise(resolve => setImmediate(resolve));
  assert.match(stripVTControlCharacters(page.render(80).join("\n")), /Tool output.*Minimal/);
  assert.match(stripVTControlCharacters(page.render(80).join("\n")), /Disk write failed/);
  await handlers.get("session_tree")({}, ctx);
  assert.doesNotMatch(rendered(component), /RESULT_BODY_SENTINEL/);
  page.handleInput("\x1b");
  await opening;
  failSave = false;
  await commands.get("tool-output").handler("normal", ctx);
  assert.equal(outputControl().get(), "Normal");
  assert.match(rendered(component), /RESULT_BODY_SENTINEL/);
  const settingsPath = join(settingsRoot, "settings.json");
  const savedDefaults = readFileSync(settingsPath, "utf8");
  writeFileSync(settingsPath, "{broken");
  await assert.rejects(outputControl().change("Minimal", ctx), SyntaxError);
  await handlers.get("session_tree")({}, ctx);
  assert.equal(outputControl().get(), "Normal", "a failed global save rolls back the persisted branch choice");
  assert.equal(readFileSync(settingsPath, "utf8"), "{broken");
  writeFileSync(settingsPath, savedDefaults);
  sessionManager.branch(minimalLeaf);
  await handlers.get("session_tree")({}, ctx);
  assert.equal(outputControl().get(), "Minimal");
  assert.doesNotMatch(rendered(component), /RESULT_BODY_SENTINEL/);
  await handlers.get("session_shutdown")();
  registry.refresh();
  assert.deepEqual(registry.controls(), []);
  await handlers.get("session_start")({}, ctx);
  registry.refresh();
  assert.equal(registry.controls().length, 2);
  registry.dispose();
});

test("tool animation preference applies immediately, persists through reload, and survives failed saves", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  const handlers = new Map();
  const pi = { events: events(), on: (name, handler) => handlers.set(name, handler), registerCommand() {}, appendEntry() {} };
  minimalOutputExtension(pi);
  const registry = createSettingsRegistry(pi);
  const ctx = { mode: "tui", sessionManager: { getBranch: () => [] }, ui: {
    get theme() { return themeModule.theme; }, notify() {}, setStatus() {}, getToolsExpanded: () => false, setToolsExpanded() {},
  } };
  shutdowns.push(() => handlers.get("session_shutdown")());
  await handlers.get("session_start")({}, ctx);
  registry.refresh();
  const output = registry.controls().find(control => control.id === "tool-output");
  const motion = registry.controls().find(control => control.id === "tool-animation");
  assert.equal(motion.get(), "Shimmer");
  await output.change("Minimal", ctx);
  let component;
  let redraws = 0;
  const ui = animationUI(() => [component], () => { redraws++; component?.render(80); });
  const running = () => {
    component = new ToolExecutionComponent("bash", `setting-${Date.now()}`, { command: "sleep 10" }, {}, undefined, ui, process.cwd());
    return component.render(80)[0];
  };
  running();
  redraws = 0;
  t.mock.timers.tick(80);
  assert.equal(redraws, 1);
  await motion.change("Off", ctx);
  assert.equal(motion.get(), "Off");
  const staticLine = component.render(80)[0];
  assert.ok(staticLine.includes(themeModule.theme.fg("accent", "\u2318 Shell")));
  redraws = 0;
  t.mock.timers.tick(800);
  assert.equal(redraws, 0);
  assert.equal(component.render(80)[0], staticLine);
  const path = join(settingsRoot, "settings.json");
  const saved = readFileSync(path, "utf8");
  const preferences = JSON.parse(saved).piBetterHarness;
  assert.equal(preferences.toolOutput.enabled, true);
  assert.equal(preferences.toolAnimation.enabled, false);
  writeFileSync(path, "{broken");
  await assert.rejects(motion.change("Shimmer", ctx), SyntaxError);
  assert.equal(motion.get(), "Off");
  assert.equal(component.render(80)[0], staticLine);
  writeFileSync(path, saved);
  await handlers.get("session_shutdown")();
  await handlers.get("session_start")({}, ctx);
  registry.refresh();
  const restoredMotion = registry.controls().find(control => control.id === "tool-animation");
  assert.equal(restoredMotion.get(), "Off");
  running();
  redraws = 0;
  t.mock.timers.tick(800);
  assert.equal(redraws, 0);
  await restoredMotion.change("Shimmer", ctx);
  component.render(80);
  redraws = 0;
  t.mock.timers.tick(80);
  assert.equal(redraws, 1);
  registry.dispose();
});

test("slash-command argument completion offers both modes and filters partial arguments", () => {
  let command;
  minimalOutputExtension({
    events: events(),
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
      events: events(),
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
    events: events(),
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
  assert.equal(JSON.parse(readFileSync(join(settingsRoot, "settings.json"), "utf8")).piBetterHarness.toolOutput.enabled, true);
  await handlers.get("session_shutdown")();
  assert.match(rendered(existing), /RESULT_BODY_SENTINEL/);
  entries.length = 0;
  await handlers.get("session_start")({}, ctx);
  assert.doesNotMatch(rendered(existing), /RESULT_BODY_SENTINEL/, "a fresh session inherits the saved global default");
  await commands.get("tool-output").handler("", ctx);
  assert.match(rendered(existing), /RESULT_BODY_SENTINEL/);
  assert.equal(entries.at(-1).data.enabled, false);
  assert.match(notices.at(-1), /Normal tool output restored/);
  assert.match(notices.find((message) => message.startsWith("Minimal tool output on")), /Compact call headers remain visible/);
});

const bundledCli = process.env.PI_MINIMAL_OUTPUT_HOST_CLI ?? join(sdk, "bundle/cli.js");
test("minimal mode patches the running bundled host and retains only its bash header", {
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
    const compactionPrototype = await loadCompactionPrototype();
    assert.equal(compactionPrototype, host.CompactionSummaryMessageComponent.prototype);
    const originalCompactionRender = compactionPrototype.render;
    const summary = new host.CompactionSummaryMessageComponent({ summary: "BUNDLED_COMPACTION_SUMMARY", tokensBefore: 12345 });
    const customPrototype = await loadCustomMessagePrototype();
    assert.equal(customPrototype, host.CustomMessageComponent.prototype);
    const originalCustomRender = customPrototype.render;
    const callback = new host.CustomMessageComponent({ customType: "background-completion-batch", content: "1 completion ready\nBUNDLED_CALLBACK_DETAIL" });
    const HostContainer = Object.getPrototypeOf(host.ToolExecutionComponent.prototype).constructor;
    hook = installMinimalOutputHook(toolPrototype, undefined, compactionPrototype, customPrototype);
    const chat = new HostContainer();
    const ui = { requestRender() {}, children: [chat] };
    const component = new host.ToolExecutionComponent("bash", "bundled-bash", { command: "ls -la" }, {}, host.createBashToolDefinition(process.cwd()), ui, process.cwd());
    component.updateResult(payload, false);
    chat.addChild(component);
    assert.match(rendered(chat), /RESULT_BODY_SENTINEL/);
    hook.setEnabled(true);
    assert.equal(summary.render(100).length, 1);
    assert.equal(callback.render(100).length, 1);
    assert.match(rendered(callback), /Background completion batch.*1 completion ready/);
    assert.doesNotMatch(rendered(callback), /BUNDLED_CALLBACK_DETAIL/);
    callback.setExpanded(true);
    assert.match(rendered(callback), /BUNDLED_CALLBACK_DETAIL/);
    assert.match(rendered(summary), /Compaction.*12,345 tokens/);
    summary.setExpanded(true);
    assert.match(rendered(summary), /BUNDLED_COMPACTION_SUMMARY/);
    summary.setExpanded(false);
    assert.equal(chat.render(100).length, 1, "only the call header survives");
    assert.match(rendered(chat), /ls -la/);
    assert.doesNotMatch(rendered(chat), /RESULT_BODY_SENTINEL/);
    const message = new host.AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text: "BUNDLED_MODEL_TEXT" }], stopReason: "stop" });
    chat.addChild(message);
    assert.deepEqual(chat.render(100), [...component.render(100), ...message.render(100)]);
    component.setExpanded(true);
    assert.match(rendered(chat), /RESULT_BODY_SENTINEL/);
    component.setExpanded(false);
    hook.setEnabled(false);
    assert.match(rendered(chat), /RESULT_BODY_SENTINEL/);
    assert.equal(component.result, payload);
    hook.dispose();
    assert.equal(toolPrototype.render, originalRender);
    assert.equal(compactionPrototype.render, originalCompactionRender);
    assert.equal(customPrototype.render, originalCustomRender);
    assert.match(rendered(chat), /RESULT_BODY_SENTINEL/);
    hook = installMinimalOutputHook(await loadToolPrototype());
    hook.setEnabled(true);
    assert.deepEqual(chat.render(100), [...component.render(100), ...message.render(100)], "reinstalling after reload must still fold restored tools");
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

test("completed runs fold consecutive blocks, preserve prose and failures, and expand through native tool controls", () => {
  const hook = install();
  const chat = new Container();
  const ui = { children: [chat], requestRender() {} };
  const intro = modelText("PROGRESS_TEXT");
  const read = placedTool("read", ui);
  const edit = placedTool("edit", ui, { ...payload, isError: true });
  const answer = modelText("FINAL_ANSWER");
  const tail = placedTool("tail", ui);
  const live = placedTool("live", ui);
  live.updateResult(payload, true);
  for (const component of [intro, read, edit, answer, tail, live]) chat.addChild(component);
  const normal = chat.render(100);
  hook.setEnabled(true);
  assert.match(rendered(chat), /read-arg/);
  assert.match(rendered(chat), /edit-arg/);
  hook.completeRun();
  assert.deepEqual(read.render(100), ["   \u25b8 2 tool calls \u00b7 1 failed"]);
  assert.deepEqual(edit.render(100), []);
  assert.deepEqual(tail.render(100), ["   \u25b8 1 tool call"]);
  assert.match(rendered(chat), /PROGRESS_TEXT/);
  assert.match(rendered(chat), /FINAL_ANSWER/);
  assert.match(rendered(chat), /live-arg.*running/);
  assert.doesNotMatch(rendered(chat), /read-arg|edit-arg|tail-arg|RESULT_BODY_SENTINEL/);
  for (const width of [0, 1, 2, 6, 20, 80]) {
    for (const component of [read, edit, tail, live]) {
      for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width);
    }
  }
  for (const component of [read, edit, tail, live]) component.setExpanded(true);
  assert.match(rendered(chat), /RESULT_BODY_SENTINEL/);
  assert.match(rendered(chat), /read-arg/);
  for (const component of [read, edit, tail, live]) component.setExpanded(false);
  assert.deepEqual(read.render(100), ["   \u25b8 2 tool calls \u00b7 1 failed"]);
  hook.setEnabled(false);
  assert.deepEqual(chat.render(100), normal);
  assert.equal(read.result, payload);
});

test("folded summaries keep disclosure and counts quiet and color only the failure count", () => {
  const hook = installMinimalOutputHook(prototype, () => themeModule.theme);
  handles.push(hook);
  const chat = new Container();
  const ui = { children: [chat], requestRender() {} };
  const successful = placedTool("read", ui);
  const failed = placedTool("edit", ui, { ...payload, isError: true });
  chat.addChild(successful);
  chat.addChild(failed);
  hook.setEnabled(true);
  hook.completeRun();
  for (const name of ["dark", "light"]) {
    initTheme(name, false);
    const line = chat.render(80)[0];
    assert.match(stripVTControlCharacters(line), /^ {3}\u25b8 2 tool calls \u00b7 1 failed/);
    assert.ok(line.includes(themeModule.theme.fg("muted", "\u25b8 2 tool calls")));
    assert.ok(line.includes(themeModule.theme.fg("error", "1 failed")));
    assert.doesNotMatch(line, /RESULT_BODY_SENTINEL/);
  }
});

test("restored history folds by call id while new runs stay visible and respect assistant padding", () => {
  const hook = install();
  const chat = new Container();
  const ui = { children: [chat], requestRender() {} };
  const intro = modelText("PADDED_TEXT");
  intro.setOutputPad(4);
  const old = placedTool("old", ui);
  chat.addChild(intro);
  chat.addChild(old);
  hook.restoreCompletedCalls([old.toolCallId]);
  hook.setEnabled(true);
  assert.match(old.render(80)[0], /^ {6}\u25b8 1 tool call/);
  const next = placedTool("next", ui);
  chat.addChild(next);
  assert.match(next.render(80)[0], /^ {7}\u25c7 Next/);
  assert.doesNotMatch(next.render(80)[0], /tool call/);
  hook.completeRun();
  assert.match(next.render(80)[0], /^ {6}\u25b8 1 tool call/);
  assert.match(old.render(80)[0], /1 tool call/);
  intro.setOutputPad(0);
  assert.match(old.render(80)[0], /^ {2}\u25b8/);
  hook.restoreCompletedCalls([]);
  assert.match(old.render(80)[0], /^ {3}\u25c7 Old/);
  assert.match(next.render(80)[0], /^ {3}\u25c7 Next/);
});

test("tool-only assistant messages do not split a visual block but visible thinking and errors do", () => {
  const hook = install();
  const chat = new Container();
  const ui = { children: [chat], requestRender() {} };
  const first = placedTool("first", ui);
  const second = placedTool("second", ui);
  const third = placedTool("third", ui);
  const fourth = placedTool("fourth", ui);
  const invisible = new AssistantMessageComponent({ role: "assistant", content: [
    { type: "toolCall", id: "second", name: "second", arguments: {} },
  ], stopReason: "toolUse" });
  const thinking = new AssistantMessageComponent({ role: "assistant", content: [
    { type: "thinking", thinking: "VISIBLE_THINKING" },
  ], stopReason: "toolUse" });
  const error = new AssistantMessageComponent({ role: "assistant", content: [], stopReason: "error", errorMessage: "VISIBLE_ERROR" });
  for (const component of [first, invisible, second, thinking, third, error, fourth]) chat.addChild(component);
  assert.deepEqual(invisible.render(80), []);
  hook.setEnabled(true);
  hook.completeRun();
  assert.match(first.render(80)[0], /2 tool calls/);
  assert.deepEqual(second.render(80), []);
  assert.match(third.render(80)[0], /1 tool call/);
  assert.match(fourth.render(80)[0], /1 tool call/);
  assert.match(rendered(chat), /VISIBLE_THINKING/);
  assert.match(rendered(chat), /VISIBLE_ERROR/);
});

test("warmed folded-history rendering avoids repeated transcript and group scans", () => {
  const hook = install();
  const chat = new Container();
  let treeReads = 0;
  let expansionReads = 0;
  const ui = { get children() { treeReads++; return [chat]; }, requestRender() {} };
  const size = 200;
  for (let index = 0; index < size; index++) {
    const component = placedTool(`probe_${index}`, ui);
    let expanded = component.expanded;
    Object.defineProperty(component, "expanded", {
      get() { expansionReads++; return expanded; },
      set(value) { expanded = value; }, configurable: true,
    });
    chat.addChild(component);
  }
  hook.setEnabled(true);
  hook.completeRun();
  assert.equal(chat.render(80).length, 1);
  treeReads = 0;
  expansionReads = 0;
  assert.match(rendered(chat), /200 tool calls/);
  assert.equal(treeReads, 0, "stable transcript layout must reuse its parent lookup");
  assert.ok(expansionReads <= size * 2, "hidden members must not rescan every sibling's expansion state");
});

test("the extension folds at settlement, keeps continuations visible, resumes history, and synchronizes Ctrl+O", async () => {
  const handlers = new Map();
  const commands = new Map();
  const sessionManager = SessionManager.inMemory(process.cwd());
  minimalOutputExtension({
    events: events(), on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    appendEntry: (type, data) => sessionManager.appendCustomEntry(type, data),
  });
  shutdowns.push(() => handlers.get("session_shutdown")());
  const chat = new Container();
  const ui = { children: [chat], requestRender() {} };
  let expanded = false;
  const ctx = { mode: "tui", sessionManager, ui: {
    theme: themeModule.theme, notify() {}, setStatus() {}, getToolsExpanded: () => expanded,
    setToolsExpanded(value) { expanded = value; for (const child of chat.children) child.setExpanded?.(value); },
  } };
  await handlers.get("session_start")({}, ctx);
  await handlers.get("agent_start")({}, ctx);
  const first = placedTool("first", ui);
  const second = placedTool("second", ui);
  chat.addChild(first);
  chat.addChild(second);
  await commands.get("tool-output").handler("minimal", ctx);
  const callback = new CustomMessageComponent({ customType: "subagent-stuck", content: "Worker stalled\nSESSION_CALLBACK_DETAIL" });
  chat.addChild(callback);
  assert.equal(callback.render(100).length, 1, "new notifications inherit minimal mode");
  ctx.ui.setToolsExpanded(true);
  assert.match(rendered(chat), /RESULT_BODY_SENTINEL/);
  assert.match(rendered(chat), /SESSION_CALLBACK_DETAIL/);
  for (const component of [first, second]) sessionManager.appendMessage({
    role: "toolResult", toolCallId: component.toolCallId, toolName: component.toolName,
    content: payload.content, isError: false, timestamp: 0,
  });
  await handlers.get("agent_end")?.({}, ctx);
  assert.equal(first.expanded, true, "an intermediate agent end must not fold continuation work");
  assert.doesNotMatch(rendered(chat), /2 tool calls/);
  await handlers.get("agent_start")({}, ctx);
  assert.match(rendered(chat), /RESULT_BODY_SENTINEL/);
  await handlers.get("agent_settled")({}, ctx);
  assert.equal(first.expanded, false);
  assert.equal(callback.render(100).length, 1);
  assert.equal(ctx.ui.getToolsExpanded(), false);
  ctx.ui.setToolsExpanded(!ctx.ui.getToolsExpanded());
  assert.match(rendered(chat), /RESULT_BODY_SENTINEL/, "the next Ctrl+O must reopen automatically folded tools");
  assert.match(rendered(chat), /SESSION_CALLBACK_DETAIL/);
  ctx.ui.setToolsExpanded(!ctx.ui.getToolsExpanded());
  assert.match(rendered(chat), /2 tool calls/);
  assert.doesNotMatch(rendered(chat), /first-arg|second-arg|RESULT_BODY_SENTINEL/);
  await handlers.get("session_shutdown")();
  await handlers.get("session_start")({}, ctx);
  assert.match(rendered(chat), /2 tool calls/);
  assert.equal(callback.render(100).length, 1, "reload folds restored notifications");
  await commands.get("tool-output").handler("normal", ctx);
  assert.match(rendered(chat), /SESSION_CALLBACK_DETAIL/);
  first.setExpanded(true);
  await handlers.get("agent_settled")({}, ctx);
  assert.equal(first.expanded, true, "completion must not change expansion in normal mode");
  assert.match(rendered(chat), /RESULT_BODY_SENTINEL/);
});

test("completed block mouse disclosure reveals call rows, supports detail and refolds the block", {
  skip: typeof prototype.handleMouse !== "function" ? "This Pi SDK has no fullscreen mouse routing" : false,
}, () => {
  const hook = install();
  const chat = new Container();
  const ui = { children: [chat], requestRender() {} };
  const first = placedTool("first", ui);
  const second = placedTool("second", ui);
  chat.addChild(first);
  chat.addChild(second);
  hook.setEnabled(true);
  hook.completeRun();
  const click = (y, extra = {}) => dispatchMouseEvent(chat, {
    type: "click", button: "left", x: 4, y, screenX: 4, screenY: y,
    width: 80, height: chat.render(80).length, shift: false, ctrl: false, alt: false, ...extra,
  });
  assert.equal(chat.render(80).length, 1);
  assert.equal(click(0, { ctrl: true }), undefined);
  assert.equal(click(0).handled, true);
  assert.equal(chat.render(80).length, 3);
  assert.match(rendered(chat), /first-arg/);
  assert.match(rendered(chat), /second-arg/);
  assert.doesNotMatch(rendered(chat), /RESULT_BODY_SENTINEL/);
  assert.equal(click(2).handled, true);
  assert.equal(second.expanded, true);
  assert.match(rendered(chat), /RESULT_BODY_SENTINEL/);
  assert.equal(click(0).handled, true);
  assert.equal(second.expanded, false);
  assert.equal(chat.render(80).length, 1);
  assert.equal(click(0).handled, true);
  assert.equal(click(1).handled, true);
  assert.equal(first.expanded, true);
  assert.match(rendered(chat), /RESULT_BODY_SENTINEL/);
  const headerY = chat.render(80).findIndex(line => stripVTControlCharacters(line).includes("first"));
  assert.ok(headerY >= 0);
  assert.equal(click(headerY).handled, true);
  assert.equal(first.expanded, false);
  assert.equal(chat.render(80).length, 3, "individual detail collapse retains block disclosure");
  for (const member of [first, second]) member.setExpanded(true);
  assert.match(rendered(chat), /RESULT_BODY_SENTINEL/);
  for (const member of [first, second]) member.setExpanded(false);
  assert.equal(chat.render(80).length, 1, "Ctrl+O collapse refolds a previously mouse-opened block");
});

test("minimal mode folds completed and live tool rows without adding boxes or spacers", () => {
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
    assert.deepEqual(chat.render(width), [first, thinking, read, edit, second, live].flatMap((component) => component.render(width)));
    for (const component of [read, edit, live]) {
      assert.equal(component.render(width).length, 1);
      assert.ok(visibleWidth(component.render(width)[0]) <= width);
    }
    assert.doesNotMatch(chat.render(width).join("\n"), /RESULT_BODY_SENTINEL|EDIT_BODY|LIVE_BODY/);
  }
  assert.equal(read.result, payload);
  assert.equal(edit.result.isError, true);

  read.setExpanded(true);
  edit.setExpanded(true);
  assert.match(rendered(chat), /RESULT_BODY_SENTINEL/);
  assert.match(rendered(chat), /EDIT_BODY/);
  assert.doesNotMatch(rendered(chat), /LIVE_BODY/);
  assert.match(rendered(chat), /live_probe-arg/);
  read.setExpanded(false);
  edit.setExpanded(false);
  assert.deepEqual(chat.render(100), [first, thinking, read, edit, second, live].flatMap((component) => component.render(100)));

  hook.dispose();
  assert.deepEqual(chat.render(100), normal);
});
