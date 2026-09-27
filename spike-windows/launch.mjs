// Throwaway spike (#344): start a command under a restricted token via koffi.
// Usage: node launch.mjs <config.json> -- <command line>
// config: { restrictingSids: string[], disableSids: string[], writeRestricted: bool,
//           defaultDacl: bool, mediumIntegrity: bool, cwd?: string }
import koffi from "koffi";
import { readFileSync } from "node:fs";

const [configPath, dashdash, ...rest] = process.argv.slice(2);
if (dashdash !== "--" || !rest.length) throw new Error("usage: launch.mjs <config> -- <cmd>");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const commandLine = rest.join(" ");

const kernel32 = koffi.load("kernel32.dll");
const advapi32 = koffi.load("advapi32.dll");

const HANDLE = koffi.pointer("HANDLE", koffi.opaque());
const SID_AND_ATTRIBUTES = koffi.struct("SID_AND_ATTRIBUTES", { Sid: "void *", Attributes: "uint32" });
const TRUSTEE_W = koffi.struct("TRUSTEE_W", {
    pMultipleTrustee: "void *", MultipleTrusteeOperation: "int", TrusteeForm: "int", TrusteeType: "int", ptstrName: "void *",
});
const EXPLICIT_ACCESS_W = koffi.struct("EXPLICIT_ACCESS_W", {
    grfAccessPermissions: "uint32", grfAccessMode: "int", grfInheritance: "uint32", Trustee: TRUSTEE_W,
});
const STARTUPINFOW = koffi.struct("STARTUPINFOW", {
    cb: "uint32", lpReserved: "void *", lpDesktop: "void *", lpTitle: "void *",
    dwX: "uint32", dwY: "uint32", dwXSize: "uint32", dwYSize: "uint32",
    dwXCountChars: "uint32", dwYCountChars: "uint32", dwFillAttribute: "uint32", dwFlags: "uint32",
    wShowWindow: "uint16", cbReserved2: "uint16", lpReserved2: "void *",
    hStdInput: "void *", hStdOutput: "void *", hStdError: "void *",
});
const PROCESS_INFORMATION = koffi.struct("PROCESS_INFORMATION", {
    hProcess: "void *", hThread: "void *", dwProcessId: "uint32", dwThreadId: "uint32",
});

const GetCurrentProcess = kernel32.func("void * __stdcall GetCurrentProcess()");
const GetLastError = kernel32.func("uint32 __stdcall GetLastError()");
const GetStdHandle = kernel32.func("void * __stdcall GetStdHandle(int32)");
const CloseHandle = kernel32.func("bool __stdcall CloseHandle(void *)");
const SetHandleInformation = kernel32.func("bool __stdcall SetHandleInformation(void *, uint32, uint32)");
const CreateJobObjectW = kernel32.func("void * __stdcall CreateJobObjectW(void *, void *)");
const SetInformationJobObject = kernel32.func("bool __stdcall SetInformationJobObject(void *, int, void *, uint32)");
const AssignProcessToJobObject = kernel32.func("bool __stdcall AssignProcessToJobObject(void *, void *)");
const ResumeThread = kernel32.func("uint32 __stdcall ResumeThread(void *)");
const WaitForSingleObject = kernel32.func("uint32 __stdcall WaitForSingleObject(void *, uint32)");
const GetExitCodeProcess = kernel32.func("bool __stdcall GetExitCodeProcess(void *, _Out_ uint32 *)");
const OpenProcessToken = advapi32.func("bool __stdcall OpenProcessToken(void *, uint32, _Out_ void **)");
const ConvertStringSidToSidW = advapi32.func("bool __stdcall ConvertStringSidToSidW(str16, _Out_ void **)");
const CreateRestrictedToken = advapi32.func(
    "bool __stdcall CreateRestrictedToken(void *, uint32, uint32, void *, uint32, void *, uint32, void *, _Out_ void **)");
const SetEntriesInAclW = advapi32.func("uint32 __stdcall SetEntriesInAclW(uint32, EXPLICIT_ACCESS_W *, void *, _Out_ void **)");
const GetSecurityInfo = advapi32.func("uint32 __stdcall GetSecurityInfo(void *, int, uint32, _Out_ void **, _Out_ void **, _Out_ void **, _Out_ void **, _Out_ void **)");
const SetSecurityInfo = advapi32.func("uint32 __stdcall SetSecurityInfo(void *, int, uint32, void *, void *, void *, void *)");
const SetTokenInformation = advapi32.func("bool __stdcall SetTokenInformation(void *, int, void *, uint32)");
const CreateProcessAsUserW = advapi32.func(
    "bool __stdcall CreateProcessAsUserW(void *, void *, void *, void *, void *, bool, uint32, void *, str16, STARTUPINFOW *, _Out_ PROCESS_INFORMATION *)");

function fail(what) {
    const code = GetLastError();
    console.error(`launch: ${what} failed (Win32 error ${code})`);
    process.exit(120);
}

function sid(text) {
    const out = [null];
    if (!ConvertStringSidToSidW(text, out)) fail(`ConvertStringSidToSidW(${text})`);
    return out[0];
}

const TOKEN_ALL = 0xf01ff;
const token = [null];
if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ALL, token)) fail("OpenProcessToken");

