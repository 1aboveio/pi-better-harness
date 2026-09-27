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
const CreateJobObjectW = kernel32.func("void * __stdcall CreateJobObjectW(void *, void *)");
const SetInformationJobObject = kernel32.func("bool __stdcall SetInformationJobObject(void *, int, void *, uint32)");
const AssignProcessToJobObject = kernel32.func("bool __stdcall AssignProcessToJobObject(void *, void *)");
const ResumeThread = kernel32.func("uint32 __stdcall ResumeThread(void *)");
const WaitForSingleObject = kernel32.func("uint32 __stdcall WaitForSingleObject(void *, uint32)");
const GetExitCodeProcess = kernel32.func("bool __stdcall GetExitCodeProcess(void *, _Out_ uint32 *)");
const OpenProcessToken = advapi32.func("bool __stdcall OpenProcessToken(void *, uint32, _Out_ void **)");
const ConvertStringSidToSidW = advapi32.func("bool __stdcall ConvertStringSidToSidW(str16, _Out_ void **)");
const CreateRestrictedToken = advapi32.func(
    "bool __stdcall CreateRestrictedToken(void *, uint32, uint32, SID_AND_ATTRIBUTES *, uint32, void *, uint32, SID_AND_ATTRIBUTES *, _Out_ void **)");
const SetEntriesInAclW = advapi32.func("uint32 __stdcall SetEntriesInAclW(uint32, EXPLICIT_ACCESS_W *, void *, _Out_ void **)");
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
const disable = config.disableSids.map((s) => ({ Sid: sid(s), Attributes: 0 }));
const restrict = config.restrictingSids.map((s) => ({ Sid: sid(s), Attributes: 0 }));
const restricted = [null];
if (!CreateRestrictedToken(token[0], flags, disable.length, disable.length ? disable : null, 0, null,
    restrict.length, restrict, restricted)) fail("CreateRestrictedToken");

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
ResumeThread(pi.hThread);
WaitForSingleObject(pi.hProcess, 0xffffffff);
const code = [0];
GetExitCodeProcess(pi.hProcess, code);
CloseHandle(pi.hThread);
CloseHandle(pi.hProcess);
process.exit(code[0]);
