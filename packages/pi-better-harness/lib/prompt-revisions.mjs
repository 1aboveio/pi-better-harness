import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const sources = fileURLToPath(new URL("../extensions/harness-instructions/", import.meta.url));
const digest = value => createHash("sha256").update(value).digest("hex");
export const begin = "<!-- pi-better-harness:instructions:begin -->";
export const end = "<!-- pi-better-harness:instructions:end -->";

export function render({ template, modules }) {
  const used = new Set();
  const lines = template.trim().split(/\r?\n/).map(line => {
    if (!line.includes("{{") && !line.includes("}}")) return line;
    const id = /^\{\{([a-z][a-z0-9-]*)\}\}$/.exec(line)?.[1];
    if (!id || !Object.hasOwn(modules, id) || used.has(id)) throw Error(`Invalid AGENTS.md template entry: ${line}`);
    used.add(id);
    const text = modules[id].trim().replace(/\r\n/g, "\n");
    if (!text || text.includes(begin) || text.includes(end)) throw Error(`Empty text or reserved marker in modules/${id}.md`);
    return text;
  });
  if (!used.size || used.size !== Object.keys(modules).length || template.includes(begin) || template.includes(end))
    throw Error("Invalid AGENTS.md template or unused modules");
  return lines.join("\n");
}

function revision(parent, template, modules) {
  const rendered = render({ template, modules });
  return { id: digest(JSON.stringify([parent, template, modules])), parent, template, modules, digest: digest(rendered), rendered };
}

export function bundledRevision(directory = sources) {
  const template = readFileSync(join(directory, "AGENTS.md"), "utf8");
  const modules = Object.fromEntries([...template.matchAll(/^\{\{([a-z][a-z0-9-]*)\}\}\r?$/gm)].map(([, id]) =>
    [id, readFileSync(join(directory, "modules", id + ".md"), "utf8").trim()]));
  return revision(null, template, modules);
}

function read(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (e) { if (e.code === "ENOENT" && fallback !== undefined) return fallback; throw e; }
}

function write(dir, name, value) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, randomUUID());
  try {
    writeFileSync(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    renameSync(temp, join(dir, name));
  } finally { rmSync(temp, { force: true }); }
}

const store = dir => join(dir, "harness-prompt-revisions");
export const history = dir => read(join(store(dir), "history.json"), []);
export const activeRevision = dir => {
  const selected = history(dir).at(-1);
  const id = selected?.to ?? read(join(store(dir), "initial-bundle.json"), null);
  return id ? readRevision(dir, id) : bundledRevision();
};

function checkId(id) {
  if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) throw Error("Expected a revision or evaluation ID from the prompt catalog");
}
export function readRevision(dir, id) {
  checkId(id);
  const record = read(join(store(dir), id + ".json"), null);
  if (record) {
    let verified;
    if (record.composition) {
      const {bundle} = record.composition;
      const checked = revision(null, bundle.template, bundle.modules);
      if (checked.id !== bundle.id) throw Error("Corrupt bundled snapshot");
      verified = compose(record.parent, checked, orderedModules(record, checked));
    } else {
      verified = revision(record.parent, record.template, record.modules);
      let root = verified;
      const seen = new Set();
      while (root.parent) {
        checkId(root.parent);
        if (seen.has(root.parent)) throw Error("Cyclic legacy prompt history");
        seen.add(root.parent);
        const parent = read(join(store(dir), root.parent + ".json"), null);
        if (!parent || parent.id !== root.parent) break;
        root = parent;
      }
      if (!root.parent && root.id === packageProof.bundle && revision(null, root.template, root.modules).id === root.id)
        Object.defineProperty(verified, "legacyBundle", { value:revision(null, root.template, root.modules) });
    }
    if (verified.id !== id || verified.digest !== record.digest || verified.rendered !== record.rendered)
      throw Error(`Corrupt prompt revision ${id}`);
    return verified;
  }
  const bundled = bundledRevision();
  if (bundled.id === id) return bundled;
  throw Error("Unknown prompt revision. Use prompt_list.");
}

const qualified = /^[a-z][a-z0-9-]*$/;
const packageProof = {
  bundle: "fccd08066c6b092b8250e0ea46f0820452614d069e96283745696bcbd2c94900",
  scope: "Default composition: captured writing-request fidelity and reload in the fixed-provider fixture",
  url: "https://github.com/1aboveio/pi-better-harness/blob/087b03d2/packages/pi-better-harness/test/harness-instructions.test.mjs",
};

function packageRows(bundle) {
  return [...bundle.template.matchAll(/^\{\{([a-z][a-z0-9-]*)\}\}\r?$/gm)].map(([, name]) =>
    ({ id: "bundled:" + name, origin: "bundled", text: bundle.modules[name], enabled: true }));
}

