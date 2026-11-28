import { activatePrompt, currentInstructions, promptSource } from "./instructions.mjs";
import { activeRevision, begin, catalog, editModules, end, evaluation, orderedModules, readRevision, recordEvaluation } from "./prompt-revisions.mjs";

export function loadedBlock(ctx) {
  const system = ctx.getSystemPrompt().replaceAll("\r\n", "\n");
  const start = system.indexOf(begin + "\n");
  const stop = system.indexOf("\n" + end, start);
  return start >= 0 && stop > start ? system.slice(start + begin.length + 1, stop) : null;
}

function changes(from, to) {
  const before = orderedModules(from), after = orderedModules(to);
  const names = new Set([...before, ...after].map(m => m.id));
  const entries = [...names].filter(k => from.modules[k] !== to.modules[k]);
  const order = rows => rows.map(r => r.id).join(" > ");
  return [
    ...(order(before) === order(after) ? [] : ["Order", "- " + order(before), "+ " + order(after)]),
    ...entries.flatMap(k => [k, ...(from.modules[k]?.split("\n").map(line => "- " + line) ?? []),
      ...(to.modules[k]?.split("\n").map(line => "+ " + line) ?? [])]),
  ].join("\n");
}

export async function managerAction(dir, args, session) {
  const { action, base, candidate } = args;
  if (action === "state") {
    const data = catalog(dir);
    const byId = new Map(data.records.map(r => [r.id, r]));
    const installed = currentInstructions(dir) ?? null;
    const selected = byId.get(candidate ?? data.active);
    if (!selected) throw Error("Unknown candidate");
    const description = session ? await session.describe() : null;
    const identify = text => data.records.find(r => r.rendered === text)?.id ?? null;
    const summaries = data.records.map(r => {
      const parent = byId.get(r.parent);
      const names = parent ? [...new Set([...Object.keys(parent.modules), ...Object.keys(r.modules)])]
        .filter(id => parent.modules[id] !== r.modules[id]) : [];
      const label = parent ? names.join(", ") || "Module order" : "Bundled defaults";
      return { id: r.id, label: label + " / " + r.id.slice(0, 10) };
    });
    return { active: data.active, records: summaries, selected: selected.id, parent: selected.parent,
      modules: orderedModules(selected), rendered: selected.rendered, diff: changes(byId.get(data.active), selected),
      parentDiff: selected.parent ? changes(byId.get(selected.parent), selected) : "",
      source: promptSource(dir), installed, installedRevision: identify(installed), session: description,
      loadedRevision: description ? identify(description.loaded) : null,
      loadNotice: !description || installed === description.loaded ? "" : description.loaded === null && installed !== null
        ? "Global block absent from the session. Reload Pi and check project or explicit append overrides."
        : "Reload Pi to adopt the installed prompt.",
      history: data.history,
      evidence: data.evidence.filter(e => e.candidate === selected.id) };
  }
  if (action === "save" || action === "preview") return editModules(dir, candidate, args.modules, action === "preview");
  if (action === "publish" || action === "rollback" || action === "promote") {
    if (args.confirmed !== true) throw Error("Review and confirm the revision change.");
    if (activeRevision(dir).id !== base) throw Error("Active revision changed. Refresh before publishing; the candidate is preserved.");
    activatePrompt(dir, { from: base, to: candidate, action: action === "publish" ? "manual" : action,
      ...(action === "promote" ? { evidence: args.evidence } : {}) });
    return candidate;
  }
  if (action === "judge") {
    const record = evaluation(dir, args.evidence);
    if (record.active !== base || record.candidate !== candidate || !args.judgment?.trim()) throw Error("Select matching evidence and enter a judgment.");
    return recordEvaluation(dir, { ...record, judgment: args.judgment.trim(), reviewedEvidence: args.evidence });
  }
  if (action === "replay" || action === "evaluate") {
    if (!session) throw Error("No Pi session connected. Enable the connection in Prompt manager in Pi.");
    if (activeRevision(dir).id !== base) throw Error("The baseline changed. Refresh and review the pair.");
    const result = await session.run(args);
    if (result.active !== base || result.candidate !== candidate) throw Error("The selected revision pair changed.");
    return { ...result, evidenceId: recordEvaluation(dir, result) };
  }
  throw Error("Unknown prompt manager action");
}
