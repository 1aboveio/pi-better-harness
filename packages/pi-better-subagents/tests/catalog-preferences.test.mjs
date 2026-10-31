import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { readCatalogPreferences, writeCatalogPreferences } from "../catalog-preferences.ts";

function fixture(t) {
    const parent = mkdtempSync(join(tmpdir(), "catalog-preferences-"));
    t.after(() => rmSync(parent, { recursive: true, force: true }));
    const root = join(parent, "agents");
    return { parent, root, path: join(root, "settings.json") };
}

test("missing preferences are immutable and stable without creating directories", t => {
    const f = fixture(t);
    const first = readCatalogPreferences(f.root);
    assert.deepEqual(first.settings, {});
    assert.equal(Object.isFrozen(first.settings), true);
    assert.equal(readCatalogPreferences(f.root).digest, first.digest);
    assert.equal(existsSync(f.root), false);
    const empty = writeCatalogPreferences(f.root, "role.developer", {});
    assert.equal(empty.digest, first.digest);
    assert.equal(empty.path, f.path);
});

test("updates replace only the selected record, preserve null clears and leave Markdown untouched", t => {
    const f = fixture(t);
    mkdirSync(f.root);
    const markdown = join(f.root, "role.developer.md");
    writeFileSync(markdown, "---\nid: role.developer\n---\nOriginal instructions.\n");
    const original = readFileSync(markdown, "utf8");
    writeCatalogPreferences(f.root, "agent.foo", { model: "openai/gpt-5.4", effort: "high" });
    const saved = writeCatalogPreferences(f.root, "role.developer", { model: "anthropic/claude-opus-4-6", effort: "max" });
    const updated = writeCatalogPreferences(f.root, "role.developer", { model: null });
    assert.deepEqual(updated.settings, { "agent.foo": { model: "openai/gpt-5.4", effort: "high" }, "role.developer": { model: null } });
    assert.notEqual(updated.digest, saved.digest);
    assert.deepEqual(readCatalogPreferences(f.root), { settings: updated.settings, digest: updated.digest });
    assert.throws(() => { updated.settings["role.developer"].model = "openai/changed"; }, TypeError);
    assert.throws(() => { updated.settings["agent.new"] = {}; }, TypeError);
    const cleared = writeCatalogPreferences(f.root, "role.developer", {});
    assert.deepEqual(cleared.settings, { "agent.foo": { model: "openai/gpt-5.4", effort: "high" } });
    assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), { version: 1, defaults: cleared.settings });
    assert.equal(readFileSync(markdown, "utf8"), original);
    assert.deepEqual(readdirSync(f.root).sort(), ["role.developer.md", "settings.json"]);
});

test("bundled-only preferences persist, read back frozen and can be removed with an empty record", t => {
    const f = fixture(t);
    const empty = readCatalogPreferences(f.root);
    const saved = writeCatalogPreferences(f.root, "role.developer", { bundled: true });
    assert.deepEqual(saved.settings, { "role.developer": { bundled: true } });
    assert.notEqual(saved.digest, empty.digest);
    assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), {
        version: 1, defaults: { "role.developer": { bundled: true } },
    });
    const loaded = readCatalogPreferences(f.root);
    assert.deepEqual(loaded, { settings: saved.settings, digest: saved.digest });
    assert.equal(Object.isFrozen(loaded.settings["role.developer"]), true);
    assert.throws(() => { saved.settings["role.developer"].bundled = false; }, TypeError);
    assert.throws(() => { loaded.settings["role.developer"].bundled = false; }, TypeError);
    const cleared = writeCatalogPreferences(f.root, "role.developer", {});
    assert.deepEqual(cleared.settings, {});
    assert.equal(cleared.digest, empty.digest);
});

test("bundled preferences allow explicit per-field overrides and null clears", t => {
    const f = fixture(t);
    for (const explicit of [
        { model: "openai/gpt-5.4" }, { effort: "high" }, { model: null }, { effort: null },
        { model: "anthropic/claude-opus-4-6", effort: "max" }, { model: null, effort: null },
    ]) {
        const expected = { bundled: true, ...explicit };
        const saved = writeCatalogPreferences(f.root, "agent.foo", expected);
        assert.deepEqual(saved.settings["agent.foo"], expected);
        assert.deepEqual(readCatalogPreferences(f.root).settings["agent.foo"], expected);
    }
});

