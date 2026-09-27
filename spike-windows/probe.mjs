// Runs INSIDE the restricted token. Prints one JSON object: { name: "ok" | "ERR:<code>" | detail }.
import fs from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const H = process.env.SPIKE_HOME;
const NOGRANT = process.env.SPIKE_NOGRANT;
const out = {};
const p = (...parts) => join(H, ...parts);

function t(name, fn) {
    try { const v = fn(); out[name] = v === undefined ? "ok" : v; }
    catch (e) { out[name] = `ERR:${e.code ?? e.status ?? e.message?.slice(0, 80)}`; }
}
function sh(file, args, opts = {}) {
    return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, ...opts }).trim();
}

const S = p("projects", "sibling");
// Ordinary folder under home: Write = write in place, no removal.
t("sibling.read", () => void fs.readFileSync(join(S, "data.txt")));
t("sibling.writeInPlace", () => fs.writeFileSync(join(S, "data.txt"), "overwritten"));
t("sibling.append", () => fs.appendFileSync(join(S, "data.txt"), "+"));
t("sibling.createNew", () => fs.writeFileSync(join(S, "new.txt"), "new"));
t("sibling.mkdirNew", () => fs.mkdirSync(join(S, "newdir")));
t("sibling.unlink", () => fs.unlinkSync(join(S, "data2.txt")));
t("sibling.unlinkOwnNewFile", () => fs.unlinkSync(join(S, "new.txt")));
t("sibling.rmdirEmpty", () => fs.rmdirSync(join(S, "emptydir")));
t("sibling.renameAway", () => fs.renameSync(join(S, "data3.txt"), join(S, "moved.txt")));
t("sibling.renameOverExisting", () => { fs.writeFileSync(join(S, "tmp.txt"), "x"); fs.renameSync(join(S, "tmp.txt"), join(S, "data4.txt")); });
t("sibling.moveDirToDotCache", () => fs.renameSync(S, p(".cache", "stolen")));
t("sibling.rmRf", () => fs.rmSync(S, { recursive: true, force: true }));
t("sibling.cmdDelS", () => sh("cmd.exe", ["/d", "/c", `rmdir /s /q "${S}" & if exist "${join(S, "data4.txt")}" (exit 1)`]));
t("sibling.intactAfter", () => ["data.txt", "data2.txt", "data3.txt", "data4.txt"].every((f) => fs.existsSync(join(S, f))) ? "all-present" : "MISSING");
t("sibling.hardlinkToBashrc", () => fs.linkSync(p(".bashrc"), join(S, "hl")));
t("sibling.icaclsGrantOnWritable", () => sh("icacls", [join(S, "data.txt"), "/grant", "*S-1-1-0:(F)"]));
t("sibling.icaclsGrantOnOwnFile", () => { fs.writeFileSync(join(S, "mine.txt"), "m"); return sh("icacls", [join(S, "mine.txt"), "/grant", "*S-1-1-0:(F)"]); });

// Removable (dot entry of home).
t("dotcache.unlink", () => fs.unlinkSync(p(".cache", "x.txt")));
t("dotcache.rmRfSub", () => fs.rmSync(p(".cache", "sub"), { recursive: true }));
t("dotcache.createDelete", () => { fs.writeFileSync(p(".cache", "y.txt"), "y"); fs.unlinkSync(p(".cache", "y.txt")); });
t("dotcache.renameOverExisting", () => { fs.writeFileSync(p(".cache", "a.txt"), "a"); fs.writeFileSync(p(".cache", "b.txt"), "b"); fs.renameSync(p(".cache", "a.txt"), p(".cache", "b.txt")); });

// Credentials: deny all.
t("ssh.read", () => void fs.readFileSync(p(".ssh", "id")));
t("ssh.list", () => fs.readdirSync(p(".ssh")).join(","));
t("ssh.write", () => fs.writeFileSync(p(".ssh", "id"), "pwned"));
t("ssh.unlink", () => fs.unlinkSync(p(".ssh", "id")));
t("ssh.renameDir", () => fs.renameSync(p(".ssh"), p(".ssh2")));
t("config.gh.read", () => void fs.readFileSync(p(".config", "gh", "hosts.yml")));
t("config.gh.unlink", () => fs.unlinkSync(p(".config", "gh", "hosts.yml")));
t("config.gh.renameDir", () => fs.renameSync(p(".config", "gh"), p(".config", "gh2")));
t("config.renameAnchor", () => fs.renameSync(p(".config"), p(".config-moved")));
t("config.otherUnlink", () => fs.unlinkSync(p(".config", "other.txt")));
t("junctionToSsh.read", () => { sh("cmd.exe", ["/d", "/c", "mklink", "/J", join(S, "j"), p(".ssh")]); return void fs.readFileSync(join(S, "j", "id")); });

