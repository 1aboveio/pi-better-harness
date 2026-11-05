/**
 * Windows path handling in the two layers that store and publish records.
 *
 * Both regressions were only observable on Windows: the coordinator validator
 * rejected every workspace a Windows session reports, and the supervisor's
 * atomic write built its temp file name by splitting the path on `/`.
 *
 * The drive-letter assertions are skipped off Windows so the POSIX lanes stay
 * green; the CI lane that runs this file is `windows-verify`.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { requireWorkspace } from "./shared-operation-coordinator/src/validate.js";
import { writeTextAtomic } from "./supervisor/store.js";

const onWindows = process.platform === "win32";
const itOnWindows = onWindows ? it : it.skip;

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("coordinator workspace validation on Windows", () => {
  itOnWindows("accepts the drive path a Windows session reports", () => {
    expect(requireWorkspace("C:\\AiProjects\\Strata")).toBe("C:\\AiProjects\\Strata");
    expect(requireWorkspace("C:/AiProjects/Strata")).toBe("C:/AiProjects/Strata");
  });

  it("accepts a POSIX absolute path", () => {
    expect(requireWorkspace("/srv/work/strata")).toBe("/srv/work/strata");
  });

  it("still rejects a relative workspace", () => {
    expect(() => requireWorkspace("relative/strata")).toThrowError(/must be an absolute path/);
  });
});

describe("supervisor durable writes on Windows", () => {
  it("publishes a record and leaves no stray temp file", () => {
    const directory = mkdtempSync(join(tmpdir(), "pbh-durable-write-"));
    directories.push(directory);
    // join() produces the platform form: backslashes on Windows, where the
    // split-on-"/" bug named the whole path as the temp file.
    const target = join(directory, "records", "launch.json");

    writeTextAtomic(target, '{"version":1}');

    expect(readFileSync(target, "utf8")).toBe('{"version":1}');
    expect(readdirSync(join(directory, "records"))).toEqual(["launch.json"]);
  });
});
