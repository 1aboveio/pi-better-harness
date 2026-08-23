import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));

export const componentPackages = [
  // The sandbox is configured first so a fresh install has write protection in
  // place before the extensions whose work it confines.
  "pi-better-sandbox",
  "pi-better-subagents",
  "pi-better-background-tasks",
  "pi-better-goal",
];

const usage = `Usage: pi-better-harness <install|uninstall> [--local]

Commands:
  install      Configure all Pi Better Harness component packages
  uninstall    Remove all Pi Better Harness component packages

Options:
  -l, --local  Use project-local Pi settings
  -h, --help   Show this help
  -v, --version  Show the package version`;

export function run(argv, options = {}) {
  const spawn = options.spawn ?? spawnSync;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  if (argv.includes("--help") || argv.includes("-h")) {
    stdout.write(`${usage}\n`);
    return 0;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    stdout.write(`${version}\n`);
    return 0;
  }

  const local = argv.includes("--local") || argv.includes("-l");
  const positional = argv.filter((arg) => !["--local", "-l"].includes(arg));
  const command = positional[0];
  if (!command || positional.length !== 1 || !["install", "uninstall"].includes(command)) {
    stderr.write(`${usage}\n`);
    return 2;
  }

  const piCommand = process.platform === "win32" ? "pi.cmd" : "pi";
  const piAction = command === "install" ? "install" : "remove";
  for (const packageName of componentPackages) {
    const args = [piAction, `npm:${packageName}`, ...(local ? ["--local"] : [])];
    const result = spawn(piCommand, args, { stdio: "inherit" });
    if (result.error) {
      stderr.write(`Failed to run Pi for ${packageName}: ${result.error.message}\n`);
      return 1;
    }
    if (result.status !== 0) {
      return result.status ?? 1;
    }
  }
  return 0;
}