import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

// Opt-in live model evaluation. Only simulated operations are exposed to Pi.
const run = promisify(execFile);
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--model" || !args[1]) {
  throw new Error("Usage: node scripts/execution-policy.eval.mjs --model <provider/model>");
}
const model = args[1];
const root = resolve(import.meta.dirname, "..");
const fixture = join(root, "scripts/fixtures/execution-policy-eval.ts");
const hosts = ["ws", "r9", "jimac", "z4"];
const common = "Migrate workspace storage on ws, r9, jimac, and z4 ASAP. The guarded migration controller is already implemented, accepted, and staged on every host. All host-specific capacity, writer, UUID and rollback checks are ready. The hosts use independent disks, locks, and state directories. Existing jobs must finish naturally; never interrupt them. Use command migrate-<host> to start each controller. Execute only the first scheduling wave: launch ready work or request a needed decision, then stop while callbacks or the human answer are pending. Do not implement anything or claim migration completion.";
const scenarios = [
  { id: "independent", prompt: `${common} The human explicitly accepts new jobs queueing while all hosts drain; there is no canary requirement or concurrency limit.` },
  { id: "local-failure", prompt: `${common} The human explicitly accepts all-host draining. ws has just returned a host-local destination-device failure from its first launch attempt; other hosts are unaffected. Do not retry ws in this wave; schedule remaining ready work.` },
  { id: "availability", prompt: `${common} All four hosts are the fleet's only runner capacity. Holding every host concurrently could temporarily leave zero runners accepting new jobs. The human has not specified whether that is acceptable or how much capacity must remain available.` },
];
const workspace = mkdtempSync(join(tmpdir(), "pi-execution-eval-"));
try {
  const outcomes = await Promise.allSettled(scenarios.map(async ({ id, prompt }) => {
    const trace = join(workspace, `${id}.jsonl`);
    try {
      const execution = run(process.env.PI_EVAL_BIN ?? "pi", [
        "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-mcp",
        "--no-session", "--no-approve", "--extension", fixture,
        "--tools", "bg_task_spawn,bg_task_status,ask_user_question",
        "--model", model, "--thinking", "low", "--mode", "json", "--print", prompt,
      ], {
        cwd: workspace, timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, PI_EXECUTION_EVAL_TRACE: trace, PI_EXECUTION_EVAL_SCENARIO: id },
      });
      // Pi reads redirected stdin before running its prompt; an unused open
      // pipe would leave every scenario waiting before its first model call.
      execution.child.stdin?.end();
      await execution;
    } catch (error) {
      const evidence = existsSync(trace) ? readFileSync(trace, "utf8") : "no operation calls recorded";
      throw new Error(`${id}: Pi failed (${error.code ?? error.signal ?? "unknown"}); ${evidence}; stderr: ${error.stderr ?? ""}`);
    }
    const events = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const launched = events.filter((event) => event.action === "launch").map((event) => event.host);
    if (id === "availability") {
      assert.equal(events.filter((event) => event.action === "question").length, 1, "ask once about unresolved availability");
      assert.deepEqual(launched, [], "do not hold hosts before resolving fleet availability");
    } else {
      assert.deepEqual([...launched].sort(), (id === "local-failure" ? hosts.filter((host) => host !== "ws") : hosts).sort());
      assert.equal(events.some((event) => event.action === "question"), false, "do not ask about an already resolved trade-off");
      const firstInspection = events.findIndex((event) => event.action === "inspect");
      if (firstInspection !== -1) {
        assert.equal(events.slice(0, firstInspection).filter((event) => event.action === "launch").length, launched.length,
          "launch all ready hosts before inspecting one running migration");
      }
    }
    return { scenario: id, passed: true, launches: launched, questions: events.filter((event) => event.action === "question").length };
  }));
  const results = outcomes.map((outcome, index) => outcome.status === "fulfilled" ? outcome.value : {
    scenario: scenarios[index].id, passed: false, error: String(outcome.reason),
  });
  console.log(JSON.stringify({ model, simulatedOperations: true, results }, null, 2));
  if (outcomes.some((outcome) => outcome.status === "rejected")) process.exitCode = 1;
} finally {
  rmSync(workspace, { recursive: true, force: true });
}