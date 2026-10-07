import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import {
  closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readdirSync, realpathSync, rmSync, rmdirSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import {
  SandboxDiagnostics, analyzeDiagnostics, diagnosticPackageVersion, diagnosticsEnabled, exportDiagnostics,
  formatDiagnosticsSummary, readDiagnostics, setDiagnosticsEnabled,
  isDiagnosticReport, type DiagnosticReport,
  type DiagnosticContext, type DiagnosticGroup, type DiagnosticObservation, type DiagnosticRecord,
} from "./index.ts";
import { readHarnessSetting, updateHarnessSetting } from "../harness-settings/index.ts";

const DAY = 24 * 60 * 60 * 1000;
// Fixed, well within retention; advancing this clock proves causal ordering and expiry.
const NOW = Date.now();
function fixture(t: { after(fn: () => void): void }, enabled = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-diagnostics-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const seams = { agentDir: () => root };
  if (enabled) setDiagnosticsEnabled(true, seams);
  const dir = join(root, "diagnostics", "sandbox");
  const journal = join(dir, "events.jsonl");
  let now = NOW;
  const errors: unknown[] = [];
  const collector = (context: DiagnosticContext = "foreground", policy: () => unknown = () => ({ network: false }), version = "1", backend: () => string | undefined = () => "unknown") =>
    new SandboxDiagnostics({ ...seams, context, policy, version, backend, now: () => now, onError: e => { errors.push(e); } });
  return { root, seams, dir, journal, errors, collector, tick: (value: number) => { now = value; } };
}
const denial = (operation: unknown = "attempt", tool = "read"): DiagnosticObservation =>
  ({ operation, tool, resource: "unknown", basis: "policy-refusal", outcome: "denied" });
const success = (operation: unknown = "attempt", tool = "read"): DiagnosticObservation =>
  ({ operation, tool, resource: "unknown", basis: "agent-reported", outcome: "succeeded" });
function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return lstatSync(path).isDirectory() ? allFiles(path) : [path];
  });
}
function child(code: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    process.stderr.on("data", data => { stderr += data; });
    process.on("error", reject);
    process.on("close", exit => exit === 0 ? resolve() : reject(new Error(stderr || `exit ${exit}`)));
  });
}

test("disabled by default and invalid opt-ins create no diagnostic files or evaluate policy", t => {
  const f = fixture(t, false);
  let callbacks = 0;
  const c = f.collector("foreground", () => { callbacks++; throw new Error("must not run"); });
  for (const config of [undefined, true, { version: 2, enabled: true }, { version: 1, enabled: "true" }, { version: 1, enabled: true, extra: "private" }]) {
    if (config !== undefined) updateHarnessSetting("sandboxDiagnostics", () => config, f.seams);
    assert.equal(diagnosticsEnabled(f.seams), false);
    c.observe(denial());
    c.observe(success());
    assert.deepEqual(readDiagnostics(f.seams).records, []);
    assert.equal(existsSync(join(f.root, "diagnostics")), false);
  }
  assert.equal(callbacks, 0);
  assert.deepEqual(f.errors, []);
});

test("missing, malformed, or sensitive package metadata degrades to unknown without affecting collection", t => {
  const f = fixture(t);
  const path = join(f.root, "package.json");
  assert.equal(diagnosticPackageVersion(pathToFileURL(path)), "unknown");
  for (const value of ["{malformed-secret-canary", JSON.stringify({ version: "/private/version-canary" }), "null"]) {
    writeFileSync(path, value);
    assert.equal(diagnosticPackageVersion(pathToFileURL(path)), "unknown");
  }
  f.collector("foreground", undefined, diagnosticPackageVersion(pathToFileURL(path))).observe(denial());
  assert.equal(readDiagnostics(f.seams).records[0]?.version, "unknown");
  assert.deepEqual(f.errors, []);
  writeFileSync(path, JSON.stringify({ version: "1.2.3" }));
  assert.equal(diagnosticPackageVersion(pathToFileURL(path)), "1.2.3");
});

test("opt-in persists globally, preserves siblings, and disabling stops collection without deleting evidence", t => {
  const f = fixture(t, false);
  writeFileSync(join(f.root, "settings.json"), JSON.stringify({ theme: "dark", piBetterHarness: { sandbox: { enabled: true }, goal: { enabled: false } } }));
  setDiagnosticsEnabled(true, f.seams);
  assert.equal(diagnosticsEnabled(f.seams), true);
  assert.deepEqual(readHarnessSetting("sandboxDiagnostics", f.seams), { version: 1, enabled: true });
  assert.deepEqual(readHarnessSetting("sandbox", f.seams), { enabled: true });
  assert.deepEqual(readHarnessSetting("goal", f.seams), { enabled: false });
  assert.equal(JSON.parse(readFileSync(join(f.root, "settings.json"), "utf8")).theme, "dark");
  f.collector().observe(denial());
  setDiagnosticsEnabled(false, f.seams);
  f.collector().observe(denial("ignored"));
  const data = readDiagnostics(f.seams);
  assert.equal(data.enabled, false);
  assert.equal(data.records.length, 1);
  const bad = "{broken settings";
  writeFileSync(join(f.root, "settings.json"), bad);
  assert.throws(() => setDiagnosticsEnabled(true, f.seams), SyntaxError);
  assert.equal(readFileSync(join(f.root, "settings.json"), "utf8"), bad);
});