test("digests include bundled but ignore JSON formatting and record or field order", t => {
    const f = fixture(t);
    writeCatalogPreferences(f.root, "role.z", { model: null, effort: null });
    const unmarked = writeCatalogPreferences(f.root, "agent.a", { effort: "off" });
    const saved = writeCatalogPreferences(f.root, "role.z", { model: null, bundled: true, effort: null });
    assert.notEqual(saved.digest, unmarked.digest);
    writeFileSync(f.path, '{"defaults":{"role.z":{"effort":null,"model":null,"bundled":true},"agent.a":{"effort":"off"}},"version":1}');
    assert.equal(readCatalogPreferences(f.root).digest, saved.digest);
});

test("malformed files and invalid saved values cannot be overwritten", t => {
    const f = fixture(t);
    mkdirSync(f.root);
    const invalid = ["{broken", "null", "[]", "{}", '{"version":2,"defaults":{}}', '{"version":1,"defaults":[]}',
        '{"version":1,"defaults":{},"extra":true}', ...[
            { "role.Bad": {} }, { "agent.foo": null }, { "agent.foo": [] },
            { "agent.foo": { model: "no-provider" } }, { "agent.foo": { effort: "extreme" } },
            { "agent.foo": { model: 1 } }, { "agent.foo": { effort: false } }, { "agent.foo": { tier: "fast" } },
            ...[false, "true", 1, null, [], {}].map(bundled => ({ "agent.foo": { bundled } })),
        ].map(defaults => JSON.stringify({ version: 1, defaults }))];
    for (const raw of invalid) {
        writeFileSync(f.path, raw);
        assert.throws(() => readCatalogPreferences(f.root), /Cannot read catalog preferences/);
        assert.throws(() => writeCatalogPreferences(f.root, "role.developer", { effort: "high" }), /Cannot save catalog preferences/);
        assert.equal(readFileSync(f.path, "utf8"), raw);
    }
    assert.deepEqual(readdirSync(f.root), ["settings.json"]);
});

test("invalid update inputs fail before changing disk", t => {
    const f = fixture(t);
    writeCatalogPreferences(f.root, "role.developer", { effort: "high" });
    const original = readFileSync(f.path, "utf8");
    for (const [id, value, error] of [
        ["../role.developer", {}, /Invalid catalog id/], ["role.Developer", {}, /Invalid catalog id/],
        [{ toString: () => "agent.foo" }, {}, /Invalid catalog id/],
        ["agent.foo", { model: "OpenAI/model" }, /Invalid model/], ["agent.foo", { model: "openai/a\/b" }, /Invalid model/],
        ["agent.foo", { effort: "extreme" }, /Invalid effort/], ["agent.foo", { effort: undefined }, /Invalid effort/],
        ["agent.foo", { other: true }, /Unknown preference/], ["agent.foo", null, /JSON object/],
        ...[false, "true", 1, null, undefined, [], {}].map(bundled => ["agent.foo", { bundled }, /Invalid bundled/]),
    ]) assert.throws(() => writeCatalogPreferences(f.root, id, value), error);
    assert.equal(readFileSync(f.path, "utf8"), original);
    assert.throws(() => writeCatalogPreferences(f.root, "role.developer", current => ({ ...current, bundled: false })), /Invalid bundled/);
    assert.equal(readFileSync(f.path, "utf8"), original);
    assert.deepEqual(readdirSync(f.root), ["settings.json"]);
});

test("symlink catalog roots and settings files, including dangling links, are refused", t => {
    const f = fixture(t);
    const target = join(f.parent, "target");
    mkdirSync(target);
    symlinkSync(target, f.root);
    assert.throws(() => readCatalogPreferences(f.root), /symlink catalog directory/);
    assert.throws(() => writeCatalogPreferences(f.root, "agent.foo", {}), /symlink catalog directory/);
    assert.deepEqual(readdirSync(target), []);
    rmSync(f.root);
    mkdirSync(f.root);
    const targetFile = join(target, "settings.json");
    const original = '{"version":1,"defaults":{}}';
    writeFileSync(targetFile, original);
    symlinkSync(targetFile, f.path);
    for (const dangling of [false, true]) {
        if (dangling) rmSync(targetFile);
        assert.throws(() => readCatalogPreferences(f.root), /symlink catalog settings file/);
        assert.throws(() => writeCatalogPreferences(f.root, "agent.foo", {}), /symlink catalog settings file/);
        assert.equal(lstatSync(f.path).isSymbolicLink(), true);
        if (!dangling) assert.equal(readFileSync(targetFile, "utf8"), original);
    }
});

