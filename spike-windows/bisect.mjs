import koffi from "koffi";
import { execFileSync } from "node:child_process";
const k = koffi.load("kernel32.dll"), a = koffi.load("advapi32.dll");
const GetCurrentProcess = k.func("void * __stdcall GetCurrentProcess()");
const GetLastError = k.func("uint32 __stdcall GetLastError()");
const OpenProcessToken = a.func("bool __stdcall OpenProcessToken(void *, uint32, _Out_ void **)");
const ConvertStringSidToSidW = a.func("bool __stdcall ConvertStringSidToSidW(str16, _Out_ void **)");
const IsValidSid = a.func("bool __stdcall IsValidSid(void *)");
const CRT = a.func("bool __stdcall CreateRestrictedToken(void *, uint32, uint32, void *, uint32, void *, uint32, void *, _Out_ void **)");
const tok = [null];
console.log("open", OpenProcessToken(GetCurrentProcess(), 0xf01ff, tok), GetLastError());
const logon = execFileSync("whoami", ["/logonid"], { encoding: "utf8" }).trim();
console.log("logon", JSON.stringify(logon));
function sid(t) { const o = [null]; const ok = ConvertStringSidToSidW(t, o); return { ok, p: o[0] }; }
function arr(list) {
  const buf = Buffer.alloc(16 * list.length);
  list.forEach((t, i) => { const s = sid(t); const addr = koffi.address(s.p); if (i === 0) console.log("  addr", typeof addr, addr, "valid", IsValidSid(s.p)); buf.writeBigUInt64LE(BigInt(addr), i * 16); });
  return list.length ? buf : null;
}
const cap = "S-1-15-3-1024-1-2-3-4-5-6-7-8";
const cases = {
  none: [0, [], []], dmp: [1, [], []], lua: [4, [], []], dmpLua: [5, [], []], wr: [8, [], [ "S-1-1-0" ]],
  rEveryone: [0, [], ["S-1-1-0"]], rCap: [0, [], [cap]], rLogon: [0, [], [logon]], rUsers: [0, [], ["S-1-5-32-545"]], rRestricted: [0, [], ["S-1-5-12"]],
  dAdmins: [0, ["S-1-5-32-544"], []], all: [5, ["S-1-5-32-544"], [cap, "S-1-1-0", "S-1-5-32-545", "S-1-5-12", logon]],
  allNoLua: [1, ["S-1-5-32-544"], [cap, "S-1-1-0", "S-1-5-32-545", "S-1-5-12", logon]],
};
for (const [name, [flags, dis, res]] of Object.entries(cases)) {
  const out = [null];
  const ok = CRT(tok[0], flags, dis.length, arr(dis), 0, null, res.length, arr(res), out);
  console.log(name, ok, ok ? "" : GetLastError());
}