test("privacy canaries are absent from journal/export and identities are keyed, stable, and installation-local", t => {
  const f = fixture(t);
  const other = fixture(t);
  const canaries = ["cat /private/credential-canary", "/private/path-canary", "PRIVATE CONTENT CANARY", "customer-id-canary"];
  const operation = { command: canaries[0], path: canaries[1], contents: canaries[2], id: canaries[3] };
  const c = f.collector("worker", () => ({ path: canaries[1], prose: canaries[2] }), canaries[3], () => canaries[0]);
  c.observe({ ...denial(operation, canaries[2]), resource: "credential-files", unexpected: canaries[3] } as DiagnosticObservation);
  c.observe(denial({ id: canaries[3], contents: canaries[2], path: canaries[1], command: canaries[0] }, canaries[2]));
  other.collector("worker", () => ({ path: canaries[1], prose: canaries[2] })).observe(denial(operation, canaries[2]));
  const data = readDiagnostics(f.seams);
  assert.deepEqual(data.issues, []);
  assert.equal(data.records.length, 2);
  assert.equal(data.records[0].tool, "extension-tool");
  assert.equal(data.records[0].version, "unknown");
  assert.equal(data.records[0].backend, "unknown");
  assert.equal(data.records[0].operationFingerprint, data.records[1].operationFingerprint);
  assert.equal(data.records[0].policyFingerprint, data.records[1].policyFingerprint);
  assert.notEqual(data.records[0].operationFingerprint, readDiagnostics(other.seams).records[0].operationFingerprint);
  assert.notEqual(data.records[0].operationFingerprint, createHash("sha256").update(JSON.stringify(operation)).digest("base64url"));
  assert.deepEqual(Object.keys(data.records[0]).sort(), ["schema", "timestamp", "version", "platform", "backend", "tool", "resource", "basis", "outcome", "context", "operationFingerprint", "policyFingerprint", "fingerprint"].sort());
  const path = exportDiagnostics(f.seams);
  assert.equal(path, join(f.dir, "export.json"));
  assert.equal(exportDiagnostics(f.seams), path);
  const exported = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(exported.records, data.records);
  for (const file of allFiles(join(f.root, "diagnostics"))) {
    const raw = readFileSync(file, "utf8");
    for (const canary of canaries) assert.equal(raw.includes(canary), false, `canary leaked in ${file}`);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  }
  assert.equal(statSync(join(f.root, "diagnostics")).mode & 0o777, 0o700);
  assert.equal(statSync(f.dir).mode & 0o777, 0o700);
});

test("only a causal prior denial in the same context/tool/operation permits recovery, including changed policy", t => {
  const f = fixture(t);
  const c = f.collector();
  c.observe(success());
  assert.equal(existsSync(join(f.root, "diagnostics")), false);
  c.observe(denial({ a: 1, b: 2 }));
  f.collector("worker").observe(success({ a: 1, b: 2 }));
  c.observe(success({ a: 1, b: 2 }, "bash"));
  c.observe(success({ a: 1, b: 3 }));
  f.tick(NOW - 1);
  c.observe(success({ a: 1, b: 2 }));
  assert.equal(readDiagnostics(f.seams).records.length, 1);
  f.tick(NOW + 1);
  const changed = f.collector("foreground", () => ({ network: true }));
  changed.observe(success({ b: 2, a: 1 }));
  changed.observe(success({ a: 1, b: 2 }));
  let data = readDiagnostics(f.seams);
  assert.equal(data.records.length, 2);
  assert.equal(data.records[1].recoveryOf, data.records[0].fingerprint);
  assert.notEqual(data.records[1].policyFingerprint, data.records[0].policyFingerprint);
  assert.equal(analyzeDiagnostics(data).observedOperations, 1);
  assert.equal(analyzeDiagnostics(data).recovered, 1);
  assert.equal(analyzeDiagnostics(data).outstanding, 0);
  c.observe(denial({ a: 1, b: 2 }));
  c.observe(denial({ b: 2, a: 1 }));
  data = readDiagnostics(f.seams);
  assert.equal(analyzeDiagnostics(data).outstanding, 1);
  changed.observe(success({ a: 1, b: 2 }));
  changed.observe(success({ a: 1, b: 2 }));
  data = readDiagnostics(f.seams);
  assert.equal(data.records.length, 5, "duplicate success cannot recover an older denial again");
  assert.equal(data.records.at(-1)!.recoveryOf, data.records[3].fingerprint);
  assert.equal(analyzeDiagnostics(data).recovered, 1);
  assert.deepEqual(data.issues, []);
});

