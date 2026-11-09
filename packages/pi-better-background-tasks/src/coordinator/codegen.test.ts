/**
 * The shipped coordinator must be the emitted JavaScript closure, never the
 * TypeScript source (Node refuses type stripping under `node_modules`). This
 * regenerates into a temp directory and fails on any drift, matching the
 * supervisor runner's packaging invariant.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("coordinator shipped entrypoint", () => {
  it("regenerates the checked-in closure without drift", () => {
    const output = mkdtempSync(join(tmpdir(), "pi-coordinator-codegen-"));
    dirs.push(output);
    execFileSync(process.execPath, [join(here, "emit-runner.mjs"), output], { encoding: "utf8" });
    const generated = join(here, "generated");
    const names = readdirSync(generated).filter((name) => name.endsWith(".mjs")).sort();
    expect(names).toContain("coordinator.mjs");
    expect(names).toContain("server.mjs");
    expect(readdirSync(output).filter((name) => name.endsWith(".mjs")).sort()).toEqual(names);
    for (const name of names) {
      expect(readFileSync(join(output, name), "utf8")).toBe(readFileSync(join(generated, name), "utf8"));
    }
  }, 30_000);

  it("has no runtime import outside the emitted closure and Node builtins", () => {
    const generated = join(here, "generated");
    for (const name of readdirSync(generated).filter((entry) => entry.endsWith(".mjs"))) {
      const code = readFileSync(join(generated, name), "utf8");
      for (const match of code.matchAll(/from\s+"([^"]+)"/g)) {
        const specifier = match[1]!;
        expect(
          specifier.startsWith("node:") || specifier.startsWith("./"),
          `${name} imports ${specifier}`,
        ).toBe(true);
      }
    }
  });
});
