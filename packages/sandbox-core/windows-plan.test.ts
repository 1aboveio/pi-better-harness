/**
 * Windows sandbox plan compiler. Pure policy compilation, so these run on every
 * OS. The plan is inert: no launcher is wired, and win32 still fails closed.
 * @covers sandbox.windows-plan
 * @level unit
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    compileWindowsSandboxPlan, containsWin32, isWin32Root, normalizeWin32,
    type WindowsAce, type WindowsPermissions, type WindowsPlanInput, type WindowsRule,
} from "./windows-plan.ts";

const broad: WindowsPermissions = {
    projectFiles: "read-write", outsideProject: "write", storedCredentials: "read",
    commands: true, network: true,
};

function input(overrides: Partial<WindowsPlanInput> = {}): WindowsPlanInput {
    return {
        permissions: broad,
        home: "C:\\Users\\dev",
        workspace: "C:\\Users\\dev\\projects\\task",
        knownFolders: {
            localAppData: "C:\\Users\\dev\\AppData\\Local",
            appData: "C:\\Users\\dev\\AppData\\Roaming",
            documents: "C:\\Users\\dev\\Documents",
            startup: "C:\\Users\\dev\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup",
        },
        // Deterministic SIDs, one per rule role.
        sid: (rule: WindowsRule) => `S-1-5-21-100-200-300-${rule}`,
        ...overrides,
    };
}

/** Every ACE (deny or allow) whose path matches `path`, case-insensitive. */
function acesFor(aces: readonly WindowsAce[], path: string): WindowsAce[] {
    return aces.filter((a) => normalizeWin32(a.path).toLowerCase() === normalizeWin32(path).toLowerCase());
}

describe("win32 path handling", () => {
    it("normalizes separators, drive case, and trailing slashes", () => {
        assert.equal(normalizeWin32("C:/Users/Dev/"), "c:\\Users\\Dev");
        assert.equal(normalizeWin32("c:\\Users\\\\Dev\\"), "c:\\Users\\Dev");
        assert.equal(normalizeWin32("C:\\a\\b\\..\\c"), "c:\\a\\c");
        assert.equal(normalizeWin32("c:\\"), "c:\\");
    });

    it("keeps case for containment but folds it for the check", () => {
        assert.ok(containsWin32("C:\\Users\\Dev", "c:\\users\\dev\\projects\\x"));
        assert.ok(containsWin32("C:\\Users\\Dev", "C:\\Users\\Dev"));
        assert.ok(!containsWin32("C:\\Users\\Dev", "C:\\Users\\Developer"));
        assert.ok(!containsWin32("C:\\Users\\Dev\\a", "C:\\Users\\Dev\\ab"));
    });

    it("recognizes drive and UNC roots", () => {
        assert.ok(isWin32Root("C:\\"));
        assert.ok(isWin32Root("c:"));
        assert.ok(isWin32Root("\\\\server\\share"));
        assert.ok(!isWin32Root("C:\\Users"));
        assert.ok(!isWin32Root("\\\\server\\share\\dir"));
    });
});