test("different extension tools with identical inputs cannot recover each other's failures", t => {
  const f = fixture(t);
  const c = f.collector();
  c.observe(denial({}, "mcp__private_a"));
  c.observe(success({}, "mcp__private_b"));
  assert.equal(readDiagnostics(f.seams).records.length, 1);
  c.observe(success({}, "mcp__private_a"));
  const data = readDiagnostics(f.seams);
  assert.equal(data.records.length, 2);
  assert.equal(analyzeDiagnostics(data).recovered, 1);
  assert.doesNotMatch(JSON.stringify(data), /mcp__private_[ab]/);
});

test("distinct JSON operation shapes do not accidentally share a recovery identity", t => {
  const f = fixture(t);
  const c = f.collector();
  c.observe(denial([]));
  c.observe(success(Array(1)));
  c.observe(success({}));
  c.observe(success(undefined));
  assert.equal(readDiagnostics(f.seams).records.length, 1);
  c.observe(success([]));
  assert.equal(analyzeDiagnostics(readDiagnostics(f.seams)).recovered, 1);
});

test("analysis separates each requested dimension while counting observed operations independently", t => {
  const f = fixture(t);
  const c = f.collector();
  c.observe(denial("base"));
  c.observe(denial("base"));
  f.collector("foreground", undefined, "2").observe(denial("version"));
  f.collector("foreground", undefined, "1", () => "macos-seatbelt").observe(denial("backend"));
  c.observe(denial("tool", "bash"));
  c.observe({ ...denial("resource"), resource: "tool-admission" });
  c.observe({ ...denial("basis"), basis: "os-permission-error" });
  f.collector("foreground", () => ({ network: true })).observe(denial("policy"));
  const data = readDiagnostics(f.seams);
  const analysis = analyzeDiagnostics(data);
  assert.equal(analysis.groups.length, 7);
  assert.equal(analysis.observedOperations, 7);
  assert.equal(analysis.outstanding, 7);
  const base = analysis.groups.find(g => g.denied === 2);
  assert.ok(base);
  assert.equal(base.succeeded, 0);
  const dimensions = ["version", "backend", "tool", "resource", "basis", "policyFingerprint"] as const;
  for (const key of dimensions) {
    const other: DiagnosticGroup | undefined = analysis.groups.find(g => g[key] !== base[key] &&
      dimensions.filter(k => k !== key).every(k => g[k] === base[k]));
    assert.ok(other, `missing separate ${key} group`);
    assert.equal(other.denied, 1);
  }
  for (let i = 0; i < 25; i++) f.collector("foreground", () => ({ policy: i })).observe(denial(`summary-${i}`));
  const summary = formatDiagnosticsSummary(readDiagnostics(f.seams));
  assert.ok(summary.split("\n").length <= 25);
  assert.match(summary, /additional groups in the local JSON export/);
  const exported = JSON.parse(readFileSync(exportDiagnostics(f.seams), "utf8"));
  assert.equal(exported.analysis.groups.length, 32);
});

test("age eviction removes dependent recovery evidence and losses persist in summary/export", t => {
  const f = fixture(t);
  const c = f.collector();
  f.tick(NOW - 29 * DAY);
  c.observe(denial("old"));
  f.tick(NOW);
  c.observe(success("old"));
  f.tick(NOW + 2 * DAY);
  c.observe(success("old"));
  const data = readDiagnostics(f.seams);
  assert.deepEqual(data.records, []);
  assert.equal(data.losses.age, 2);
  assert.deepEqual(data.issues, ["retention-loss"]);
  assert.match(formatDiagnosticsSummary(data), /retention-loss.*age=2/);
  const exported = JSON.parse(readFileSync(exportDiagnostics(f.seams), "utf8"));
  assert.equal(exported.losses.age, 2);
  assert.deepEqual(exported.issues, ["retention-loss"]);
  assert.equal(exported.analysis.observedOperations, 0);
  c.observe(denial("new"));
  assert.equal(readDiagnostics(f.seams).losses.age, 2);
});

// Populate genuine signed storage through an independent wire-format fixture, then
// exercise real collection/retention. This avoids thousands of quadratic disk writes.
function seed(f: ReturnType<typeof fixture>, records: DiagnosticRecord[]) {
  const key = Buffer.from(readFileSync(join(f.dir, "installation.key"), "utf8").trim(), "hex");
  const hmac = (domain: string, value: string) => createHmac("sha256", key).update(`${domain}\0${value}`).digest("base64url");
  const lines = records.map((r, i) => {
    const record = { ...r, operationFingerprint: hmac("fixture-operation", String(r.outcome === "succeeded" ? i - 1 : i)), fingerprint: hmac("fixture-event", String(i)) };
    if (record.outcome === "succeeded") record.recoveryOf = hmac("fixture-event", String(i - 1));
    return JSON.stringify({ ...record, mac: hmac("event", JSON.stringify(record)) });
  });
  const header = { schema: 1, kind: "journal", losses: { age: 0, count: 0, bytes: 0, malformed: 0, tampered: 0 }, count: lines.length, digest: hmac("journal", lines.join("\n")) };
  writeFileSync(f.journal, `${JSON.stringify({ ...header, mac: hmac("header", JSON.stringify(header)) })}\n${lines.join("\n")}\n`);
}