// Code that runs later: readable, not writable/removable.
t("bashrc.read", () => void fs.readFileSync(p(".bashrc")));
t("bashrc.write", () => fs.writeFileSync(p(".bashrc"), "evil"));
t("bashrc.unlink", () => fs.unlinkSync(p(".bashrc")));
t("bashrc.renameOver", () => { fs.writeFileSync(p(".cache", "evil"), "e"); fs.renameSync(p(".cache", "evil"), p(".bashrc")); });

// Workspace with Write & delete.
const W = p("projects", "ws");
t("ws.unlink", () => fs.unlinkSync(join(W, "a.txt")));
t("ws.rename", () => fs.renameSync(join(W, "b.txt"), join(W, "b2.txt")));
t("ws.gitInitCommit", () => {
    const g = (...a) => sh("git", ["-c", "user.name=s", "-c", "user.email=s@s", ...a], { cwd: W });
    g("init", "-q"); fs.writeFileSync(join(W, "c.txt"), "c"); g("add", "."); g("commit", "-qm", "x");
    return g("log", "--oneline").split("\n").length + " commit(s)";
});
t("ws.gitWorktreeAdd", () => sh("git", ["worktree", "add", "-q", join(W, ".worktrees", "wt")], { cwd: W }) || "ok");

// No grant at all (outside every rule).
t("nogrant.read", () => void fs.readFileSync(join(NOGRANT, "x.txt")));
// Temp.
t("temp.createDelete", () => { const f = join(process.env.TEMP, "spike.tmp"); fs.writeFileSync(f, "t"); fs.unlinkSync(f); });

// Token facts.
t("whoami.priv", () => sh("whoami", ["/priv", "/fo", "csv", "/nh"]).split(/\r?\n/).map((l) => l.split(",")[0].replace(/"/g, "")).join(" "));
t("whoami.integrity", () => (sh("whoami", ["/groups", "/fo", "csv", "/nh"]).match(/Mandatory Label\\([^"]+)"/) ?? [])[1] ?? "?");

// Registry (HKCU).
t("reg.queryHKCUSoftware", () => void sh("reg", ["query", "HKCU\\Software", "/ve"]));
t("reg.addHKCUSoftware", () => sh("reg", ["add", "HKCU\\Software\\PiSpike", "/v", "x", "/d", "1", "/f"]));
t("reg.addRun", () => sh("reg", ["add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "PiSpike", "/d", "calc.exe", "/f"]));
t("reg.addRunOnce", () => sh("reg", ["add", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce", "/v", "PiSpike", "/d", "calc.exe", "/f"]));
t("reg.addEnvironment", () => sh("reg", ["add", "HKCU\\Environment", "/v", "PISPIKE", "/d", "1", "/f"]));
t("reg.addClassesClsid", () => sh("reg", ["add", "HKCU\\Software\\Classes\\CLSID\\{00000000-1111-2222-3333-444444444444}", "/ve", "/d", "x", "/f"]));
t("reg.addGrantedSubkey", () => sh("reg", ["add", "HKCU\\Software\\PiSpikeGranted", "/v", "x", "/d", "1", "/f"]));

// Toolchain smoke.
t("tool.cmd", () => sh("cmd.exe", ["/d", "/c", "echo hi"]));
t("tool.node", () => process.version);
t("tool.npm", () => sh("cmd.exe", ["/d", "/c", "npm --version"]));
t("tool.git", () => sh("git", ["--version"]));
t("tool.pwsh", () => sh("pwsh", ["-NoProfile", "-Command", "1+1"]));
t("tool.powershell", () => sh("powershell", ["-NoProfile", "-Command", "1+1"]));
t("tool.python", () => sh("python", ["-c", "import tempfile,os;f=tempfile.mktemp();open(f,'w').write('x');os.remove(f);print('py ok')"]));
t("tool.dotnet", () => sh("dotnet", ["--version"]));
t("net.fetch", () => sh(process.execPath, ["-e", "fetch('https://example.com').then(r=>console.log(r.status)).catch(e=>{console.log('ERR',e.cause?.code??e.message);process.exit(1)})"]));

process.stdout.write(JSON.stringify(out));
