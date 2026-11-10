#!/usr/bin/env node
// Real-host render benchmark for #690.
//
// Usage:
//   node scripts/render-host-benchmark.mjs --root <candidate-or-baseline-checkout> \
//     --label current --reps 3 --animation off \
//     --output .test-evidence/benchmark/host-current.json
//
// The probe seeds 3,140 historical operations plus three current-session rows,
// mounts the real candidate extensions in Pi's fullscreen TUI, and runs one
// scripted streaming tool turn. It records actual TUI requestRender calls and
// doRender frames, frame time, process CPU and projection SQL queries/rows.
// Run the same command against the original baseline checkout for comparison.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
function argument(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
}
const root = resolve(argument("root", process.cwd()));
const label = argument("label", "current");
const reps = Number(argument("reps", "3"));
const animation = argument("animation", "off") === "on";
const output = resolve(argument("output", `.test-evidence/benchmark/host-${label}-${animation ? "on" : "off"}.json`));
const workDir = resolve(argument("work-dir", ".test-evidence/benchmark/runs"));
const probe = resolve("scripts/render-host-benchmark-probe.mjs");
const pi = process.env.PI_RENDER_BENCH_CLI ?? "/opt/homebrew/bin/pi";
const q = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

mkdirSync(workDir, { recursive: true });
mkdirSync(resolve(output, ".."), { recursive: true });
const results = [];
for (let rep = 0; rep < reps; rep += 1) {
  const dir = join(workDir, `${label}-${animation ? "on" : "off"}-${rep}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  const agent = join(dir, "agent");
  const tmp = join(dir, "tmp");
  const ready = join(dir, "ready");
  const resultPath = join(dir, "result.json");
  mkdirSync(agent, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  writeFileSync(join(agent, "settings.json"), JSON.stringify({
    theme: "dark",
    tuiMode: "fullscreen",
    packages: [],
    quietStartup: true,
    piBetterHarness: {
      toolOutput: { version: 1, enabled: true },
      toolAnimation: { version: 1, enabled: animation },
    },
  }));
  const socket = `render-host-${process.pid}-${label}-${animation ? "on" : "off"}-${rep}`;
  const tmux = (...tmuxArgs) => execFileSync("tmux", ["-L", socket, ...tmuxArgs], { encoding: "utf8" });
  const capture = () => tmux("capture-pane", "-t", "bench", "-p");
  const command = [
    "exec env",
    `PI_CODING_AGENT_DIR=${q(agent)}`,
    `TMPDIR=${q(tmp)}`,
    "PI_OFFLINE=1",
    "OPENAI_API_KEY=sk-render-bench-placeholder",
    "COLORTERM=truecolor",
    `PI_RENDER_BENCH_ROOT=${q(root)}`,
    `PI_RENDER_BENCH_READY=${q(ready)}`,
    `PI_RENDER_BENCH_RESULT=${q(resultPath)}`,
    `PI_RENDER_BENCH_ANIMATION=${animation ? "1" : "0"}`,
    q(pi),
    "--approve",
    "--no-skills",
    "--no-context-files",
    "-e", q(join(root, "packages/pi-better-background-tasks/src/index.ts")),
    "-e", q(join(root, "packages/pi-better-harness/extensions/minimal-output/index.ts")),
    "-e", q(probe),
    "--model", "openai/gpt-4o-mini",
    "--name", "render-host-benchmark",
  ].join(" ");
  try {
    tmux("new-session", "-d", "-s", "bench", "-x", "120", "-y", "40", command);
    tmux("set-option", "-w", "-t", "bench", "remain-on-exit", "on");
    const readyDeadline = Date.now() + 30_000;
    while (!existsSync(ready) && Date.now() < readyDeadline) sleep(50);
    if (!existsSync(ready)) throw new Error(`probe did not become ready:\n${capture()}`);
    sleep(400);
    tmux("send-keys", "-t", "bench", "-l", "Run the render benchmark workload");
    tmux("send-keys", "-t", "bench", "Enter");
    const resultDeadline = Date.now() + 30_000;
    while (!existsSync(resultPath) && Date.now() < resultDeadline) sleep(50);
    if (!existsSync(resultPath)) throw new Error(`workload did not settle:\n${capture()}`);
    results.push(JSON.parse(readFileSync(resultPath, "utf8")));
  } finally {
    spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
  }
}
const summarize = (key) => {
  const values = results.map((result) => result[key]).filter((value) => typeof value === "number");
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
};
const summary = {
  root,
  label,
  animation,
  reps: results.length,
  frames: summarize("frames"),
  requests: summarize("requests"),
  navigatorListRowsCalls: summarize("navigatorListRowsCalls"),
  navigatorRows: summarize("navigatorRows"),
  frameTimeMsMean: summarize("frameTimeMsMean"),
  frameTimeMsP95: summarize("frameTimeMsP95"),
  processCpuMs: summarize("processCpuMs"),
  durationMs: summarize("durationMs"),
  projectionQueries: summarize("projectionQueries"),
  projectionRows: summarize("projectionRows"),
};
writeFileSync(output, JSON.stringify({ summary, results }, null, 2));
console.log(JSON.stringify({ output, summary }, null, 2));
