import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { readBoundedTail, tailTerminalDisplay } from "./index.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("readBoundedTail", () => {
  it("reads only the bounded end of a large file", () => {
    const directory = mkdtempSync(join(tmpdir(), "pi-log-utils-"));
    directories.push(directory);
    const path = join(directory, "output.log");
    writeFileSync(path, `${"discarded\n".repeat(50_000)}recent-one\nrecent-two\n`);

    const tail = readBoundedTail(path, 64);

    assert.equal(tail.truncated, true);
    assert.ok(tail.totalBytes > 64);
    assert.match(tail.text, /recent-one\nrecent-two\n$/);
    assert.ok(tail.text.length <= 64);
  });
});

describe("tailTerminalDisplay", () => {
  it("collapses carriage-return progress while preserving final error lines", () => {
    const output = "10%\r20%\r99%\rRead from remote host: Operation timed out\nclient_loop: Broken pipe\n";

    assert.equal(
      tailTerminalDisplay(output, 10),
      "Read from remote host: Operation timed out\nclient_loop: Broken pipe",
    );
  });

  it("keeps the final progress snapshot without a trailing newline", () => {
    assert.equal(tailTerminalDisplay("10%\r20%\r99%", 10), "99%");
  });
});