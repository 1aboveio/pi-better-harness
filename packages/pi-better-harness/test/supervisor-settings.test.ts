import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import harnessSettings from "../extensions/settings/index.ts";
import { enabledScenarios, readSupervisorSettings } from "../extensions/settings/supervisor.ts";
import { readHarnessSetting, updateHarnessSetting } from "../extensions/shared-harness-settings.ts";

test("the Supervisor switch and scenario picker are independent and preserve concurrent edits", async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const dir = mkdtempSync(join(tmpdir(), "pi-supervisor-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    type Page = { render(width: number): string[]; handleInput(key: string): void };
    let page!: Page;
    let pagesOpened = 0;
    const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text, inverse: (text: string) => text };
    const screen = () => page.render(98).join("\n");
    const focus = (label: string) => {
      for (let i = 0; i < 24; i++) {
        if (screen().includes(`> ${label}  `)) return;
        page.handleInput("\x1b[B");
      }
      assert.fail(`Missing ${label}: ${screen()}`);
    };
    const press = async (key: string) => {
      page.handleInput(key);
      await new Promise(resolve => setImmediate(resolve));
    };
    const bus = new EventEmitter();
    let handler!: (args: string, ctx: unknown) => Promise<void>;
    harnessSettings({ events: bus, on() {}, registerCommand(_name: string, command: { handler: typeof handler }) {
      handler = command.handler;
    } } as never);
    const command = handler("", { mode: "tui", sessionManager: { getBranch: () => [] }, ui: {
      notify: assert.fail, custom: (build: Function) => new Promise(resolve => { pagesOpened++; page = build({}, theme, {}, resolve); }),
    } });
    focus("Supervisor scenarios");
    assert.match(screen(), /Supervisor mode \(Beta\)\s+Off/);
    await press("\r");
    assert.match(screen(), /^Supervisor scenarios\n/);
    assert.equal(readHarnessSetting("supervisorMode"), undefined, "opening scenarios does not write");
    focus("Diagnose stalled Goals");
    updateHarnessSetting("supervisorMode", () => ({ enabled: false, scenarios: ["other"] }));
    await press(" ");
    assert.match(screen(), /> Diagnose stalled Goals\s+\[x\]/);
    assert.deepEqual(enabledScenarios(), []);
    assert.deepEqual(readSupervisorSettings().scenarios, ["other", "stall-diagnosis"]);
    await press("\x1b");
    assert.match(screen(), /> Supervisor scenarios\s+›/);
    focus("Supervisor mode (Beta)");
    const beforeToggle = pagesOpened;
    await press(" ");
    assert.match(screen(), /> Supervisor mode \(Beta\)\s+On/);
    assert.deepEqual(enabledScenarios(), ["other", "stall-diagnosis"]);
    await press("\r");
    assert.match(screen(), /> Supervisor mode \(Beta\)\s+Off/);
    assert.deepEqual(enabledScenarios(), []);
    assert.equal(pagesOpened, beforeToggle, "toggling the switch updates its own row in place");
    assert.ok(readSupervisorSettings().revision);
    assert.deepEqual(readSupervisorSettings().scenarios, ["other", "stall-diagnosis"]);
    await press("\x1b");
    await command;
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