function compose(parent, bundle, rows) {
  const expected = packageRows(bundle);
  if (!Array.isArray(rows) || rows.length < expected.length) throw Error("Bundled modules must stay in package order.");
  const modules = Object.create(null);
  const enabled = [], users = [];
  for (const [index, row] of rows.entries()) {
    if (index < expected.length) {
      const shipped = expected[index];
      if (row.id !== shipped.id || row.origin !== shipped.origin || row.text !== shipped.text || typeof row.enabled !== "boolean")
        throw Error("Bundled text, order and origin are read-only. Toggle the module or create a user module.");
      if (row.enabled) { enabled.push(row.id); modules[row.id] = row.text; }
    } else {
      if (row.origin !== "user" || !row.id.startsWith("user:") || !qualified.test(row.id.slice(5)) || Object.hasOwn(modules, row.id))
        throw Error("Use unique user module identities (user:name).");
      const text = row.text?.trim();
      if (!text || text.includes(begin) || text.includes(end)) throw Error("Empty user module or reserved markers.");
      users.push({ id:row.id, origin:"user", text }); modules[row.id] = text;
    }
  }
  const template = bundle.template.trim().split(/\r?\n/).flatMap(line => {
    const slot = /^\{\{([a-z][a-z0-9-]*)\}\}$/.exec(line);
    return slot ? (enabled.includes("bundled:" + slot[1]) ? ["{{bundled:" + slot[1] + "}}"] : []) : [line];
  }).concat(users.map(row => "{{" + row.id + "}}")).join("\n").trim();
  const rendered = template.split("\n").map(line => modules[/^\{\{((?:bundled|user):[a-z][a-z0-9-]*)\}\}$/.exec(line)?.[1]] ?? line).join("\n");
  const composition = { bundle, enabled, users };
  return { id:digest(JSON.stringify([parent, bundle.id, enabled, users])), parent, template, modules, rendered, digest:digest(rendered), composition };
}

export function orderedModules(record, current = record.legacyBundle ?? bundledRevision()) {
  if (record.composition) {
    const {bundle, enabled, users} = record.composition;
    return [...packageRows(bundle).map(row => ({ ...row, enabled:enabled.includes(row.id) })), ...users.map(row => ({...row}))];
  }
  // Legacy revisions have no ownership metadata. Attribute only exact known package text.
  const bundled = packageRows(current).map(row => ({ ...row, enabled: record.modules[row.id.slice(8)] === row.text }));
  const users = [...record.template.matchAll(/^\{\{([a-z][a-z0-9-]*)\}\}\r?$/gm)].flatMap(([, name]) =>
    current.modules[name] === record.modules[name] ? [] : [{ id:"user:" + name, origin:"user", text:record.modules[name] }]);
  return [...bundled, ...users];
}

export function attribution(record, shipped = record.legacyBundle ?? bundledRevision()) {
  const bundle = record.composition?.bundle ?? shipped;
  const rows = orderedModules(record, shipped);
  return { revision:record.id, renderedDigest:record.digest, bundle:bundle.id,
    packageEvidence:bundle.id === packageProof.bundle ? packageProof : null,
    bundled:rows.filter(r => r.origin === "bundled").map(r => ({id:r.id, version:digest(r.text), enabled:r.enabled})),
    users:rows.filter(r => r.origin === "user").map(r => ({id:r.id, version:digest(r.text)})) };
}

function persist(dir, record) { write(store(dir), record.id + ".json", record); }

export function editModules(dir, base, rows, preview = false) {
  const source = readRevision(dir, base);
  const shipped = bundledRevision();
  const bundle = source.composition?.bundle ?? source.legacyBundle ?? shipped;
  let next = compose(base, bundle, rows);
  if (bundle.id !== shipped.id) next = compose(base, shipped, upgradedRows(rows, shipped));
  if (preview) return next.rendered;
  if (source.composition && source.composition.bundle.id === shipped.id &&
      JSON.stringify(orderedModules(next)) === JSON.stringify(orderedModules(source))) throw Error("Edit leaves the module unchanged");
  persist(dir, source); persist(dir, next);
  return next.id;
}

export function createCandidate(dir, active, base, module, text) {
  const source = readRevision(dir, base);
  let ancestor = source;
  while (ancestor.id !== active && ancestor.parent) ancestor = readRevision(dir, ancestor.parent);
  if (ancestor.id !== active) throw Error("Stale base. Read the active revision before editing.");
  const rows = orderedModules(source);
  const row = rows.find(r => r.id === module || r.id === "bundled:" + module);
  if (row?.origin === "bundled") throw Error("Bundled text is read-only. Create a user:name module.");
  if (!module.startsWith("user:") || !qualified.test(module.slice(5))) throw Error("Unknown module. Use user:name for local content.");
  const before = row?.text;
  if (row) row.text = text;
  else rows.push({ id:module, origin:"user", text });
  return { id:editModules(dir, base, rows), parent:base, module, before, after:text.trim() };
}