test("count retention is atomic, capped at 2000 entries, and reports discarded observations", t => {
  const f = fixture(t);
  const c = f.collector();
  c.observe(denial());
  const record = readDiagnostics(f.seams).records[0];
  seed(f, Array.from({ length: 2000 }, () => record));
  assert.ok(statSync(f.journal).size <= 1024 * 1024, "fixture starts within byte cap");
  const previous = openSync(f.journal, "r");
  try {
    const before = readFileSync(f.journal, "utf8");
    c.observe(denial("last"));
    // An already-open reader still has a complete prior journal, never a partial replacement.
    assert.equal(readFileSync(previous, "utf8"), before);
    const data = readDiagnostics(f.seams);
    assert.equal(before.split("\n").filter(Boolean).length, 2001);
    assert.equal(data.records.length, 2000);
    assert.equal(data.losses.count, 1);
    assert.equal(data.losses.bytes, 0);
    assert.deepEqual(data.issues, ["retention-loss"]);
    assert.equal(f.errors.length, 1);
    c.observe(denial("last-two"));
    assert.equal(readDiagnostics(f.seams).losses.count, 2);
  } finally { closeSync(previous); }
});

test("byte retention includes signed framing and stays bounded without silently losing records", t => {
  const f = fixture(t);
  const c = f.collector("background", () => ({ network: false }), "999999.999999.999999-rc.999999", () => "linux-bubblewrap");
  c.observe({ ...denial("seed", "subagent_spawn_batch"), resource: "outside-project-files", basis: "os-permission-error" });
  c.observe({ ...success("seed", "subagent_spawn_batch"), resource: "outside-project-files", basis: "os-permission-error" });
  const records = readDiagnostics(f.seams).records;
  const samples = readFileSync(f.journal, "utf8").trimEnd().split("\n").slice(1);
  const averageBytes = samples.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0) / 2;
  const capacity = Math.floor((1024 * 1024 - 700) / averageBytes / 2) * 2;
  assert.ok(capacity < 2000);
  seed(f, Array.from({ length: capacity }, (_, i) => records[i % 2]));
  for (let i = 0; i < 5; i++) c.observe({ ...denial(`byte-${i}`, "subagent_spawn_batch"), resource: "outside-project-files", basis: "os-permission-error" });
  const data = readDiagnostics(f.seams);
  assert.ok(statSync(f.journal).size <= 1024 * 1024);
  assert.ok(data.losses.bytes > 0);
  assert.equal(data.losses.count, 0);
  assert.equal(data.records.length + data.losses.bytes, capacity + 5);
  assert.deepEqual(data.issues, ["retention-loss"]);
  assert.match(formatDiagnosticsSummary(data), /retention-loss/);
  assert.ok(JSON.parse(readFileSync(exportDiagnostics(f.seams), "utf8")).losses.bytes > 0);
});

test("malformed and tampered records are excluded, reported, and remain visible after subsequent collection", t => {
  const f = fixture(t);
  const c = f.collector();
  c.observe(denial("a"));
  c.observe(denial("b"));
  const lines = readFileSync(f.journal, "utf8").trimEnd().split("\n");
  const tampered = JSON.parse(lines[2]);
  tampered.outcome = "denied";
  tampered.resource = "network-access";
  writeFileSync(f.journal, `${lines[0]}\n${lines[1]}\n${JSON.stringify(tampered)}\n{PRIVATE MALFORMED CANARY\n`);
  let data = readDiagnostics(f.seams);
  assert.equal(data.records.length, 1);
  assert.equal(data.losses.malformed, 1);
  assert.ok(data.losses.tampered > 0);
  assert.deepEqual(data.issues, ["malformed-data", "tampered-data"]);
  c.observe(denial("new"));
  data = readDiagnostics(f.seams);
  assert.equal(data.records.length, 2);
  assert.equal(data.losses.malformed, 1);
  assert.equal(f.errors.length, 1);
  const raw = readFileSync(exportDiagnostics(f.seams), "utf8");
  assert.equal(raw.includes("PRIVATE MALFORMED CANARY"), false);
  assert.deepEqual(JSON.parse(raw).issues, ["malformed-data", "tampered-data"]);
  assert.match(formatDiagnosticsSummary(data), /malformed-data, tampered-data/);
});

