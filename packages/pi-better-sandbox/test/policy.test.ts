import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test, { after } from "node:test";

import {
    describeUnsafeProjectRoot,
    PACKAGED_DENY_WRITE_TEMPLATES,
    resolveDenyWriteTemplate,
    resolveDenyWriteTemplates,
    unsafeProjectRoots,
} from "../policy.ts";

// Canonical from the start: every expectation below is a canonical path, which
// is what the policy resolver produces.
const fixtures = realpathSync(mkdtempSync(join(tmpdir(), "pi-better-sandbox-policy-")));
after(() => rmSync(fixtures, { recursive: true, force: true }));

function project(name: string): string {
    const root = join(fixtures, name);
    mkdirSync(root, { recursive: true });
    return root;
}

test("the packaged deny defaults are the three paths the design fixes in source", () => {
    assert.deepEqual([...PACKAGED_DENY_WRITE_TEMPLATES], [".git/hooks", ".env", ".env.local"]);
    assert.throws(() => {
        (PACKAGED_DENY_WRITE_TEMPLATES as string[]).push("extra");
    });
});

test("packaged defaults resolve under the project root of whichever project is open", () => {
    const first = project("first");
    const second = project("second");

    assert.deepEqual(resolveDenyWriteTemplates(PACKAGED_DENY_WRITE_TEMPLATES, first), [
        join(first, ".env"),
        join(first, ".env.local"),
        join(first, ".git/hooks"),
    ]);
    assert.deepEqual(resolveDenyWriteTemplates(PACKAGED_DENY_WRITE_TEMPLATES, second), [
        join(second, ".env"),
        join(second, ".env.local"),
        join(second, ".git/hooks"),
    ]);
});

test("a ~ entry resolves against the home directory, not the project", () => {
    const root = project("tilde");
    const home = project("fake-home");
    assert.equal(
        resolveDenyWriteTemplate("~/secrets", root, { home: () => home }),
        join(home, "secrets"),
    );
    assert.equal(resolveDenyWriteTemplate("~", root, { home: () => home }), home);
});

test("an absolute entry is taken as written", () => {
    const root = project("absolute");
    const target = join(fixtures, "elsewhere", "keys");
    mkdirSync(join(fixtures, "elsewhere"), { recursive: true });
    assert.equal(resolveDenyWriteTemplate(target, root), target);
});

test("a symlinked deny entry resolves to the file it really points at", () => {
    const root = project("symlinked-deny");
    const real = join(root, "real.env");
    writeFileSync(real, "SECRET=1\n");
    symlinkSync(real, join(root, "alias.env"));

    assert.equal(resolveDenyWriteTemplate("alias.env", root), real);
});

test("a deny entry that does not exist yet still resolves through its real parent", () => {
    const root = project("missing-deny");
    const realDir = join(root, "real-config");
    mkdirSync(realDir);
    symlinkSync(realDir, join(root, "config"));

    assert.equal(resolveDenyWriteTemplate("config/.env", root), join(realDir, ".env"));
});

test("an empty deny entry is rejected rather than silently denying the project root", () => {
    const root = project("empty-deny");
    assert.throws(() => resolveDenyWriteTemplate("   ", root), /may not be empty/);
});

test("duplicate deny entries that resolve to the same path collapse to one", () => {
    const root = project("dupes");
    writeFileSync(join(root, ".env"), "");
    assert.deepEqual(resolveDenyWriteTemplates([".env", "./.env", join(root, ".env")], root), [
        join(root, ".env"),
    ]);
});

test("the filesystem root and the home directory are unsafe writable roots", () => {
    const home = project("home-as-root");
    const roots = unsafeProjectRoots({ home: () => home });

    assert.ok(roots.includes(sep));
    assert.ok(roots.includes(home));
    assert.match(describeUnsafeProjectRoot(home, { home: () => home }) ?? "", /will not treat/);
    assert.match(describeUnsafeProjectRoot(sep, { home: () => home }) ?? "", /Relaunch pi/);
});

test("an ordinary project directory is a safe writable root", () => {
    const home = project("home-safe");
    const root = project("ordinary");
    assert.equal(describeUnsafeProjectRoot(root, { home: () => home }), undefined);
});

test("a subdirectory of the home directory is a safe writable root", () => {
    const home = project("home-parent");
    const root = join(home, "work");
    mkdirSync(root, { recursive: true });
    assert.equal(describeUnsafeProjectRoot(root, { home: () => home }), undefined);
});
