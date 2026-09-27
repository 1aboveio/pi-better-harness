// Runs inside the sandbox: which pipe operation does a restricted token refuse?
import koffi from "koffi";
const k = koffi.load("kernel32.dll");
const GetLastError = k.func("uint32 __stdcall GetLastError()");
const CreatePipe = k.func("bool __stdcall CreatePipe(_Out_ void **, _Out_ void **, void *, uint32)");
const CreateNamedPipeW = k.func("void * __stdcall CreateNamedPipeW(str16, uint32, uint32, uint32, uint32, uint32, uint32, void *)");
const CreateFileW = k.func("void * __stdcall CreateFileW(str16, uint32, uint32, void *, uint32, uint32, void *)");
const INVALID = (h) => h === null || koffi.address(h) === 0xffffffffffffffffn;
export function pipeProbe() {
const out = {};
const r = [null], w = [null];
out.anonymousPipe = CreatePipe(r, w, null, 0) ? "ok" : `ERR ${GetLastError()}`;
const DUPLEX = 3, OVERLAPPED = 0x40000000, FIRST = 0x80000, WRITE_DAC = 0x40000, GR = 0x80000000, GW = 0x40000000;
for (const [name, serverAccess, clientAccess] of [
  ["plain", DUPLEX | OVERLAPPED | FIRST, GR | GW],
  ["writeDac", DUPLEX | OVERLAPPED | FIRST | WRITE_DAC, GR | GW | WRITE_DAC],
]) {
  const pipe = `\\\\.\\pipe\\spike-${process.pid}-${name}`;
  const server = CreateNamedPipeW(pipe, serverAccess, 0, 1, 65536, 65536, 0, null);
  if (INVALID(server)) { out[`${name}.server`] = `ERR ${GetLastError()}`; continue; }
  out[`${name}.server`] = "ok";
  const client = CreateFileW(pipe, clientAccess, 0, null, 3 /* OPEN_EXISTING */, 0, null);
  out[`${name}.client`] = INVALID(client) ? `ERR ${GetLastError()}` : "ok";
}
return out;
}
if (process.argv[1]?.endsWith("pipes.mjs")) console.log(JSON.stringify(pipeProbe()));
