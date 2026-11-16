import assert from "node:assert/strict";
import childProcess, { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { createTaskExecutor } from "./exec.ts";
import { processIdentityDirectory } from "./process-identity.ts";
import type { SandboxWritePolicy } from "../sandbox-core/index.ts";
const mac = process.platform === "darwin";

function fixture(t: test.TestContext, read = true) {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "identity-boundary-")));
    const root = join(base, "project"), control = join(base, "control");
    mkdirSync(root); mkdirSync(control);
    const policy: SandboxWritePolicy = { writableRoot: root, home: homedir(), denyWrite: [control],
        permissions: { commands: true, shell: true, projectFiles: "read-write", outsideProject: "read", storedCredentials: "off", network: false, processAccess: read ? "read" : "off" } };
    const plan = { confined: true as const, policy, profilePath: join(control, "task.sb") };
    const run = createTaskExecutor({ requireLaunchPlan: () => plan });
    t.after(() => rmSync(base, { recursive: true, force: true }));
    return { root, control, policy, plan, run };
}
const caller = `
const cp = require('node:child_process');
const fs = require('node:fs');
const child = cp.spawn('/bin/sleep', ['30']);
child.on('spawn', () => {
  try {
    const identity = cp.execFileSync('ps', ['-p', String(child.pid), '-o', 'lstart=', '-o', 'comm='], { encoding:'utf8', timeout:3000 });
    if (!identity.trim().endsWith('/bin/sleep')) throw new Error('wrong identity');
    const helper = process.env.PATH.split(':')[0] + '/ps';
    try { fs.writeFileSync(helper, 'replaced'); throw new Error('helper was writable'); }
    catch(e) { if (!['EPERM','EACCES'].includes(e.code)) throw e; }
    console.log('identity and protection passed');
  } catch(e) { console.log('query failed: ' + (e.code || e.message)); process.exitCode = 1; }
  finally { child.kill('SIGTERM'); }
});
`;

test("unchanged Node ps identity call works inside the command boundary", { skip: !mac }, async t => {
    const f = fixture(t);
    f.policy.permissions!.outsideProject = "write";
    let output = "";
    const result = await f.run({ kind: "argv", execPath: process.execPath, execArgs: ["-e", caller] }, f.root, { onData: chunk => { output += chunk; } });
    assert.equal(result.exitCode, 0, output);
    assert.match(output, /identity and protection passed/);
});

test("shell callers get matching lstart/comm output; raw ps stays confined", { skip: !mac }, async t => {
    const f = fixture(t);
    const child = spawn("/bin/sleep", ["30"]); await once(child, "spawn");
    try {
        const expected = execFileSync("/bin/ps", ["-p", String(child.pid), "-o", "lstart=", "-o", "comm="], { encoding: "utf8" }).trim();
        let output = "";
        const result = await f.run({ kind: "shell", command: `ps -p ${child.pid} -o lstart= -o comm=` }, f.root, { onData: chunk => { output += chunk; } });
        assert.equal(result.exitCode, 0, output); assert.equal(output.trim(), expected);
        output = "";
        const denied = await f.run({ kind: "argv", execPath: process.execPath, execArgs: ["-e", "const r=require('node:child_process').spawnSync('/bin/ps',['-p',String(process.pid),'-o','comm=']);console.log(r.error?.code)"] }, f.root, { onData: chunk => { output += chunk; } });
        assert.equal(denied.exitCode, 0); assert.match(output, /EPERM/);
    } finally { const exited = once(child, "exit"); child.kill(); await exited; }
});

test("Process Off does not install the compatibility entry", { skip: !mac }, async t => {
    const f = fixture(t, false);
    assert.equal(await processIdentityDirectory(f.plan), undefined);
    let output = "";
    const result = await f.run({ kind: "argv", execPath: process.execPath, execArgs: ["-e", caller] }, f.root, { onData: chunk => { output += chunk; } });
    assert.equal(result.exitCode, 1); assert.match(output, /EPERM/);
});

