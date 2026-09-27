import koffi from "koffi";
const kb = koffi.load("kernelbase.dll");
const derive = kb.func("bool __stdcall DeriveCapabilitySidsFromName(str16, _Out_ void **, _Out_ uint32 *, _Out_ void **, _Out_ uint32 *)");
const toStr = koffi.load("advapi32.dll").func("bool __stdcall ConvertSidToStringSidW(void *, _Out_ str16 *)");
const g = [null], gc = [0], s = [null], sc = [0];
console.error("calling derive");
if (!derive("pi-better-harness.spike.home-read", g, gc, s, sc)) { console.log("derive returned false"); process.exit(0); }
console.error("derived", gc[0], sc[0]);
const first = koffi.decode(s[0], "void *");
const out = [null];
toStr(first, out);
console.log(`count=${sc[0]} sid=${out[0]}`);
