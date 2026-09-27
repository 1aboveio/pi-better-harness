// Add/revoke one ACE via SetEntriesInAclW + SetNamedSecurityInfoW (propagates inheritable ACEs).
import koffi from "koffi";
const a = koffi.load("advapi32.dll");
const TRUSTEE_W = koffi.struct("TRUSTEE_W_acl", {
    pMultipleTrustee: "void *", MultipleTrusteeOperation: "int", TrusteeForm: "int", TrusteeType: "int", ptstrName: "void *",
});
const EXPLICIT_ACCESS_W = koffi.struct("EXPLICIT_ACCESS_W_acl", {
    grfAccessPermissions: "uint32", grfAccessMode: "int", grfInheritance: "uint32", Trustee: TRUSTEE_W,
});
const ConvertStringSidToSidW = a.func("bool __stdcall ConvertStringSidToSidW(str16, _Out_ void **)");
const GetNamedSecurityInfoW = a.func("uint32 __stdcall GetNamedSecurityInfoW(str16, int, uint32, _Out_ void **, _Out_ void **, _Out_ void **, _Out_ void **, _Out_ void **)");
const SetEntriesInAclW = a.func("uint32 __stdcall SetEntriesInAclW(uint32, EXPLICIT_ACCESS_W_acl *, void *, _Out_ void **)");
const SetNamedSecurityInfoW = a.func("uint32 __stdcall SetNamedSecurityInfoW(str16, int, uint32, void *, void *, void *, void *)");

export const MODE = { grant: 1, set: 2, deny: 3, revoke: 4 };
export const INHERIT = { none: 0, tree: 3 };
export const MASK = {
    rx: 0x1200a9, w: 0x120116, d: 0x10000, all: 0x1f01ff,
    denyWrite: 0x2 | 0x4 | 0x10 | 0x100 | 0x40 | 0x10000 | 0x40000 | 0x80000,
    regWrite: 0x1 | 0x2 | 0x4 | 0x8,
};
export function setAce(path, sidText, mask, mode, inherit, objectType = 1 /* SE_FILE_OBJECT; 4 = registry */) {
    const sid = [null];
    if (!ConvertStringSidToSidW(sidText, sid)) throw new Error(`bad sid ${sidText}`);
    const o = [null], g = [null], dacl = [null], s = [null], sd = [null];
    let status = GetNamedSecurityInfoW(path, objectType, 4, o, g, dacl, s, sd);
    if (status) throw new Error(`GetNamedSecurityInfoW ${path}: ${status}`);
    const entry = {
        grfAccessPermissions: mask, grfAccessMode: mode, grfInheritance: inherit,
        Trustee: { pMultipleTrustee: null, MultipleTrusteeOperation: 0, TrusteeForm: 0, TrusteeType: 0, ptstrName: sid[0] },
    };
    const next = [null];
    status = SetEntriesInAclW(1, entry, dacl[0], next);
    if (status) throw new Error(`SetEntriesInAclW ${path}: ${status}`);
    status = SetNamedSecurityInfoW(path, objectType, 4, null, null, next[0], null);
    if (status) throw new Error(`SetNamedSecurityInfoW ${path}: ${status}`);
}