test("read-only identity is available with outside files Off and shell scripts Off", { skip: !mac }, async t => {
    const f = fixture(t);
    f.policy.permissions!.outsideProject = "off";
    f.policy.permissions!.shell = false;
    // CI may install Node outside the OS runtime roots. Outside Off must keep
    // denying that path; exercise the admitted helper directly instead.
    const child = spawn("/bin/sleep", ["30"]); await once(child, "spawn");
    try {
        let output = "";
        const result = await f.run({ kind: "argv", execPath: "ps", execArgs: ["-p", String(child.pid), "-o", "lstart=", "-o", "comm="] }, f.root, { onData: chunk => { output += chunk; } });
        assert.equal(result.exitCode, 0, output);
        assert.match(output.trim(), /\/bin\/sleep$/);
    } finally { const exited = once(child, "exit"); child.kill(); await exited; }
});

test("helper refuses unsupported argv, invalid, other-user and exited PIDs without identity output", { skip: !mac }, async t => {
    const f = fixture(t);
    const directory = await processIdentityDirectory(f.plan);
    const child = spawn("/bin/sleep", ["30"]); await once(child, "spawn");
    const exited = once(child, "exit"); child.kill(); await exited;
    for (const argv of [["aux"], ["-p", "0", "-o", "lstart=", "-o", "comm="],
        ["-p", "1", "-o", "lstart=", "-o", "comm="], ["-p", String(child.pid), "-o", "lstart=", "-o", "comm="],
        ["-p", String(process.pid), "-o", "args="], ["-p", "1;touch /tmp/never", "-o", "lstart=", "-o", "comm="]]) {
        const result = childProcess.spawnSync(join(directory!, "ps"), argv, { encoding: "utf8" });
        assert.equal(result.status, 1); assert.equal(result.stdout, ""); assert.match(result.stderr, /Sandbox process identity/);
    }
});

test("concurrent commands share the protected helper and refuse later replacement", { skip: !mac }, async t => {
    const f = fixture(t);
    const [first, second] = await Promise.all([processIdentityDirectory(f.plan), processIdentityDirectory(f.plan)]);
    assert.equal(first, second);
    writeFileSync(join(first!, "ps"), "replaced by test host");
    await assert.rejects(processIdentityDirectory(f.plan), /helper changed/);
});

test("no compiler refuses identity explicitly while unrelated commands still work", { skip: !mac }, async t => {
    const f = fixture(t);
    const original = childProcess.spawn;
    t.mock.method(childProcess, "spawn", ((file: string, args: string[], options: any) =>
        file === "/usr/bin/clang" ? original("/usr/bin/false", [], options) : original(file, args, options)) as any);
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    let output = "";
    const good = await f.run({ kind: "argv", execPath: "/usr/bin/true", execArgs: [] }, f.root, { onData: chunk => { output += chunk; } });
    assert.equal(good.exitCode, 0, output);
    const bad = await f.run({ kind: "argv", execPath: "ps", execArgs: ["-p", String(process.pid), "-o", "lstart=", "-o", "comm="] }, f.root, { onData: chunk => { output += chunk; } });
    assert.equal(bad.exitCode, 126); assert.match(output, /check Xcode Command Line Tools/);
});

test("writable control storage is never used for a trusted helper", { skip: !mac }, async t => {
    const f = fixture(t); f.policy.denyWrite = [];
    for (const access of ["read", "read-write"] as const) {
        f.policy.permissions!.outsideProject = access;
        await assert.rejects(processIdentityDirectory(f.plan), /task-write-protected/);
    }
});


test("Commands Off never builds a helper or launches a task", { skip: !mac }, async t => {
    const f = fixture(t); f.policy.permissions!.commands = false;
    t.mock.method(childProcess, "spawn", (() => { throw new Error("unexpected spawn"); }) as any);
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    await assert.rejects(f.run({ kind: "argv", execPath: "/usr/bin/true", execArgs: [] }, f.root, { onData() {} }), /commands & applications is Off/);
});

test("a Main permission change during preparation prevents launching the old grant", { skip: !mac }, async t => {
    const f = fixture(t);
    let current = f.plan;
    const original = childProcess.spawn;
    t.mock.method(childProcess, "spawn", ((file: string, args: string[], options: any) => {
        if (file === "/usr/bin/clang") current = { ...f.plan, policy: { ...f.policy, permissions: { ...f.policy.permissions!, processAccess: "off" } } };
        return original(file, args, options);
    }) as any);
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    const run = createTaskExecutor({ requireLaunchPlan: () => current });
    await assert.rejects(run({ kind: "argv", execPath: "/usr/bin/true", execArgs: [] }, f.root, { onData() {} }), /permissions changed/);
});
