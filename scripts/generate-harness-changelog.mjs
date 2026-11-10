import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function projectHarnessChangelog(source, version) {
  const entries = [];
  let current;
  let fence;
  for (const line of source.replaceAll("\r\n", "\n").split("\n")) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
    }
    if (!fence && line.startsWith("## ")) {
      const match = line.match(/^## \[pi-better-harness@(\d+\.\d+\.\d+)\](.*)$/);
      current = match ? { version: match[1], lines: [`## [${match[1]}]${match[2]}`] } : undefined;
      if (current) entries.push(current);
    } else if (current) current.lines.push(line);
  }
  if (!entries.some((entry) => entry.version === version)) {
    throw new Error(`Root CHANGELOG.md has no pi-better-harness@${version} entry`);
  }
  return `# Changelog\n\n${entries.map((entry) => entry.lines.join("\n").trim()).join("\n\n")}\n`;
}

export function generateHarnessChangelog() {
  const packageDir = resolve(root, "packages/pi-better-harness");
  const { version } = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8"));
  const projected = projectHarnessChangelog(readFileSync(resolve(root, "CHANGELOG.md"), "utf8"), version);
  writeFileSync(resolve(packageDir, "CHANGELOG.md"), projected);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  generateHarnessChangelog();
}
