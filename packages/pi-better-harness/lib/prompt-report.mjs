export function comparisonReport(record) {
  const lines = ["Baseline " + record.active, "Candidate " + record.candidate];
  if (record.compositions) {
    for (const [arm, comp] of Object.entries(record.compositions)) {
      lines.push("", arm + " package " + comp.bundle, ...comp.bundled.map(r => r.id + " " + (r.enabled ? "On " : "Off ") + r.version),
        "Ordered user modules", ...comp.users.map(r => r.id + " " + r.version), "Upstream scope: " + (comp.packageEvidence?.scope ?? "No matching evidence."));
      if (comp.packageEvidence) lines.push(comp.packageEvidence.url);
    }
    lines.push("", "Local composition comparison");
  }
  if (record.results) {
    lines.push(record.suite ?? "Case suite", "Samples per case: " + record.sampleCount);
    for (const row of record.results) {
      lines.push("", row.id + " / " + row.status, "Model: " + (row.config?.model ?? record.model ?? "unavailable"),
        "Required: " + row.rubric.required.join(", "), "Forbidden: " + row.rubric.forbidden.join(", "));
      if (row.expected) lines.push("Expected: " + row.expected);
      if (row.counterexample) lines.push("Counterexample: " + row.counterexample);
      if (row.error) lines.push(row.error);
      for (const [index, sample] of row.samples.entries()) {
        lines.push("Sample " + (index + 1));
        for (const arm of ["baseline", "candidate"]) {
          const result = sample[arm];
          lines.push(arm + " / " + (result?.status ?? "incomplete"), result?.text ?? "");
        }
      }
    }
  } else if (record.baselineOutput && record.candidateOutput) {
    lines.push("Model: " + record.provider + "/" + record.model, "Samples per revision: 1",
      "", "Baseline response", record.baselineOutput.text, "", "Candidate response", record.candidateOutput.text);
    if (record.requiresTurnReplay) lines.push("Tool requested; response comparison incomplete.");
    if (record.difference) lines.push("", "Difference", ...record.difference.removed.map(s => "- " + s), ...record.difference.added.map(s => "+ " + s));
  }
  if (record.rubric) lines.push("", "Rubric", record.rubric);
  if (record.judgment) lines.push("", "Judgment", record.judgment);
  return lines.join("\n");
}
