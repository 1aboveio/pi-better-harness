import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openSupervisorSettings } from "../extensions/settings/supervisor.ts";
import { readHarnessSetting, updateHarnessSetting } from "../extensions/shared-harness-settings.ts";

test("Supervisor settings retain selections and merge edits from another session", async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const dir = mkdtempSync(join(tmpdir(), "pi-supervisor-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const steps = [
      ["Turn Supervisor mode on"], ["Turn Supervisor mode off", "[ ] CI observation recovery"],
      ["Turn Supervisor mode off", "[x] CI observation recovery"], ["Turn Supervisor mode on"],
      ["Turn Supervisor mode off", "[x] CI observation recovery"],
    ];
    const selections = [0, 1, 0, 0];
    let index = 0;
    const select = async (_title: string, choices: string[]) => {
      assert.deepEqual(choices, steps[index]);
      if (index === 1) updateHarnessSetting("supervisorMode", () => ({ enabled: true, scenarios: ["other"] }));
      return choices[selections[index++]];
    };
    await openSupervisorSettings({ ui: { select } } as Parameters<typeof openSupervisorSettings>[0]);
    assert.equal(index, steps.length);
    assert.deepEqual(readHarnessSetting("supervisorMode"), { enabled: true, scenarios: ["other", "ci-observation"] });
    process.env.PI_CODING_AGENT_DIR = join(dir, "isolated");
    assert.equal(readHarnessSetting("supervisorMode"), undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
