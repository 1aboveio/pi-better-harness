import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import childOwnership, { workerMonitoringRefusal } from "../child-ownership.ts";
import { STEER_FILE_ENV } from "../child-steer.ts";

function harness(worker = true) {
    const handlers = new Map();
    childOwnership({ on: (name, fn) => handlers.set(name, fn) }, worker ? { [STEER_FILE_ENV]: "/parent-owned/steer.json" } : {});
    return handlers;
}

describe("worker monitoring ownership", () => {
    it("refuses the recorded post-handoff watch and known watch entrypoints through both command tools", () => {
        const commands = [
            ["gh", ["run", "watch", "40880423328", "--exit-status", "--interval", "30"]],
            ["/usr/bin/gh", ["pr", "checks", "149", "--watch"]],
            ["gh.exe", ["pr", "checks", "149", "--watch=true"]],
            ["gh", ["--repo=owner/repo", "run", "watch", "123"]],
            ["gh", ["-Rowner/repo", "pr", "checks", "149", "--watch"]],
            ["gh", ["--repo", "owner/repo", "run", "watch", "123"]],
            ["/usr/bin/env", ["TMPDIR=/tmp", "gh", "run", "watch", "123"]],
            ["node", ["--import", "tsx", "/skills/mergify/scripts/watch-pr-delivery.mjs", "--pr", "149"]],
            ["/skills/watch-delivery.mjs", ["--pr", "149"]],
            ["bash", ["-lc", "gh run watch 123"]],
        ];
        for (const [executable, args] of commands) {
            assert.match(workerMonitoringRefusal("run_application", { executable, args }), /belongs to the coordinator/);
            const command = [executable, ...args.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`)].join(" ");
            assert.match(workerMonitoringRefusal("bash", { command }), /Return the PR\/run ID/);
        }
        for (const command of [
            "cd /workspace && gh run watch 123",
            "git status; gh pr checks 149 --watch=true",
            "cd /workspace\ngh run watch 123",
            "# read current state\ngh run watch 123",
            "# user's diagnostic note\ngh run watch 123",
            'echo ready # a "quoted note\ngh run watch 123',
            "2>/tmp/watch.log gh run watch 123",
            "cat <<'EOF'\ngh run watch 123\nEOF\ngh pr checks 149 --watch",
            "gh run \\\nwatch 123",
        ]) assert.ok(workerMonitoringRefusal("bash", { command }), command);
        assert.ok(workerMonitoringRefusal("bg_task_spawn", { command: "gh run watch 123" }));
        assert.ok(workerMonitoringRefusal("bg_task_spawn", { argv: ["gh", "run", "watch", "123"], shell: false }));
    });

    it("allows diagnostic reads, local tests/builds and quoted examples without weakening command limits", () => {
        for (const command of [
            "gh pr view 149 --json headRefOid,statusCheckRollup",
            "gh pr checks 149",
            "gh run view 123 --log-failed",
            "gh pr checks 149 --watch=false",
            "gh pr checks 149 -w",
            "gh pr checks 149 --web",
            "gh run view 123 --log > watch-pr-delivery.mjs",
            "cat <<'EOF'\ngh run watch 123\nEOF",
            "cat <<'EOF'\nThe user's example: gh run watch 123\nEOF\ngh pr view 149",
            "cat <<-'EOF'\n\tgh pr checks 149 --watch\n\tEOF",
            "gh run watch --help",
            "mergify queue show 149 --json",
            "npm test",
            "npm run build",
            "node --test test/slow-integration.test.mjs",
            "echo 'gh run watch 123'",
            "rg 'gh run watch' src",
            "printf '%s' 'example\ngh run watch 123'",
            "node print.mjs /skills/watch-pr-delivery.mjs",
        ]) assert.equal(workerMonitoringRefusal("bash", { command }), undefined, command);
        assert.equal(workerMonitoringRefusal("run_application", { executable: "npm", args: ["test"], timeout: 1800 }), undefined);
        assert.equal(workerMonitoringRefusal("write", { command: "gh run watch 123" }), undefined);
        assert.equal(workerMonitoringRefusal("run_application", { executable: "gh", args: [null] }), undefined, "tool schema owns malformed arguments");
    });

    it("blocks a delivery script before execution, while the coordinator and local test command still execute", () => {
        const root = mkdtempSync(join(tmpdir(), "worker-ownership-"));
        const marker = join(root, "executed");
        const script = join(root, "watch-pr-delivery.mjs");
        writeFileSync(script, 'import {writeFileSync} from "node:fs"; writeFileSync(process.argv[2], "executed");');
        const input = { executable: process.execPath, args: [script, marker] };
        const dispatch = (handlers, value) => {
            const refusal = handlers.get("tool_call")?.({ toolName: "run_application", input: value });
            if (refusal?.block) return refusal;
            return spawnSync(value.executable, value.args, { encoding: "utf8" });
        };
        try {
            const worker = harness();
            const blocked = dispatch(worker, input);
            assert.equal(blocked.block, true);
            assert.equal(existsSync(marker), false, "the refused watcher must never start");
            const test = join(root, "local-check.mjs");
            writeFileSync(test, 'import assert from "node:assert/strict"; assert.equal(1 + 1, 2);');
            assert.equal(dispatch(worker, { executable: process.execPath, args: [test] }).status, 0);
            const parent = harness(false);
            assert.equal(parent.has("tool_call"), false, "foreground sessions receive no ownership gate");
            assert.equal(dispatch(parent, input).status, 0);
            assert.equal(existsSync(marker), true, "coordinator can execute the same watcher");
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it("adds a worker handoff contract on each turn without changing the supplied prompt", () => {
        const handlers = harness();
        const original = { systemPrompt: "Existing security and task instructions." };
        const injected = handlers.get("before_agent_start")(original);
        assert.ok(injected.systemPrompt.startsWith(original.systemPrompt));
        assert.match(injected.systemPrompt, /Pending CI is a handoff/);
        assert.match(injected.systemPrompt, /Legitimate local tests and builds may run to completion/);
        assert.equal(original.systemPrompt, "Existing security and task instructions.");
    });
});