test("non-directory roots and non-file targets fail without creating parent config directories", t => {
    const f = fixture(t);
    const nested = join(f.parent, "missing-config", "agents");
    assert.throws(() => writeCatalogPreferences(nested, "agent.foo", {}), /Cannot save.*ENOENT/);
    assert.equal(existsSync(join(f.parent, "missing-config")), false);
    writeFileSync(f.root, "not a directory");
    assert.throws(() => writeCatalogPreferences(f.root, "agent.foo", {}), /must be a directory/);
    rmSync(f.root);
    mkdirSync(f.root);
    mkdirSync(f.path);
    assert.throws(() => writeCatalogPreferences(f.root, "agent.foo", {}), /must be a regular file/);
    assert.deepEqual(readdirSync(f.root), ["settings.json"]);
});

test("atomic replacement keeps an open reader on the complete previous version", t => {
    const f = fixture(t);
    const before = writeCatalogPreferences(f.root, "agent.foo", { effort: "low" });
    const fd = openSync(f.path, "r");
    try {
        writeCatalogPreferences(f.root, "agent.foo", { effort: "high" });
        assert.deepEqual(JSON.parse(readFileSync(fd, "utf8")).defaults, before.settings);
        assert.deepEqual(readCatalogPreferences(f.root).settings, { "agent.foo": { effort: "high" } });
    } finally { closeSync(fd); }
});

test("a failed lock acquisition reports the target and preserves saved preferences", t => {
    const f = fixture(t);
    writeCatalogPreferences(f.root, "agent.foo", { effort: "low" });
    const original = readFileSync(f.path, "utf8");
    const lockfile = createRequire(import.meta.url)("proper-lockfile");
    const release = lockfile.lockSync(f.path, { realpath: false });
    try {
        assert.throws(() => writeCatalogPreferences(f.root, "agent.foo", { effort: "high" }), error => {
            assert.match(error.message, /Cannot save catalog preferences/);
            assert.ok(error.message.includes(f.path));
            assert.equal(error.cause.code, "ELOCKED");
            return true;
        });
        assert.equal(readFileSync(f.path, "utf8"), original);
    } finally { release(); }
    assert.deepEqual(readdirSync(f.root), ["settings.json"]);
});

test("field updates merge with the selected record read inside the lock", t => {
    const f = fixture(t);
    writeCatalogPreferences(f.root, "role.developer", { effort: "low" });
    const before = readCatalogPreferences(f.root);
    writeCatalogPreferences(f.root, "role.developer", { bundled: true, effort: "max" });
    const result = writeCatalogPreferences(f.root, "role.developer", current => {
        assert.deepEqual(current, { bundled: true, effort: "max" });
        assert.equal(Object.isFrozen(current), true);
        return { ...current, model: "openai/alpha" };
    });
    assert.deepEqual(result.settings["role.developer"], { bundled: true, effort: "max", model: "openai/alpha" });
    assert.deepEqual(before.settings["role.developer"], { effort: "low" });
});

test("independent processes preserve sibling updates under the shared lock", async t => {
    const f = fixture(t);
    const module = new URL("../catalog-preferences.ts", import.meta.url).href;
    const ids = ["agent.one", "agent.two", "role.developer", "role.reviewer"];
    await Promise.all(ids.map(id => new Promise((resolve, reject) => {
        const code = `import {writeCatalogPreferences} from ${JSON.stringify(module)}; for(let i=0;i<10;i++) writeCatalogPreferences(${JSON.stringify(f.root)},${JSON.stringify(id)},{bundled:true,model:'openai/alpha',effort:'high'});`;
        const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", data => { stderr += data; });
        child.on("error", reject);
        child.on("close", code => code === 0 ? resolve() : reject(new Error(stderr || `exit ${code}`)));
    })));
    assert.deepEqual(readCatalogPreferences(f.root).settings, Object.fromEntries(ids.map(id => [id, { bundled: true, model: "openai/alpha", effort: "high" }])));
    assert.deepEqual(readdirSync(f.root), ["settings.json"]);
});