function upgradedRows(rows, bundle) {
  const toggles = new Map(rows.map(r => [r.id, r.enabled]));
  return [...packageRows(bundle).map(r => ({ ...r, enabled:toggles.get(r.id) ?? true })), ...rows.filter(r => r.origin === "user")];
}

// Caller owns the APPEND_SYSTEM lock. Retain immutable pre-upgrade and rollback targets.
export function upgradeComposition(dir, bundle = bundledRevision()) {
  const log = history(dir);
  const last = log.at(-1);
  if (!last) {
    const initial = read(join(store(dir), "initial-bundle.json"), null);
    if (initial === bundle.id) return;
    persist(dir, bundle);
    if (!initial) write(store(dir), "initial-bundle.json", bundle.id);
    else write(store(dir), "history.json", [{ action:"upgrade", from:initial, to:bundle.id, packageAtActivation:bundle.id }]);
    return;
  }
  const source = readRevision(dir, last.to);
  if ((last.packageAtActivation ?? source.composition?.bundle.id) === bundle.id) return;
  let root = source;
  while (root.parent && !root.composition) root = readRevision(dir, root.parent);
  const oldBundle = source.composition?.bundle ?? (root.id === packageProof.bundle ? root : bundle);
  if (!source.composition && oldBundle.id === bundle.id) return;
  const rows = orderedModules(source, oldBundle);
  const next = compose(source.id, bundle, upgradedRows(rows, bundle));
  persist(dir, next);
  write(store(dir), "history.json", [...log, { action:"upgrade", from:source.id, to:next.id, packageAtActivation:bundle.id }]);
}

export function catalog(dir) {
  let files;
  try { files = readdirSync(store(dir)); } catch (e) { if (e.code !== "ENOENT") throw e; files = []; }
  const records = files.filter(f => /^[a-f0-9]{64}\.json$/.test(f)).map(f => readRevision(dir, f.slice(0, -5)));
  const active = activeRevision(dir);
  if (!records.some(r => r.id === active.id)) records.unshift(active);
  const evidence = files.filter(f => /^evaluation-[a-f0-9]{64}\.json$/.test(f)).map(f => {
    const id = f.slice(11, -5);
    return { ...evaluation(dir, id), evidenceId: id };
  });
  return { active: active.id, records, history: history(dir), evidence };
}

export function recordEvaluation(dir, result) {
  if (!result.compositions) result = { ...result, compositions: {
    baseline: attribution(readRevision(dir, result.active)), candidate: attribution(readRevision(dir, result.candidate)) } };
  const id = digest(JSON.stringify(result));
  write(store(dir), "evaluation-" + id + ".json", result);
  return id;
}
export function evaluation(dir, id) {
  checkId(id);
  const record = read(join(store(dir), "evaluation-" + id + ".json"), null);
  if (!record || digest(JSON.stringify(record)) !== id) throw Error("Missing or invalid evaluation. Use prompt_compare.");
  return record;
}

// Called under the APPEND_SYSTEM.md lock. The durable selection precedes sync,
// so retrying the same transition can finish an interrupted installation.
export function selectRevision(dir, transition) {
  const log = history(dir);
  const last = log.at(-1);
  if (last && Object.keys(transition).every(key => last[key] === transition[key])) return;
  if (activeRevision(dir).id !== transition.from) throw Error("Active revision changed. Refresh prompt_list.");
  const { from, to, evidence, action } = transition;
  const target = readRevision(dir, to);
  const shipped = bundledRevision();
  if (action !== "rollback" && target.composition?.bundle.id !== shipped.id)
    throw Error("Review and save the candidate against the installed package before publication.");
  if (action === "promote") {
    const result = evaluation(dir, evidence);
    if (result.active !== from || result.candidate !== to || !result.judgment?.trim() || result.requiresTurnReplay ||
        result.results?.some(row => row.status !== "scored" || row.samples.some(s => [s.baseline, s.candidate].some(a => a.status === "inconclusive"))))
      throw Error("Promotion requires a completed comparison for these revisions");
  } else if (action === "manual") {
    let candidate = readRevision(dir, to);
    if (candidate.id === from) throw Error("Revision already active");
    while (candidate.parent && candidate.parent !== from) candidate = readRevision(dir, candidate.parent);
    if (candidate.parent !== from) throw Error("Stale candidate. The active base has changed; the candidate is preserved.");
  } else if (action !== "rollback" || !log.some(item => item.from === to)) throw Error("Choose a previously active revision");
  write(store(dir), "history.json", [...log, { ...transition, packageAtActivation:shipped.id }]);
}
