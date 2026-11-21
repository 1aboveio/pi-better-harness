import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

test("SQLite source attachment enforces readonly authority while pinning WAL and committing derived state", t => {
  const root = mkdtempSync(join(tmpdir(), "source-attachment-"));
  const path = join(root, "source #%?.sqlite");
  const writer = new DatabaseSync(path), derived = new DatabaseSync(":memory:");
  try {
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE facts(value); INSERT INTO facts VALUES('A')");
    const uri = pathToFileURL(path); uri.searchParams.set("mode", "ro");
    derived.prepare("ATTACH DATABASE ? AS coordinator_source").run(uri.href);
    for (const sql of ["INSERT INTO coordinator_source.facts VALUES('bad')", "UPDATE coordinator_source.facts SET value='bad'",
      "DELETE FROM coordinator_source.facts", "CREATE TABLE coordinator_source.bad(value)"]) {
      assert.throws(() => derived.exec(sql), /readonly/i);
    }
    derived.prepare("ATTACH DATABASE ? AS derived").run(join(root, "derived.sqlite"));
    derived.exec("CREATE TABLE derived.applied(value)");
    derived.exec("BEGIN");
    assert.equal(derived.prepare("SELECT value FROM coordinator_source.facts").get()!.value, "A");
    writer.exec("UPDATE facts SET value='B'");
    assert.equal(derived.prepare("SELECT value FROM coordinator_source.facts").get()!.value, "A");
    derived.exec("SAVEPOINT slice; INSERT INTO derived.applied VALUES('committed'); RELEASE slice; COMMIT");
    assert.equal(derived.prepare("SELECT value FROM coordinator_source.facts").get()!.value, "B");
    derived.exec("BEGIN; SAVEPOINT slice; INSERT INTO derived.applied VALUES('rollback'); RELEASE slice; ROLLBACK");
    assert.deepEqual(derived.prepare("SELECT value FROM derived.applied").all().map(row => row.value), ["committed"]);
    derived.exec("DETACH DATABASE derived");
    derived.prepare("ATTACH DATABASE ? AS derived").run(join(root, "derived.sqlite"));
    assert.equal(derived.prepare("SELECT count(*) AS n FROM derived.applied").get()!.n, 1);
    const missing = pathToFileURL(join(root, "missing.sqlite")); missing.searchParams.set("mode", "ro");
    assert.throws(() => derived.prepare("ATTACH DATABASE ? AS absent").run(missing.href), /unable to open/i);
    assert.equal(existsSync(join(root, "missing.sqlite")), false);
    t.diagnostic(JSON.stringify({ node: process.version, physicalHandles: 2, readOnlyDmlDdl: true,
      encodedPath: true, pinnedAConcurrentWriterB: true, derivedCommitRollbackReopen: true, missingSourceNotCreated: true }));
  } finally { derived.close(); writer.close(); rmSync(root, { recursive: true, force: true }); }
});