test("record removal, replay, unknown fields, invalid headers, and missing keys never look healthy", t => {
  for (const variant of ["remove", "replay", "extra", "header", "key", "oversized"] as const) {
    const f = fixture(t);
    f.collector().observe(denial());
    const lines = readFileSync(f.journal, "utf8").trimEnd().split("\n");
    if (variant === "remove") writeFileSync(f.journal, `${lines[0]}\n`);
    if (variant === "replay") writeFileSync(f.journal, `${lines.join("\n")}\n${lines[1]}\n`);
    if (variant === "extra") {
      const record = JSON.parse(lines[1]); record.rawCommand = "PRIVATE EXTRA CANARY";
      writeFileSync(f.journal, `${lines[0]}\n${JSON.stringify(record)}\n`);
    }
    if (variant === "header") writeFileSync(f.journal, `{bad header\n${lines[1]}\n`);
    if (variant === "key") rmSync(join(f.dir, "installation.key"));
    if (variant === "oversized") writeFileSync(f.journal, "x".repeat(1024 * 1024 + 1));
    const data = readDiagnostics(f.seams);
    assert.ok(data.issues.length > 0, variant);
    assert.doesNotMatch(formatDiagnosticsSummary(data), /Journal gaps: none recorded/);
    const exported = readFileSync(exportDiagnostics(f.seams), "utf8");
    assert.equal(exported.includes("PRIVATE EXTRA CANARY"), false);
    assert.ok(JSON.parse(exported).issues.length > 0);
  }
});

test("symlink journal, key, lock, export, and diagnostic directories cannot overwrite external targets", t => {
  for (const name of ["events.jsonl", "installation.key", "events.jsonl.lock", "export.json", "diagnostics", "sandbox"] as const) {
    const f = fixture(t);
    f.collector().observe(denial("initial"));
    const target = join(f.root, `outside-${name.replaceAll(".", "-")}`);
    const isDir = ["diagnostics", "sandbox", "events.jsonl.lock"].includes(name);
    if (isDir) mkdirSync(target); else writeFileSync(target, "EXTERNAL FILE CANARY");
    const path = name === "diagnostics" ? join(f.root, name) : join(name === "sandbox" ? join(f.root, "diagnostics") : f.dir, name);
    rmSync(path, { recursive: true, force: true });
    symlinkSync(target, path, isDir ? "dir" : "file");
    assert.doesNotThrow(() => f.collector().observe(denial("next")));
    assert.equal(f.errors.length, 1, name);
    assert.deepEqual(readDiagnostics(f.seams).issues, ["unsafe-storage"], name);
    assert.throws(() => exportDiagnostics(f.seams), /Unsafe diagnostics storage/);
    assert.equal(lstatSync(path).isSymbolicLink(), true);
    if (isDir) assert.deepEqual(readdirSync(target), []);
    else assert.equal(readFileSync(target, "utf8"), "EXTERNAL FILE CANARY");
  }
});

test("filesystem and callback failures never escape observe and collection gaps reach onError", t => {
  const f = fixture(t);
  mkdirSync(join(f.root, "diagnostics"));
  writeFileSync(join(f.root, "diagnostics", "sandbox"), "not a directory");
  let called = 0;
  const c = new SandboxDiagnostics({ ...f.seams, context: "foreground", version: "1", policy: () => ({}), backend: () => undefined, onError: () => { called++; throw new Error("callback failure"); } });
  assert.doesNotThrow(() => c.observe(denial()));
  assert.equal(called, 1);
  assert.equal(existsSync(f.journal), false);
  assert.deepEqual(readDiagnostics(f.seams).issues, ["unsafe-storage"]);
  rmSync(join(f.root, "diagnostics"), { recursive: true });
  const badPolicy = f.collector("foreground", () => { throw new Error("policy unavailable"); });
  assert.doesNotThrow(() => badPolicy.observe(denial()));
  assert.equal(f.errors.length, 1);
  assert.equal(existsSync(f.journal), false);
  let getters = 0;
  const operation = { get command() { getters++; return "private"; } };
  assert.doesNotThrow(() => f.collector().observe(denial(operation)));
  assert.equal(getters, 0);
  assert.equal(f.errors.length, 2);
});

test("an atomic journal write failure preserves prior evidence and does not escape observe", t => {
  const f = fixture(t);
  const c = f.collector();
  c.observe(denial("before"));
  const before = readFileSync(f.journal, "utf8");
  const original = fs.writeFileSync;
  const mock = t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
    if (String(args[0]).startsWith(`${f.journal}.`)) throw Object.assign(new Error("Injected filesystem write failure"), { code: "EIO" });
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.doesNotThrow(() => c.observe(denial("lost")));
    assert.equal(f.errors.length, 1);
    assert.equal((f.errors[0] as NodeJS.ErrnoException).code, "EIO");
    assert.equal(readFileSync(f.journal, "utf8"), before);
    assert.equal(existsSync(`${f.journal}.lock`), false);
    assert.deepEqual(readdirSync(f.dir).sort(), ["events.jsonl", "installation.key"]);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
  c.observe(denial("after"));
  assert.equal(readDiagnostics(f.seams).records.length, 2);
});

