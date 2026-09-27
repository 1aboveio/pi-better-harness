// Throwaway spike driver (#344). Runs as the real (unsandboxed) user.
// Usage: node run.mjs <out.json>
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";

process.on("uncaughtException", (e) => { console.error("UNCAUGHT", e?.stack ?? e); process.exit(3); });
console.error("run.mjs start", process.version);
const outPath = process.argv[2] ?? join(import.meta.dirname, "out.json");
const here = import.meta.dirname;
const home = join(os.homedir(), "spikehome");
const nogrant = join(os.homedir(), "spike-nogrant");
const sh = (file, args, opts = {}) => execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const icacls = (...args) => sh("icacls", args);
const report = { user: os.userInfo().username, home: os.homedir() };

const [, userSid] = sh("whoami", ["/user", "/fo", "csv", "/nh"]).split(",").map((s) => s.replace(/"/g, ""));
const logonSid = sh("whoami", ["/logonid"]);
report.userSid = userSid;
report.logonSid = logonSid;
report.integrity = (sh("whoami", ["/groups", "/fo", "csv", "/nh"]).match(/Mandatory Label\\([^"]+)"/) ?? [])[1];
const elevated = /High/.test(report.integrity ?? "");
report.elevated = elevated;

const cap = () => `S-1-5-21-${Array.from({ length: 4 }, () => randomInt(1, 2 ** 31)).join("-")}`;
const R = cap(), W = cap(), D = cap(), C = cap(), N = cap(), A = cap(), P = cap();
report.sids = { R, W, D, C, N, A, P };

// DeriveCapabilitySidsFromName availability (no admin), isolated: a crash must not stop the spike.
{
    const r = spawnSync(process.execPath, [join(here, "derive.mjs")], { encoding: "utf8" });
    report.deriveCapabilitySid = r.status === 0 ? r.stdout.trim() : `exit ${r.status} ${r.stderr.slice(0, 300)}`;
}

function buildTree() {
    for (const dir of [home, nogrant]) fs.rmSync(dir, { recursive: true, force: true });
    const mk = (path, content) => { fs.mkdirSync(join(path, ".."), { recursive: true }); if (content !== undefined) fs.writeFileSync(path, content); else fs.mkdirSync(path, { recursive: true }); };
    const S = join(home, "projects", "sibling");
    for (const f of ["data.txt", "data2.txt", "data3.txt", "data4.txt"]) mk(join(S, f), f);
    mk(join(S, "emptydir"));
    mk(join(home, ".cache", "x.txt"), "x");
    mk(join(home, ".cache", "sub", "deep", "f.txt"), "f");
    mk(join(home, ".ssh", "id"), "SECRET");
    mk(join(home, ".config", "gh", "hosts.yml"), "SECRET");
    mk(join(home, ".config", "other.txt"), "o");
    mk(join(home, ".bashrc"), "echo hi");
    mk(join(home, "projects", "ws", "a.txt"), "a");
    mk(join(home, "projects", "ws", "b.txt"), "b");
    mk(join(home, "tmp"));
    mk(join(nogrant, "x.txt"), "x");
}

function applyAcls() {
    const t0 = Date.now();
    icacls(home, "/grant", `*${R}:(OI)(CI)(RX)`, `*${W}:(OI)(CI)(W)`);
    for (const dir of [".cache", ".config", "tmp"]) icacls(join(home, dir), "/grant", `*${D}:(OI)(CI)(D)`);
    icacls(join(home, "projects", "ws"), "/grant", `*${P}:(OI)(CI)(D)`);
    icacls(join(home, ".ssh"), "/deny", `*${C}:(OI)(CI)(F)`);
    icacls(join(home, ".config", "gh"), "/deny", `*${C}:(OI)(CI)(F)`);
    icacls(join(home, ".bashrc"), "/deny", `*${N}:(W,D,WDAC,WO)`);
    for (const anchor of [home, join(home, ".config"), join(home, "projects")]) icacls(anchor, "/deny", `*${A}:(D)`);
    return Date.now() - t0;
}

function registrySetup() {
    // A granted subkey: tests "grant a harness SID write on part of HKCU".
    const ps = [
        "$k = 'HKCU:\\Software\\PiSpikeGranted'",
        "if (-not (Test-Path $k)) { New-Item $k | Out-Null }",
        "$acl = Get-Acl $k",
        `$sid = New-Object System.Security.Principal.SecurityIdentifier('${W}')`,
        "$rule = New-Object System.Security.AccessControl.RegistryAccessRule($sid, 'SetValue,CreateSubKey,QueryValues,EnumerateSubKeys', 'ContainerInherit', 'None', 'Allow')",
        "$acl.AddAccessRule($rule); Set-Acl $k $acl",
        "Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name PiSpike -ErrorAction SilentlyContinue",
        "Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce' -Name PiSpike -ErrorAction SilentlyContinue",
        "Remove-Item 'HKCU:\\Software\\PiSpike' -ErrorAction SilentlyContinue",
    ].join("; ");
    return sh("pwsh", ["-NoProfile", "-Command", ps]);
}

function hkcuRootAcl() {
    return sh("pwsh", ["-NoProfile", "-Command",
        "(Get-Acl 'HKCU:\\Software').Access | ForEach-Object { \"$($_.IdentityReference) $($_.AccessControlType) $($_.RegistryRights)\" }"]);
}

const everyone = "S-1-1-0", users = "S-1-5-32-545", restrictedSid = "S-1-5-12";
const ruleSids = [R, W, D, C, N, A, P];
const base = {
    restrictingSids: [...ruleSids, everyone, users, restrictedSid, logonSid],
    disableSids: ["S-1-5-32-544"],
    defaultDaclSids: [userSid, logonSid, "S-1-5-18"],
    cwd: home,
};
const variants = {
    full: { ...base, writeRestricted: false, defaultDacl: true, mediumIntegrity: elevated },
    fullHighIL: elevated ? { ...base, writeRestricted: false, defaultDacl: true, mediumIntegrity: false } : undefined,
    fullNoDefaultDacl: { ...base, writeRestricted: false, defaultDacl: false, mediumIntegrity: elevated },
    writeRestricted: { ...base, writeRestricted: true, defaultDacl: true, mediumIntegrity: elevated },
};

report.hkcuSoftwareAcl = hkcuRootAcl();
report.results = {};
console.error("setup done", JSON.stringify({ userSid, logonSid, integrity: report.integrity, derive: report.deriveCapabilitySid }));
for (const [name, cfg] of Object.entries(variants)) {
    if (!cfg) continue;
    buildTree();
    report.aclMs = applyAcls();
    try { report.registrySetup = registrySetup() || "ok"; } catch (e) { report.registrySetup = `ERR ${e.stderr ?? e.message}`; }
    const cfgPath = join(here, `cfg-${name}.json`);
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    const env = { ...process.env, SPIKE_HOME: home, SPIKE_NOGRANT: nogrant, TEMP: join(home, "tmp"), TMP: join(home, "tmp") };
    const r = spawnSync(process.execPath, [join(here, "launch.mjs"), cfgPath, "--", `"${process.execPath}"`, `"${join(here, "probe.mjs")}"`],
        { encoding: "utf8", env, timeout: 300_000 });
    let parsed;
    try { parsed = JSON.parse(r.stdout); } catch { parsed = { launchFailed: `exit ${r.status}`, stdout: r.stdout?.slice(0, 500), stderr: r.stderr?.slice(0, 1000) }; }
    if (r.stderr) parsed._stderr = r.stderr.slice(0, 600);
    report.results[name] = parsed;
    console.error("variant", name, "status", r.status, r.error?.message ?? "", (r.stderr ?? "").slice(0, 300));
    // Post-run registry check (did Run/RunOnce really get written?).
    try {
        report.results[name]._runKeyPresent = sh("pwsh", ["-NoProfile", "-Command",
            "[bool](Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name PiSpike -ErrorAction SilentlyContinue)"]);
    } catch (e) { report.results[name]._runKeyPresent = `ERR ${e.message}`; }
}

// Launch overhead: direct cmd vs through the launcher.
{
    const cfgPath = join(here, "cfg-full.json");
    const time = (fn) => { const t = process.hrtime.bigint(); for (let i = 0; i < 5; i++) fn(); return Number(process.hrtime.bigint() - t) / 5e6; };
    report.launchMs = {
        direct: time(() => spawnSync("cmd.exe", ["/d", "/c", "exit 0"])),
        viaLauncher: time(() => spawnSync(process.execPath, [join(here, "launch.mjs"), cfgPath, "--", "cmd.exe /d /c exit 0"])),
    };
}

// Propagation cost: 20k files in 200 folders, one inherited grant.
{
    const bench = join(os.homedir(), "spike-bench");
    fs.rmSync(bench, { recursive: true, force: true });
    for (let d = 0; d < 200; d++) {
        const dir = join(bench, `d${d}`, "nested");
        fs.mkdirSync(dir, { recursive: true });
        for (let f = 0; f < 100; f++) fs.writeFileSync(join(dir, `f${f}.txt`), "x");
    }
    const t0 = Date.now();
    icacls(bench, "/grant", `*${R}:(OI)(CI)(RX)`, `*${W}:(OI)(CI)(W)`);
    report.propagate20kFilesMs = Date.now() - t0;
    const t1 = Date.now();
    icacls(bench, "/remove", `*${R}`, `*${W}`);
    report.revoke20kFilesMs = Date.now() - t1;
    report.benchSampleAcl = icacls(join(bench, "d7", "nested", "f3.txt"));
    fs.rmSync(bench, { recursive: true, force: true });
}

report.sampleAcls = {
    bashrc: icacls(join(home, ".bashrc")),
    ghHosts: icacls(join(home, ".config", "gh", "hosts.yml")),
};
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
