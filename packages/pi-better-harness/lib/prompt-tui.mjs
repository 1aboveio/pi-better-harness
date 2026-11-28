import { managerAction } from "./prompt-manager.mjs";
import { comparisonReport } from "./prompt-report.mjs";

async function choose(ui, title, items) {
  const label = await ui.select(title, items.map(i => i.label));
  return items.find(i => i.label === label);
}

export async function openPromptManager(dir, ui, session, toggleShare, isShared) {
  let candidate;
  const request = args => managerAction(dir, args, session);
  for (;;) {
    let state;
    try { state = await request({ action: "state", candidate }); }
    catch (error) { ui.notify(error.message, "error"); return; }
    try {
      candidate = state.selected;
      const pair = { base: state.active, candidate };
      const loaded = state.session.loaded === null ? "no managed block" : state.loadedRevision?.slice(0, 10) ?? "override or unknown";
      const reload = state.loadNotice ? "\n" + state.loadNotice : "";
      const share = isShared() ? "Disconnect browser" : "Connect browser";
      const action = await ui.select(`Prompt manager | ${state.source} | Active ${state.active.slice(0, 10)} | Selected ${candidate.slice(0, 10)}\nInstalled ${state.installedRevision?.slice(0, 10) ?? state.source} | Loaded ${loaded}${reload}`, [
        "Choose revision", "Modules", "Preview", "Review changes", "Publish manually", "History and rollback",
        "Replay a response", "Evaluate a case suite", "Evidence", share, "Close",
      ]);
      if (!action || action === "Close") return;
      if (action === "Choose revision") {
        candidate = (await choose(ui, "Revisions", state.records))?.id ?? candidate;
      } else if (action === "Modules") {
        const rows = structuredClone(state.modules);
        for (;;) {
          const item = await ui.select("Candidate modules", [...rows.map(r => r.id), "Add module", "Preview draft", "Save candidate"]);
          if (!item) break;
          if (item === "Save candidate") { candidate = await request({ action: "save", candidate, modules: rows }); break; }
          if (item === "Preview draft") { await ui.editor(item, await request({ action: "preview", candidate, modules: rows })); continue; }
          if (item === "Add module") {
            const id = await ui.input("Module name");
            if (!id) continue;
            const text = await ui.editor(id, "");
            if (text?.trim()) rows.push({ id, text });
            continue;
          }
          const i = rows.findIndex(r => r.id === item);
          const op = await ui.select(item, ["Edit text", "Move up", "Move down", "Remove"]);
          if (op === "Edit text") rows[i].text = await ui.editor(item, rows[i].text) ?? rows[i].text;
          if (op === "Remove") rows.splice(i, 1);
          if (op === "Move up" && i > 0) rows.splice(i - 1, 0, rows.splice(i, 1)[0]);
          if (op === "Move down" && i < rows.length - 1) rows.splice(i + 1, 0, rows.splice(i, 1)[0]);
        }
      } else if (action === "Preview") {
        await ui.editor("Rendered prompt", state.rendered);
      } else if (action === "Review changes") {
        await ui.editor("Changes", `Parent ${state.parent ?? "(bundled)"}\n${state.parentDiff}\n\nActive ${state.active}\n${state.diff}`);
      } else if (action === "Publish manually") {
        if (await ui.confirm(action, state.diff + "\nPublish " + candidate + "?")) await request({ action: "publish", ...pair, confirmed: true });
      } else if (action === "History and rollback") {
        const entry = await choose(ui, action, state.history.map((h, i) => ({ ...h, label: `${i + 1}. ${h.action} ${h.from.slice(0, 10)} → ${h.to.slice(0, 10)}` })).reverse());
        if (entry && await ui.confirm("Rollback", "Restore " + entry.from + "?"))
          candidate = await request({ action: "rollback", base: state.active, candidate: entry.from, confirmed: true });
      } else if (action === share) {
        ui.notify(await toggleShare(), "info");
      } else if (action === "Evidence") {
        const entry = await choose(ui, "Recorded comparisons", state.evidence.map((e, i) => ({ ...e,
          label: `${i + 1}. ${e.suite ?? e.model ?? "Comparison"} / ${e.judgment ?? "Awaiting judgment"}` })));
        if (!entry) continue;
        await ui.editor("Evidence", comparisonReport(entry));
        const op = await ui.select("Evidence", ["Record judgment", ...(entry.judgment ? ["Promote evaluated revision"] : [])]);
        if (op === "Record judgment") {
          const judgment = await ui.input("Judgment");
          if (judgment) await request({ action: "judge", base: entry.active, candidate, evidence: entry.evidenceId, judgment });
        } else if (op && await ui.confirm(op, state.diff)) await request({ action: "promote", ...pair, evidence: entry.evidenceId, confirmed: true });
      } else {
        let result;
        if (action === "Replay a response") {
          if (!state.session.captures.length) throw Error("No captured response. Use /prompt-capture before sending a request.");
          const selected = await choose(ui, "Captured response", state.session.captures);
          if (selected) result = await request({ action: "replay", ...pair, caseId: selected.id });
        } else {
          if (!state.session.models.length) throw Error("No supported openai-completions model.");
          const selected = await choose(ui, "Reviewed suite", state.session.suites);
          if (!selected) continue;
          const model = await ui.select("Model", state.session.models);
          if (!model) continue;
          const count = await ui.input("Samples per case (1 to 16)", "1");
          if (count !== undefined) result = await request({ action: "evaluate", ...pair, suite: selected.id, model, samples: Number(count || 1) });
        }
        if (result) await ui.editor("Comparison", comparisonReport(result));
      }
    } catch (error) { ui.notify(error.message, "error"); }
  }
}