test("a proper-lockfile owner blocks collection without writing or altering its lock", t => {
  const f = fixture(t);
  const c = f.collector();
  c.observe(denial());
  const lockfile = createRequire(import.meta.url)("proper-lockfile");
  const release = lockfile.lockSync(f.journal, { realpath: false });
  const before = readFileSync(f.journal, "utf8");
  try {
    c.observe(denial("blocked"));
    assert.equal(f.errors.length, 1);
    assert.equal((f.errors[0] as NodeJS.ErrnoException).code, "ELOCKED");
    assert.equal(readFileSync(f.journal, "utf8"), before);
    assert.equal(lstatSync(`${f.journal}.lock`).isDirectory(), true);
  } finally { release(); }
});

test("old and orphaned locks fail closed instead of allowing a stale owner takeover", t => {
  const f = fixture(t);
  const c = f.collector();
  c.observe(denial("before"));
  const lock = `${f.journal}.lock`;
  mkdirSync(lock, { mode: 0o700 });
  utimesSync(lock, new Date(0), new Date(0));
  const owner = lstatSync(lock);
  const before = readFileSync(f.journal, "utf8");
  c.observe(denial("contender"));
  assert.equal((f.errors[0] as NodeJS.ErrnoException)?.code, "ELOCKED");
  assert.equal(lstatSync(lock).ino, owner.ino);
  assert.equal(readFileSync(f.journal, "utf8"), before);
  rmdirSync(lock);
  c.observe(denial("after explicit cleanup"));
  assert.equal(readDiagnostics(f.seams).records.length, 2);
});

