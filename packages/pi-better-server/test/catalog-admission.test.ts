import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CatalogAdmission } from "../src/runtime/catalog-admission.ts";

test("Catalog admission requires matching host start evidence at bind and on every read", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "catalog-identity-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "catalog-host-admission");
  mkdirSync(directory, { mode: 0o700 });
  const authority = { id: randomUUID(), secret: "a".repeat(64), generation: randomUUID(), cwd: root, sessionId: "session", branchId: "branch" };
  const start = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], {
    encoding: "utf8", env: { ...process.env, LC_ALL: "C" },
  }).trim().replace(/\s+/g, " ");
  const record = { ...authority, version: 1, serverInstance: "server", pid: process.pid, pidStartTime: start,
    secretHash: createHash("sha256").update(authority.secret).digest("hex"), projectTrusted: true, overlayDigest: "b".repeat(64) };
  const path = join(directory, `${authority.id}.json`);
  const save = (pidStartTime: unknown) => writeFileSync(path, JSON.stringify({ ...record, pidStartTime }), { mode: 0o600 });
  const admission = new CatalogAdmission(root, "server");
  const socket = {};
  for (const invalid of [undefined, "", "not-the-host-start", 123]) {
    save(invalid);
    assert.throws(() => admission.bind(authority, socket), /catalog-host-identity-refused/);
  }
  save(start);
  admission.bind(authority, socket);
  assert.equal(admission.verify(authority).sessionId, "session");
  save("not-the-host-start");
  assert.throws(() => admission.verify(authority), /catalog-host-identity-refused/);
  admission.close(socket);
});