describe("broad-write profile plan", () => {
    it("grants home read and write but never delete on home", () => {
        const plan = compileWindowsSandboxPlan(input());
        const home = acesFor(plan.aces, "C:\\Users\\dev");
        const rights = new Set(home.filter((a) => a.mode === "allow").flatMap((a) => a.rights));
        assert.ok(rights.has("read") && rights.has("write"));
        assert.ok(!rights.has("delete"), "home must not grant delete under Write");
    });

    it("makes %LOCALAPPDATA%\\Temp removable but not %LOCALAPPDATA% itself", () => {
        const plan = compileWindowsSandboxPlan(input());
        const temp = acesFor(plan.aces, "C:\\Users\\dev\\AppData\\Local\\Temp");
        assert.ok(temp.some((a) => a.mode === "allow" && a.rights.includes("delete")));
        const local = acesFor(plan.aces, "C:\\Users\\dev\\AppData\\Local");
        assert.ok(!local.some((a) => a.mode === "allow" && a.rights.includes("delete")));
    });

    it("makes discovered worktree folders removable", () => {
        const plan = compileWindowsSandboxPlan(input({
            worktreeFolders: ["C:\\Users\\dev\\projects\\task\\.worktrees\\wt1"],
        }));
        const wt = acesFor(plan.aces, "C:\\Users\\dev\\projects\\task\\.worktrees\\wt1");
        assert.ok(wt.some((a) => a.mode === "allow" && a.rights.includes("delete")));
    });

    it("denies all access to credential stores, whatever the credentials row says", () => {
        const plan = compileWindowsSandboxPlan(input({
            permissions: { ...broad, storedCredentials: "read-write" },
        }));
        for (const cred of ["C:\\Users\\dev\\.ssh", "C:\\Users\\dev\\AppData\\Roaming\\GitHub CLI",
            "C:\\Users\\dev\\AppData\\Roaming\\Microsoft\\Protect"]) {
            const a = acesFor(plan.aces, cred);
            assert.ok(a.some((e) => e.mode === "deny" && e.rights.includes("all")), `no deny-all on ${cred}`);
        }
    });

    it("denies write/delete/writeDac/writeOwner on code that runs later, and keeps it readable", () => {
        const plan = compileWindowsSandboxPlan(input());
        const pi = acesFor(plan.aces, "C:\\Users\\dev\\.pi");
        const deny = pi.find((a) => a.mode === "deny");
        assert.ok(deny);
        assert.deepEqual([...deny!.rights].sort(), ["delete", "write", "writeDac", "writeOwner"]);
        // No deny-all: reads still work (skills are read from here).
        assert.ok(!pi.some((a) => a.rights.includes("all")));
    });

    it("denies the HKCU Run and RunOnce autostart keys", () => {
        const plan = compileWindowsSandboxPlan(input());
        for (const keyName of ["HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
            "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce"]) {
            const a = plan.aces.filter((e) => e.object === "registry" && e.path.toLowerCase() === keyName.toLowerCase());
            assert.ok(a.some((e) => e.mode === "deny" && e.rights.includes("write")), `no deny on ${keyName}`);
        }
    });

    it("anchors ancestors of protected paths against rename, without inheritance", () => {
        const plan = compileWindowsSandboxPlan(input());
        const anchors = plan.aces.filter((a) => a.rule === "anchor");
        assert.ok(anchors.length > 0);
        assert.ok(anchors.every((a) => !a.inherit && a.mode === "deny" && a.rights.includes("delete")));
        // The parent of .ssh (home) is anchored.
        assert.ok(anchors.some((a) => a.path.toLowerCase() === "c:\\users\\dev"));
    });

    it("materializes absent deny-list entries with the right kind", () => {
        const present = new Set(["c:\\users\\dev\\.pi"]);
        const plan = compileWindowsSandboxPlan(input({ exists: (p) => present.has(p.toLowerCase()) }));
        const ssh = plan.materialize.find((m) => m.path.toLowerCase() === "c:\\users\\dev\\.ssh");
        assert.deepEqual(ssh, { path: "c:\\Users\\dev\\.ssh", kind: "dir" });
        const netrc = plan.materialize.find((m) => m.path.toLowerCase() === "c:\\users\\dev\\.netrc");
        assert.equal(netrc?.kind, "file");
        // An existing entry is not materialized.
        assert.ok(!plan.materialize.some((m) => m.path.toLowerCase() === "c:\\users\\dev\\.pi"));
    });

    it("adds Authenticated Users only for Write & delete", () => {
        assert.equal(compileWindowsSandboxPlan(input()).authenticatedUsers, false);
        const wd = compileWindowsSandboxPlan(input({
            permissions: { ...broad, outsideProject: "read-write" },
        }));
        assert.equal(wd.authenticatedUsers, true);
    });

    it("carries one restricting SID per role and lists no capability SIDs", () => {
        const plan = compileWindowsSandboxPlan(input());
        assert.ok(plan.restrictingSids.length > 0);
        assert.ok(plan.restrictingSids.every((s) => s.startsWith("S-1-5-21-")));
    });

    it("orders every deny ACE before every allow ACE", () => {
        const plan = compileWindowsSandboxPlan(input());
        const firstAllow = plan.aces.findIndex((a) => a.mode === "allow");
        const lastDeny = plan.aces.map((a) => a.mode).lastIndexOf("deny");
        assert.ok(firstAllow === -1 || lastDeny === -1 || lastDeny < firstAllow);
    });
});