test("a paused live writer keeps exclusivity and a contender cannot remove its lock", { skip: process.platform === "win32" }, async t => {
  const f = fixture(t);
  f.collector().observe(denial("before"));
  const module = new URL("./index.ts", import.meta.url).href;
  const worker = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import {SandboxDiagnostics} from ${JSON.stringify(module)};
    const d=new SandboxDiagnostics({context:'foreground',version:'1',agentDir:()=>${JSON.stringify(f.root)},
      policy:()=>{process.stdout.write('LOCK_HELD\\n');process.kill(process.pid,'SIGSTOP');return {network:false};},
      backend:()=> 'unknown',onError:()=>{process.exitCode=1;}});
    d.observe({tool:'read',operation:'paused owner',resource:'unknown',basis:'policy-refusal',outcome:'denied'});
  `], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  worker.stderr.on("data", data => { stderr += data; });
  const done = new Promise<number | null>((resolve, reject) => { worker.on("error", reject); worker.on("close", resolve); });
  try {
    await new Promise<void>((resolve, reject) => {
      worker.once("error", reject);
      worker.stdout.once("data", data => { assert.match(String(data), /LOCK_HELD/); resolve(); });
      worker.once("exit", () => reject(new Error(stderr || "Worker exited before owning its lock.")));
    });
    const lock = `${f.journal}.lock`;
    const owner = lstatSync(lock);
    utimesSync(lock, new Date(0), new Date(0));
    const before = readFileSync(f.journal, "utf8");
    f.collector().observe(denial("contender"));
    assert.equal((f.errors[0] as NodeJS.ErrnoException)?.code, "ELOCKED");
    assert.equal(lstatSync(lock).ino, owner.ino);
    assert.equal(readFileSync(f.journal, "utf8"), before);
    worker.kill("SIGCONT");
    assert.equal(await done, 0, stderr);
    assert.equal(existsSync(lock), false);
    f.collector().observe(denial("later contender"));
    const data = readDiagnostics(f.seams);
    assert.equal(data.records.length, 3);
    assert.deepEqual(data.issues, []);
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
    await done;
  }
});

test("transient zero-link journal stats before acquisition cannot drop a cooperating writer", t => {
  const f = fixture(t);
  f.collector().observe(denial("before"));
  const original = fs.lstatSync;
  const mock = t.mock.method(fs, "lstatSync", function(path: fs.PathLike, ...args: any[]) {
    const result = Reflect.apply(original, fs, [path, ...args]) as ReturnType<typeof lstatSync>;
    if (result && String(path) === f.journal && !existsSync(`${f.journal}.lock`)) result.nlink = 0;
    return result;
  });
  syncBuiltinESMExports();
  try {
    f.collector().observe(denial("after"));
    const data = readDiagnostics(f.seams);
    assert.equal(data.records.length, 2);
    assert.deepEqual(data.issues, []);
    assert.deepEqual(f.errors, []);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

test("independent concurrent processes retain all denials and cross-process causal recoveries", async t => {
  const f = fixture(t);
  const module = new URL("./index.ts", import.meta.url).href;
  const setup = `import {SandboxDiagnostics} from ${JSON.stringify(module)};
    const d=new SandboxDiagnostics({context:'background',version:'1.2.3',agentDir:()=>${JSON.stringify(f.root)},policy:()=>({network:false}),backend:()=> 'linux-bubblewrap',onError:e=>{process.stderr.write('collection gap: '+(e?.code??e?.message)+'\\n');process.exitCode=1;}});`;
  const run = (id: number, outcome: string) => child(`${setup}
    for(let i=0;i<12;i++)d.observe({tool:'bash',operation:{worker:${id},i},resource:'command-execution',basis:'policy-refusal',outcome:${JSON.stringify(outcome)}});`);
  await Promise.all(Array.from({ length: 4 }, (_, i) => run(i, "denied")));
  let data = readDiagnostics(f.seams);
  assert.equal(data.records.length, 48);
  assert.deepEqual(data.issues, []);
  assert.equal(analyzeDiagnostics(data).outstanding, 48);
  await Promise.all(Array.from({ length: 4 }, (_, i) => run(i, "succeeded")));
  data = readDiagnostics(f.seams);
  assert.equal(data.records.length, 96);
  assert.deepEqual(data.issues, []);
  assert.equal(analyzeDiagnostics(data).recovered, 48);
  assert.equal(analyzeDiagnostics(data).outstanding, 0);
  const denials = new Map(data.records.filter(r => r.outcome === "denied").map(r => [r.fingerprint, r]));
  for (const r of data.records.filter(r => r.outcome === "succeeded")) {
    const prior = denials.get(r.recoveryOf!);
    assert.ok(prior);
    assert.equal(r.operationFingerprint, prior.operationFingerprint);
    assert.equal(r.context, prior.context);
    assert.equal(r.tool, prior.tool);
  }
  assert.equal(analyzeDiagnostics(data).groups.length, 1);
  assert.equal(analyzeDiagnostics(data).groups[0].denied, 48);
  assert.equal(analyzeDiagnostics(data).groups[0].succeeded, 48);
});

test("worker relay emits only redacted categories and ephemeral fingerprints without touching global storage or settings locks", t => {
  const f = fixture(t);
  f.collector().observe(denial("parent evidence"));
  const before = allFiles(f.root).map(path => [path, readFileSync(path, "utf8")]);
  const reports: DiagnosticReport[] = [];
  const canary = "/private/credential-path-and-command-canary";
  const worker = () => new SandboxDiagnostics({ ...f.seams, context: "worker", version: canary,
    policy: () => ({ path: canary }), backend: () => canary, relay: r => { reports.push(r); } });
  const first = worker();
  first.observe(denial({ path: canary }, canary));
  first.observe(denial({ path: canary }, canary));
  first.observe(success({ path: canary }, canary));
  worker().observe(denial({ path: canary }, canary));
  assert.equal(reports.length, 4);
  assert.ok(reports.every(isDiagnosticReport));
  assert.equal(reports[0].tool, "extension-tool");
  assert.equal(reports[0].operationFingerprint, reports[1].operationFingerprint);
  assert.equal(reports[0].operationFingerprint, reports[2].operationFingerprint);
  assert.equal(reports[0].policyFingerprint, reports[1].policyFingerprint);
  assert.notEqual(reports[0].idFingerprint, reports[1].idFingerprint);
  assert.notEqual(reports[0].operationFingerprint, reports[3].operationFingerprint);
  assert.notEqual(reports[0].policyFingerprint, reports[3].policyFingerprint);
  assert.equal(JSON.stringify(reports).includes(canary), false);
  assert.equal(JSON.stringify(reports).includes(readFileSync(join(f.dir, "installation.key"), "utf8").trim()), false);
  assert.deepEqual(allFiles(f.root).map(path => [path, readFileSync(path, "utf8")]), before);
  assert.equal(existsSync(join(f.root, "settings.json.lock")), false);
});

test("relay recovery is operation-bound, bounded, and opt-in is read dynamically without initializing storage", t => {
  const f = fixture(t, false);
  const reports: DiagnosticReport[] = [];
  let policies = 0;
  const c = new SandboxDiagnostics({ ...f.seams, context: "worker", version: "1", backend: () => "unknown",
    policy: () => { policies++; return {}; }, relay: r => { reports.push(r); } });
  c.observe(denial());
  setDiagnosticsEnabled(true, f.seams);
  c.observe(success());
  assert.equal(policies, 0);
  c.observe(denial("same", "private-tool-a"));
  c.observe(success("same", "private-tool-b"));
  c.observe(success("different", "private-tool-a"));
  setDiagnosticsEnabled(false, f.seams);
  c.observe(success("same", "private-tool-a"));
  assert.equal(reports.length, 1);
  setDiagnosticsEnabled(true, f.seams);
  c.observe(success("same", "private-tool-a"));
  c.observe(success("same", "private-tool-a"));
  assert.equal(reports.length, 2);
  assert.equal(reports[1].operationFingerprint, reports[0].operationFingerprint);
  for (let i = 0; i <= 2000; i++) c.observe(denial(i));
  const count = reports.length;
  c.observe(success(0));
  assert.equal(reports.length, count, "evicted operations cannot claim recovery");
  c.observe(success(2000));
  assert.equal(reports.length, count + 1);
  assert.equal(existsSync(join(f.root, "diagnostics")), false);
});

test("parent import validates fixed reports, rekeys identities, downgrades basis, and persistently deduplicates rescan/reload", t => {
  const f = fixture(t);
  const reports: DiagnosticReport[] = [];
  const worker = new SandboxDiagnostics({ ...f.seams, context: "worker", version: "1.2.3", backend: () => "linux-bubblewrap",
    policy: () => ({ raw: "/private/policy-canary" }), relay: r => { reports.push(r); } });
  worker.observe({ ...denial("/private/operation-canary"), resource: "credential-files" });
  worker.observe(success("/private/operation-canary"));
  const parent = () => f.collector("worker", () => { throw new Error("import must not evaluate parent policy"); }, "9.9.9",
    () => { throw new Error("import must not use the parent's backend"); });
  const c = parent();
  c.observeReport(reports[1], "run-a");
  assert.equal(existsSync(join(f.root, "diagnostics")), false, "success alone creates nothing");
  for (const bad of [null, {}, { ...reports[0], schema: 2 }, { ...reports[0], tool: "private-name" },
    { ...reports[0], basis: "policy-refusal" }, { ...reports[0], resource: "private-resource" },
    { ...reports[0], type: "tool_execution_end" }, { ...reports[0], idFingerprint: "bad" },
    { ...reports[0], version: "/private/version-canary" }, { ...reports[0], platform: "/private/platform-canary" },
    { ...reports[0], backend: "/private/backend-canary" },
    { ...reports[0], rawPath: "/private/rejected-canary" }]) {
    assert.equal(isDiagnosticReport(bad), false);
    c.observeReport(bad, "run-a");
  }
  for (let i = 0; i < 3; i++) for (const r of reports) parent().observeReport(r, "run-a");
  let data = readDiagnostics(f.seams);
  assert.equal(data.records.length, 2);
  assert.equal(analyzeDiagnostics(data).recovered, 1);
  assert.ok(data.records.every(r => r.basis === "agent-reported" && r.context === "worker"));
  assert.ok(data.records.every(r => r.version === "1.2.3" && r.backend === "linux-bubblewrap" && r.platform === process.platform));
  assert.equal(data.records[1].recoveryOf, data.records[0].fingerprint);
  assert.equal(data.records[1].resource, "credential-files");
  for (const field of ["operationFingerprint", "policyFingerprint"] as const) {
    assert.notEqual(data.records[0][field], reports[0][field]);
  }
  assert.notEqual(data.records[0].fingerprint, reports[0].idFingerprint);
  const before = readFileSync(f.journal, "utf8");
  parent().observeReport(reports[0], "run-a");
  assert.equal(readFileSync(f.journal, "utf8"), before);
  parent().observeReport(reports[1], "run-b");
  assert.equal(readDiagnostics(f.seams).records.length, 2, "runs cannot recover each other");
  parent().observeReport(reports[0], "run-b");
  parent().observeReport(reports[1], "run-b");
  data = readDiagnostics(f.seams);
  assert.equal(data.records.length, 4);
  assert.notEqual(data.records[0].operationFingerprint, data.records[2].operationFingerprint);
  assert.deepEqual(data.issues, []);
  assert.deepEqual(f.errors, []);
  assert.doesNotMatch(readFileSync(exportDiagnostics(f.seams), "utf8"), /private\//);
});

test("relay and import failures are nonfatal sanitized gaps and do not fabricate recovery", t => {
  const f = fixture(t);
  const reports: DiagnosticReport[] = [];
  const errors: unknown[] = [];
  let fails = true;
  const c = new SandboxDiagnostics({ ...f.seams, context: "worker", version: "1", backend: () => "unknown", policy: () => ({}),
    relay: r => { if (fails) throw new Error("/private/transport-canary"); reports.push(r); },
    onError: e => { errors.push(e); throw new Error("/private/callback-canary"); } });
  assert.doesNotThrow(() => c.observe(denial()));
  fails = false;
  c.observe(success());
  assert.equal(reports.length, 0);
  c.observe(denial());
  writeFileSync(join(f.root, "settings.json"), "{ /private/settings-canary");
  assert.doesNotThrow(() => c.observe(success()));
  assert.equal(reports.length, 1);
  writeFileSync(join(f.root, "settings.json"), JSON.stringify({ piBetterHarness: { sandboxDiagnostics: { version: 1, enabled: true } } }));
  mkdirSync(join(f.root, "diagnostics"));
  writeFileSync(join(f.root, "diagnostics", "sandbox"), "blocked");
  const parent = new SandboxDiagnostics({ ...f.seams, context: "worker", version: "1", backend: () => "unknown", policy: () => ({}), onError: e => { errors.push(e); } });
  assert.doesNotThrow(() => parent.observeReport(reports[0], "run"));
  assert.equal(errors.length, 3);
  assert.ok(errors.every(e => e instanceof Error && e.message === "Diagnostics collection has gaps."));
  assert.equal(existsSync(f.journal), false);
});
