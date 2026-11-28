import { comparisonReport } from "./prompt-report.mjs";
const el = id => document.getElementById(id);
const token = location.hash.slice(1) || sessionStorage.getItem("prompt-token");
if (token) sessionStorage.setItem("prompt-token", token);
history.replaceState(null, "", location.pathname);
let state, rows, selected, connection = "", evidence;
function node(tag, text) {
  const value = document.createElement(tag);
  if (text !== undefined) value.textContent = text;
  return value;
}
function options(id, items, value) {
  el(id).replaceChildren(...items.map(i => new Option(i.label, i.id)));
  if (items.some(i => i.id === value)) el(id).value = value;
}
async function api(action, args = {}) {
  const response = await fetch("/api", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ action, candidate: selected, base: state?.active, session: connection, ...args }) });
  if (response.status === 403) throw Error("Unauthorized. Open the URL printed by the launcher.");
  const data = await response.json();
  if (!response.ok) throw Error(data.error);
  return data.result;
}
function handle(fn) {
  return async () => {
    el("notice").textContent = "";
    document.querySelector("main").inert = true;
    try { await fn(); } catch (e) { el("notice").textContent = e.message; }
    finally { document.querySelector("main").inert = false; }
  };
}
function drawRows() {
  el("rows").replaceChildren(...rows.map((row, i) => {
    const section = node("div"); section.className = "module";
    const bar = node("div"); bar.className = "toolbar";
    const name = node("input"); name.value = row.id; name.setAttribute("aria-label", "Module name");
    name.oninput = () => { row.id = name.value; };
    bar.append(name);
    for (const [symbol, title, offset] of [["↑","Move up",-1],["↓","Move down",1],["×","Remove",0]]) {
      const b = node("button", symbol); b.title = title; b.setAttribute("aria-label", title + " " + row.id);
      b.disabled = i + offset < 0 || i + offset >= rows.length;
      b.onclick = () => { rows.splice(i, 1); if (offset) rows.splice(i + offset, 0, row); drawRows(); };
      bar.append(b);
    }
    const body = node("textarea"); body.rows = 3; body.value = row.text; body.setAttribute("aria-label", row.id + " Markdown");
    body.oninput = () => { row.text = body.value; };
    section.append(bar, body); return section;
  }));
}
function showEvidence() {
  evidence = state.evidence.find(e => e.evidenceId === el("evidence").value);
  el("result").textContent = evidence ? comparisonReport(evidence) : "No recorded comparisons.";
  el("judgment").value = evidence?.judgment ?? "";
  el("judge").disabled = !evidence; el("promote").disabled = !evidence?.judgment;
}
async function refresh(preferredEvidence) {
  state = await api("state"); selected = state.selected; rows = structuredClone(state.modules);
  options("revisions", state.records, selected);
  options("session", [{ id: "", label: "Standalone" }, ...state.connections.map(c => ({ id: c.id, label: c.name }))], connection);
  const fields = { Source: state.source, Active: state.active, Selected: selected, Parent: state.parent ?? "Bundled",
    Installed: state.installedRevision ?? state.source, Loaded: state.session ? state.loadedRevision ?? "No matching revision" : "Session unavailable" };
  el("status").replaceChildren(...Object.entries(fields).flatMap(([k,v]) => [node("dt",k),node("dd",v)]));
  el("notice").textContent = state.problem ?? state.loadNotice;
  drawRows(); el("draft").textContent = "";
  for (const key of ["diff","parentDiff","rendered","installed"]) el(key).textContent = state[key] ?? "Off";
  el("publish").disabled = selected === state.active || state.source !== "modular";
  el("history").replaceChildren(...state.history.toReversed().map(h => {
    const b = node("button", h.action + " " + h.from.slice(0,8) + " → " + h.to.slice(0,8));
    b.title = "Roll back to " + h.from;
    b.onclick = handle(async () => { if (confirm(b.title + "?")) { selected = await api("rollback", { candidate: h.from, confirmed: true }); await refresh(); } });
    return b;
  }));
  options("captures", state.session?.captures ?? []); options("suites", state.session?.suites ?? []);
  options("models", (state.session?.models ?? []).map(id => ({ id, label:id })));
  options("evidence", state.evidence.map(e => ({ id:e.evidenceId, label:(e.suite ?? e.model ?? "Comparison") + " / " + (e.judgment ?? "Awaiting judgment") + " / " + e.evidenceId.slice(0,8) })), preferredEvidence);
  showEvidence();
}
function tab(view) {
  for (const b of document.querySelectorAll("[data-view]")) {
    el(b.dataset.view).hidden = b.dataset.view !== view; b.setAttribute("aria-current", String(b.dataset.view === view));
  }
}
for (const b of document.querySelectorAll("[data-view]")) b.onclick = () => tab(b.dataset.view);
el("revisions").onchange = handle(async () => { selected = el("revisions").value; await refresh(); });
el("session").onchange = handle(async () => { connection = el("session").value; await refresh(); });
el("refresh").onclick = handle(refresh);
el("add").onclick = () => { rows.push({ id:"",text:"" }); drawRows(); el("rows").lastChild.querySelector("input").focus(); };
el("preview").onclick = handle(async () => { el("draft").textContent = await api("preview", { modules:rows }); });
el("save").onclick = handle(async () => { selected = await api("save", { modules:rows }); await refresh(); tab("review"); });
el("publish").onclick = handle(async () => { if (confirm("Publish the reviewed changes?\n" + state.diff)) { await api("publish", { confirmed:true }); await refresh(); } });
el("evidence").onchange = showEvidence;
for (const action of ["evaluate","replay"]) el(action).onclick = handle(async () => {
  const result = await api(action, { caseId:el("captures").value, suite:el("suites").value, model:el("models").value, samples:Number(el("samples").value) });
  await refresh(result.evidenceId);
});
el("judge").onclick = handle(async () => { const id = await api("judge", { base:evidence.active, evidence:evidence.evidenceId, judgment:el("judgment").value }); await refresh(id); });
el("promote").onclick = handle(async () => { if (confirm("Promote the evaluated revision?\n" + state.diff)) { await api("promote",{ evidence:evidence.evidenceId, confirmed:true }); await refresh(); } });
tab("modules"); await handle(refresh)();