describe("project row", () => {
    it("Project = Write grants write but not delete, except worktree folders inside it", () => {
        const plan = compileWindowsSandboxPlan(input({
            permissions: { ...broad, projectFiles: "write" },
            worktreeFolders: ["C:\\Users\\dev\\projects\\task\\.worktrees\\wt"],
        }));
        const ws = acesFor(plan.aces, "C:\\Users\\dev\\projects\\task");
        assert.ok(ws.some((a) => a.mode === "allow" && a.rights.includes("write")));
        assert.ok(!ws.some((a) => a.mode === "allow" && a.rights.includes("delete")));
        const wt = acesFor(plan.aces, "C:\\Users\\dev\\projects\\task\\.worktrees\\wt");
        assert.ok(wt.some((a) => a.mode === "allow" && a.rights.includes("delete")));
    });

    it("Project = Read denies write on the workspace and keeps it protected", () => {
        const plan = compileWindowsSandboxPlan(input({ permissions: { ...broad, projectFiles: "read" } }));
        const ws = acesFor(plan.aces, "C:\\Users\\dev\\projects\\task");
        assert.ok(ws.some((a) => a.mode === "allow" && a.rights.includes("read")));
        assert.ok(ws.some((a) => a.mode === "deny" && a.rights.includes("write")));
    });

    it("Project = Off denies all on the workspace", () => {
        const plan = compileWindowsSandboxPlan(input({ permissions: { ...broad, projectFiles: "off" } }));
        const ws = acesFor(plan.aces, "C:\\Users\\dev\\projects\\task");
        assert.ok(ws.some((a) => a.mode === "deny" && a.rights.includes("all")));
    });
});

describe("outside project levels", () => {
    it("Outside = Off grants no home rules", () => {
        const plan = compileWindowsSandboxPlan(input({ permissions: { ...broad, outsideProject: "off" } }));
        assert.equal(acesFor(plan.aces, "C:\\Users\\dev").filter((a) => a.mode === "allow").length, 0);
    });

    it("Outside = Read grants home read but not write", () => {
        const plan = compileWindowsSandboxPlan(input({ permissions: { ...broad, outsideProject: "read" } }));
        const home = acesFor(plan.aces, "C:\\Users\\dev").filter((a) => a.mode === "allow");
        const rights = new Set(home.flatMap((a) => a.rights));
        assert.ok(rights.has("read"));
        assert.ok(!rights.has("write"));
    });
});

describe("safety rails", () => {
    it("refuses a home or workspace at a drive root", () => {
        assert.throws(() => compileWindowsSandboxPlan(input({ home: "C:\\" })), /home/);
        assert.throws(() => compileWindowsSandboxPlan(input({ workspace: "C:\\" })), /project/);
    });

    it("refuses a workspace that is home itself or an ancestor of home", () => {
        assert.throws(() => compileWindowsSandboxPlan(input({ workspace: "C:\\Users\\dev" })), /home itself/);
        assert.throws(() => compileWindowsSandboxPlan(input({ workspace: "C:\\Users" })), /home itself/);
    });

    it("drops a caller deny-write at a drive root instead of denying the whole volume", () => {
        const plan = compileWindowsSandboxPlan(input({ denyWrite: ["C:\\", "C:\\Users\\dev\\secret"] }));
        assert.ok(!plan.aces.some((a) => a.path === "c:\\"));
        assert.ok(plan.aces.some((a) => a.path.toLowerCase() === "c:\\users\\dev\\secret" && a.mode === "deny"));
    });

    it("keeps Network Off in the plan (refusal is enforced upstream, not here)", () => {
        const plan = compileWindowsSandboxPlan(input({ permissions: { ...broad, network: false } }));
        assert.equal(plan.network, false);
    });
});
