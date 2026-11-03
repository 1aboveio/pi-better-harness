import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import load from "../extensions/model-router/index.ts";

test("old hosts keep Harness available and receive a router upgrade notice", async () => {
  let handler: ((event: unknown, ctx: any) => void) | undefined;
  await load({ on(event: string, callback: typeof handler) {
    assert.equal(event, "session_start");
    handler = callback;
  } } as unknown as ExtensionAPI);
  const notices: string[] = [];
  handler!({}, { hasUI: true, ui: { notify(message: string) { notices.push(message); } } });
  assert.match(notices[0], /Upgrade Pi/);
  handler!({}, { hasUI: false });
});
test("supported hosts register the bundled provider and selectable virtual model", async () => {
  const providers: string[] = [];
  const models: string[] = [];
  await load({
    registerProvider(name: string) { providers.push(name); },
    registerVirtualModel(model: { provider: string; id: string }) { models.push(model.provider + "/" + model.id); },
    on() {},
    registerCommand() {},
  } as unknown as ExtensionAPI);
  assert.deepEqual(providers, ["ollama-cloud"]);
  assert.deepEqual(models, ["router/deepseek-flash-auto"]);
});
