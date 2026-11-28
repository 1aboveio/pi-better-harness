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
  return selected ? readRevision(dir, selected.to) : bundledRevision();
};

function checkId(id) {
  if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) throw Error("Expected a revision or evaluation ID from the prompt catalog");
}
export function readRevision(dir, id) {
  checkId(id);
  const record = read(join(store(dir), id + ".json"), null);
  if (record) {
    const verified = revision(record.parent, record.template, record.modules);
    if (verified.id !== id || verified.digest !== record.digest || verified.rendered !== record.rendered)
      throw Error(`Corrupt prompt revision ${id}`);
    return verified;
  }
  const bundled = bundledRevision();
  if (bundled.id === id) return bundled;
  throw Error("Unknown prompt revision. Use prompt_list.");
}

export function createCandidate(dir, active, base, module, text) {
  const source = readRevision(dir, base);
  let ancestor = source;
  while (ancestor.id !== active && ancestor.parent) ancestor = readRevision(dir, ancestor.parent);
  if (ancestor.id !== active) throw Error("Stale base. Read the active revision before editing.");
  if (!Object.hasOwn(source.modules, module)) throw Error("Unknown module. Use prompt_list.");
  const next = saveRevision(dir, source, source.template, { ...source.modules, [module]: text.trim() });
  return { id: next.id, parent: base, module, before: source.modules[module], after: next.modules[module] };
}

function saveRevision(dir, source, template, modules) {
  const next = revision(source.id, template, modules);
  if (source.template === template && JSON.stringify(source.modules) === JSON.stringify(modules)) throw Error("Edit leaves the module unchanged");
  for (const item of [source, next]) write(store(dir), item.id + ".json", item);
  return next;
}

export function orderedModules(record) {
  return [...record.template.matchAll(/^\{\{([a-z][a-z0-9-]*)\}\}\r?$/gm)].map(([, id]) => ({ id, text: record.modules[id] }));
}

export function editModules(dir, base, rows, preview = false) {
  const source = readRevision(dir, base);
  if (!Array.isArray(rows) || !rows.length || rows.some(r => typeof r?.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(r.id) || typeof r.text !== "string") ||
      new Set(rows.map(r => r.id)).size !== rows.length) throw Error("Use distinct lowercase module names and nonempty Markdown.");
  const modules = Object.fromEntries(rows.map(r => [r.id, r.text.trim()]));
  const slots = /^\{\{[a-z][a-z0-9-]*\}\}\r?$/;
  const lines = source.template.split("\n");
  let i = 0;
  const last = lines.findLastIndex(line => slots.test(line));
  const template = lines.flatMap((line, index) => {
    if (!slots.test(line)) return [line];
    const replacements = rows.slice(i, index === last ? rows.length : i + 1);
    i += replacements.length;
    return replacements.map(row => "{{" + row.id + "}}");
  }).join("\n");
  return preview ? render({ template, modules }) : saveRevision(dir, source, template, modules).id;
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
  readRevision(dir, to);
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
  write(store(dir), "history.json", [...log, transition]);
}
