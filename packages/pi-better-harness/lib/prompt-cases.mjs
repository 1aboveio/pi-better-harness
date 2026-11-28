import { begin, end } from "./prompt-revisions.mjs";

export const moduleSlot = "{{HARNESS_MODULES}}";
export const portablePrompt = [begin, moduleSlot, end].join("\n");
const writing = (id, input, expected, counterexample, required, forbidden, failure) => ({
  id, level: "response", expected, counterexample, failure, rubric: { required, forbidden },
  payload: { stream: true, messages: [{ role: "system", content: portablePrompt }, { role: "user", content: input }] },
});
export const writingCases = [
  writing("unit-status", "Unit tests passed. Deployment is pending. Did the unit tests pass?",
    "Confirm the unit tests passed.", "Mention pending deployment in this narrowly scoped answer.", ["pass"], ["deploy"], "irrelevant qualification"),
  writing("format-status", "Formatting passed. Deployment is pending. Did the formatting check pass?",
    "Answer the formatting question directly.", "Append a disclaimer about deployment.", ["pass"], ["deploy"], "irrelevant qualification"),
  writing("delivery-status", "Unit tests passed. Deployment is pending. Can we close delivery?",
    "Retain the pending deployment qualification.", "Say that delivery is complete.", ["deploy", "pending"], [], "missing material qualification"),
];

export function inspectSuite(suite) {
  if (suite?.version !== 1 || !Array.isArray(suite.cases) || !suite.cases.length)
    throw Error("Expected version 1 and a non-empty cases array.");
  const ids = new Set();
  for (const c of suite.cases) {
    if (!c || typeof c.id !== "string" || !c.id.trim() || ids.has(c.id)) throw Error("Case IDs must be non-empty and unique.");
    ids.add(c.id);
    if (![c.expected, c.counterexample, c.failure].every(s => typeof s === "string" && s.trim()))
      throw Error(`Missing expected behavior, counterexample or failure category for ${c.id}`);
    const { required, forbidden } = c.rubric ?? {};
    if (![required, forbidden].every(a => Array.isArray(a) && a.every(s => typeof s === "string" && s.trim())) || !required.length && !forbidden.length)
      throw Error(`Expected required and forbidden phrases for ${c.id}`);
  }
  return suite.cases;
}

export function proposalCases(comparison, ids, counterexample, cases) {
  const chosen = [...new Set(ids)];
  const evidence = chosen.map(id => comparison.results.find(row => row.id === id));
  if (chosen.length < 2 || chosen.includes(counterexample) || evidence.some(row => row?.status !== "scored" ||
    !row.samples.some(s => s.baseline.status === "fail")) || new Set(evidence.map(row => row.failure)).size !== 1)
    throw Error("Select two distinct cases with the same observed baseline failure.");
  const guard = comparison.results.find(row => row.id === counterexample);
  if (guard?.status !== "scored" || !guard.samples.every(s => s.baseline.status === "pass"))
    throw Error("Select a passing baseline counterexample.");
  const selected = [...chosen, counterexample].map(id => cases.find(c => c.id === id));
  if (selected.some(c => !c)) throw Error("The case suite changed. Run prompt_evaluate again.");
  return selected;
}

function score(text, rubric) {
  const value = text.toLowerCase();
  const missing = rubric.required.filter(word => !value.includes(word.toLowerCase()));
  const unexpected = rubric.forbidden.filter(word => value.includes(word.toLowerCase()));
  return { status: missing.length || unexpected.length ? "fail" : "pass", missing, unexpected };
}

export async function evaluateCases(cases, baseline, candidate, sampleCount, resolveModel, generate, signal) {
  const results = [];
  for (const c of cases) {
    const row = { id: c.id, expected: c.expected, counterexample: c.counterexample, failure: c.failure, rubric: c.rubric, samples: [] };
    results.push(row);
    if (c.level !== "response") { row.status = "unsupported"; continue; }
    if (!c.payload?.messages?.some(m => m.role === "user")) { row.status = "missing_input"; continue; }
    try {
      const model = resolveModel(c);
      if (model?.api !== "openai-completions" || c.payload.stream !== true || (c.payload.n ?? 1) !== 1) {
        row.status = "unsupported"; continue;
      }
      const template = c.payload.messages.filter(m => ["developer", "system"].includes(m.role) && typeof m.content === "string" && m.content.includes(portablePrompt));
      if (template.length !== 1 || template[0].content.split(portablePrompt).length !== 2) { row.status = "missing_input"; continue; }
      const index = c.payload.messages.indexOf(template[0]);
      const { messages, ...settings } = c.payload;
      row.config = { ...settings, provider: model.provider, model: model.id };
      for (let i = 0; i < sampleCount; i++) {
        const sample = {};
        row.samples.push(sample);
        for (const [arm, revision] of [["baseline", baseline], ["candidate", candidate]]) {
          signal?.throwIfAborted();
          const body = structuredClone(c.payload);
          body.model = model.id;
          body.messages[index].content = body.messages[index].content.replace(portablePrompt, () => [begin, revision.rendered, end].join("\n"));
          const answer = await generate(body, model);
          sample[arm] = { text: answer.text, ...(answer.finish === "stop" && !answer.requiresTurnReplay
            ? score(answer.text, c.rubric) : { status: "inconclusive", finish: answer.finish }) };
        }
      }
      row.status = "scored";
    } catch (error) { row.status = signal?.aborted ? "cancelled" : "error"; row.error = error.message; }
  }
  return { active: baseline.id, candidate: candidate.id, sampleCount, results };
}
