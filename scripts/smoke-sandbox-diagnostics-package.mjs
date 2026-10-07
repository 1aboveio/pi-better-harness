import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { selectPackedResult } from "./stage-harness-dependencies.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "sandbox-diagnostics-pack-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const names = ["pi-better-sandbox", "pi-better-subagents", "pi-better-background-tasks", "pi-better-harness"];
try {
  const tarballs = names.map(name => {
    const output = execFileSync(npm, ["pack", "--json", "--pack-destination", dir, "-w", `packages/${name}`], {
      cwd: root, encoding: "utf8", shell: process.platform === "win32", stdio: ["ignore", "pipe", "inherit"],
    });
    const packed = selectPackedResult(output);
    assert.ok(packed?.filename, `${name} must produce a tarball`);
    const prefix = name === "pi-better-background-tasks" ? "src/" : "";
    if (name !== "pi-better-harness") assert.ok(packed.files.some(file => file.path === `${prefix}shared-sandbox-diagnostics.ts`));
    else for (const consumer of names.slice(0, 3)) {
      const prefix = consumer === "pi-better-background-tasks" ? "src/" : "";
      assert.ok(packed.files.some(file => file.path === `node_modules/${consumer}/${prefix}shared-sandbox-diagnostics.ts`));
    }
    return join(dir, packed.filename);
  });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "sandbox-diagnostics-install-smoke", private: true,
    dependencies: { "@earendil-works/pi-coding-agent": process.env.PI_SANDBOX_DIAGNOSTICS_SDK_VERSION ?? "1.0.4" } }));
  execFileSync(npm, ["install", "--prefix", dir, "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org/", ...tarballs], {
    cwd: dir, shell: process.platform === "win32", stdio: "inherit",
  });
  const modules = names.slice(0, 3).map(name => pathToFileURL(join(dir, "node_modules", name,
    name === "pi-better-background-tasks" ? "src/shared-sandbox-diagnostics.ts" : "shared-sandbox-diagnostics.ts")).href);
  const fixture = join(dir, "installed-diagnostics.mjs");
  writeFileSync(fixture, `import assert from 'node:assert/strict';
    const seams={agentDir:()=>${JSON.stringify(join(dir, "agent"))}};
    const contexts=['foreground','worker','background'];
    const modules=${JSON.stringify(modules)};
    for(let i=0;i<modules.length;i++) {
      const m=await import(modules[i]); m.setDiagnosticsEnabled(true,seams);
      const c=new m.SandboxDiagnostics({...seams,context:contexts[i],version:'1.0.0',policy:()=>({commands:false}),backend:()=>undefined,onError:e=>{process.stderr.write(String(e));process.exitCode=1;}});
      c.observe({tool:'bash',operation:{command:'PRIVATE-INSTALL-CANARY',cwd:'PRIVATE-PATH'},resource:'command-execution',basis:'policy-refusal',outcome:'denied'});
      assert.equal(m.readDiagnostics(seams).records.length,i+1);
      assert.doesNotMatch(JSON.stringify(m.readDiagnostics(seams)),/PRIVATE-INSTALL-CANARY|PRIVATE-PATH/);
    }
    const worker=await import(modules[1]); const reports=[];
    const relay=new worker.SandboxDiagnostics({...seams,context:'worker',version:'1.0.0',policy:()=>({commands:false}),backend:()=>undefined,relay:r=>reports.push(r)});
    const input={tool:'bash',operation:{command:'PRIVATE-RELAY-CANARY'},resource:'command-execution',basis:'policy-refusal'};
    relay.observe({...input,outcome:'denied'});relay.observe({...input,outcome:'succeeded'});
    assert.equal(reports.length,2);assert.equal(worker.readDiagnostics(seams).records.length,3);
    const parent=new worker.SandboxDiagnostics({...seams,context:'worker',version:'1.0.0',policy:()=>({}),backend:()=>undefined});
    for(const report of [...reports,...reports])parent.observeReport(report,'installed-worker');
    assert.equal(worker.readDiagnostics(seams).records.length,5);
    assert.ok(worker.readDiagnostics(seams).records.slice(3).every(r=>r.basis==='agent-reported'));
    assert.doesNotMatch(JSON.stringify(reports),/PRIVATE-RELAY-CANARY/);
    console.log('Installed diagnostics consumers load and share only redacted records.');`);
  execFileSync(process.execPath, ["--import", "tsx", fixture], { cwd: root, stdio: "inherit" });
  execFileSync(process.execPath, ["--test", "scripts/sandbox-diagnostics.tui.e2e.test.mjs"], {
    cwd: root, env: { ...process.env, PI_SANDBOX_DIAGNOSTICS_PACKAGE_DIR: join(dir, "node_modules/pi-better-sandbox"),
      PI_SANDBOX_DIAGNOSTICS_CLI: join(dir, "node_modules/.bin/pi") }, stdio: "inherit",
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}