const DISABLE_MAX_PRIVILEGE = 0x1, LUA_TOKEN = 0x4, WRITE_RESTRICTED = 0x8;
const flags = DISABLE_MAX_PRIVILEGE | LUA_TOKEN | (config.writeRestricted ? WRITE_RESTRICTED : 0);
// SID_AND_ATTRIBUTES[] packed by hand: { PSID Sid; DWORD Attributes; } = 16 bytes on x64.
function sidArray(list) {
    if (!list.length) return null;
    const buf = Buffer.alloc(16 * list.length);
    list.forEach((text, i) => buf.writeBigUInt64LE(BigInt(koffi.address(sid(text))), i * 16));
    return buf;
}
const disable = sidArray(config.disableSids);
const restrict = sidArray(config.restrictingSids);
const restricted = [null];
if (!CreateRestrictedToken(token[0], flags, config.disableSids.length, disable, 0, null,
    config.restrictingSids.length, restrict, restricted)) fail("CreateRestrictedToken");

if (config.tokenObjectDacl) {
    // The restricted process must be able to open its own token (CreateProcess duplicates it).
    const o = [null], g = [null], dacl = [null], sc = [null], sd = [null];
    let st = GetSecurityInfo(restricted[0], 6 /* SE_KERNEL_OBJECT */, 4, o, g, dacl, sc, sd);
    if (st) { console.error(`launch: GetSecurityInfo ${st}`); process.exit(120); }
    const entries = config.tokenObjectDacl.map((s) => ({
        grfAccessPermissions: 0x10000000, grfAccessMode: 1 /* GRANT */, grfInheritance: 0,
        Trustee: { pMultipleTrustee: null, MultipleTrusteeOperation: 0, TrusteeForm: 0, TrusteeType: 0, ptstrName: sid(s) },
    }));
    const next = [null];
    st = SetEntriesInAclW(entries.length, entries, dacl[0], next);
    if (st) { console.error(`launch: SetEntriesInAclW(token) ${st}`); process.exit(120); }
    st = SetSecurityInfo(restricted[0], 6, 4, null, null, next[0], null);
    if (st) { console.error(`launch: SetSecurityInfo(token) ${st}`); process.exit(120); }
}

if (config.defaultDacl) {
    // Default DACL for objects the child creates: user, logon session, SYSTEM.
    const GENERIC_ALL = 0x10000000, SET_ACCESS = 2, TRUSTEE_IS_SID = 0;
    const entries = config.defaultDaclSids.map((s) => ({
        grfAccessPermissions: GENERIC_ALL, grfAccessMode: SET_ACCESS, grfInheritance: 0,
        Trustee: { pMultipleTrustee: null, MultipleTrusteeOperation: 0, TrusteeForm: TRUSTEE_IS_SID, TrusteeType: 0, ptstrName: sid(s) },
    }));
    const acl = [null];
    const status = SetEntriesInAclW(entries.length, entries, null, acl);
    if (status !== 0) { console.error(`launch: SetEntriesInAclW ${status}`); process.exit(120); }
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(koffi.address(acl[0])));
    if (!SetTokenInformation(restricted[0], 6 /* TokenDefaultDacl */, buf, 8)) fail("SetTokenInformation(DefaultDacl)");
}

if (config.mediumIntegrity) {
    // TOKEN_MANDATORY_LABEL { SID_AND_ATTRIBUTES Label } with SE_GROUP_INTEGRITY (0x20).
    const label = Buffer.alloc(16);
    label.writeBigUInt64LE(BigInt(koffi.address(sid("S-1-16-8192"))), 0);
    label.writeUInt32LE(0x20, 8);
    if (!SetTokenInformation(restricted[0], 25 /* TokenIntegrityLevel */, label, 16)) fail("SetTokenInformation(IntegrityLevel)");
}

const job = CreateJobObjectW(null, null);
if (!job) fail("CreateJobObjectW");
const limits = Buffer.alloc(144); // JOBOBJECT_EXTENDED_LIMIT_INFORMATION (x64)
limits.writeUInt32LE(0x2000, 16); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
if (!SetInformationJobObject(job, 9, limits, 144)) fail("SetInformationJobObject");

// Node marks its std handles non-inheritable at startup (uv_disable_stdio_inheritance).
for (const n of [-10, -11, -12]) { const h = GetStdHandle(n); if (h && !SetHandleInformation(h, 1, 1)) console.error(`launch: SetHandleInformation ${n} err ${GetLastError()}`); }
const si = {
    cb: koffi.sizeof(STARTUPINFOW), lpReserved: null, lpDesktop: null, lpTitle: null,
    dwX: 0, dwY: 0, dwXSize: 0, dwYSize: 0, dwXCountChars: 0, dwYCountChars: 0, dwFillAttribute: 0,
    dwFlags: 0x100 /* STARTF_USESTDHANDLES */, wShowWindow: 0, cbReserved2: 0, lpReserved2: null,
    hStdInput: GetStdHandle(-10), hStdOutput: GetStdHandle(-11), hStdError: GetStdHandle(-12),
};
const pi = {};
const cmd = Buffer.from(`${commandLine}\0`, "utf16le");
const CREATE_SUSPENDED = 0x4, CREATE_UNICODE_ENVIRONMENT = 0x400;
if (!CreateProcessAsUserW(restricted[0], null, cmd, null, null, true, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
    null, config.cwd ?? process.cwd(), si, pi)) fail("CreateProcessAsUserW");
if (!AssignProcessToJobObject(job, pi.hProcess)) fail("AssignProcessToJobObject");
console.error(`launch: pid ${pi.dwProcessId} hProcess ${pi.hProcess ? "set" : "null"}`);
ResumeThread(pi.hThread);
const waited = WaitForSingleObject(pi.hProcess, 0xffffffff);
const code = [0];
const gotCode = GetExitCodeProcess(pi.hProcess, code);
console.error(`launch: wait=${waited} gotCode=${gotCode} code=${code[0]} err=${GetLastError()}`);
CloseHandle(pi.hThread);
CloseHandle(pi.hProcess);
process.exit(code[0]);
