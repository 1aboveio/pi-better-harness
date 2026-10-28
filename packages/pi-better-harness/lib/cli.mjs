import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configureHarnessResources, preflightHarnessInstall } from "./install-settings.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));

const HARNESS_PACKAGE = "pi-better-harness";

export const componentPackages = [
  // The foreground policy publisher is configured before the extensions that
  // consume its active or inactive launch decision.
  "pi-better-sandbox",
  "pi-better-subagents",
  "pi-better-background-tasks",
  "pi-better-ssh",
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

function scopeArgs(local) {
  return local ? ["--local"] : [];
}

function manualRemoveCommand(local) {
  return `pi remove npm:${HARNESS_PACKAGE}${local ? " --local" : ""}`;
}

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

  let preflight;
  if (command === "install") {
    // Validate the selected settings file before Pi writes to it. This keeps
    // malformed or unexpected settings from being replaced by a partial install.
    try {
      preflight = (options.preflight ?? preflightHarnessInstall)(local);
    } catch (error) {
      stderr.write(`Refusing to install: ${error.message}\n`);
      return 1;
    }
  }

  const piCommand = process.platform === "win32" ? "pi.cmd" : "pi";
  const piAction = command === "install" ? "install" : "remove";
  for (const packageName of [...componentPackages, HARNESS_PACKAGE]) {
    const args = [piAction, `npm:${packageName}`, ...scopeArgs(local)];
    const result = spawn(piCommand, args, { stdio: "inherit" });
    if (result.error) {
      stderr.write(`Failed to run Pi for ${packageName}: ${result.error.message}\n`);
      return 1;
    }
    if (result.status !== 0) {
      return result.status ?? 1;
    }
  }
  if (command === "install") {
    try {
      (options.configure ?? configureHarnessResources)(local);
    } catch (error) {
      stderr.write(`Failed to configure Harness resources: ${error.message}\n`);
      if (preflight?.harnessRegistered === true) {
        // The registration predates this run. Leave it alone rather than
        // removing a setup the user already had.
        stderr.write("Kept the existing Harness registration unchanged.\n");
      } else {
        // Pi registered Harness unfiltered. Remove that registration so Pi does
        // not load the bundled components alongside the standalone packages.
        const recovery = spawn(piCommand, ["remove", `npm:${HARNESS_PACKAGE}`, ...scopeArgs(local)], {
          stdio: "inherit",
        });
        if (recovery.error) {
          stderr.write(`Could not remove the unfiltered Harness registration: ${recovery.error.message}\n`);
          stderr.write(`Run \`${manualRemoveCommand(local)}\` before starting Pi.\n`);
        } else if (recovery.status !== 0) {
          stderr.write(`Could not remove the unfiltered Harness registration (exit ${recovery.status}).\n`);
          stderr.write(`Run \`${manualRemoveCommand(local)}\` before starting Pi.\n`);
        } else {
          stderr.write("Removed the unfiltered Harness registration; the component packages remain installed.\n");
        }
      }
      return 1;
    }
  }
  return 0;
}
