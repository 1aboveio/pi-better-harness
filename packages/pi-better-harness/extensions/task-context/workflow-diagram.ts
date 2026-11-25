import { visibleWidth } from "@earendil-works/pi-tui";
import { statusStyle, type DisplayStatus, type PlanPresentation } from "./plan-presentation.js";

export type IssueStages = Record<"implement" | "review" | "fix" | "ship", DisplayStatus>;
type Line = NonNullable<PlanPresentation["metadata"]>[number];

const wire = (text: string) => ({ color: "dim", text });
const cells = (line: Line) => line.reduce((width, part) => width + visibleWidth(part.text), 0);

function stageNode(name: keyof IssueStages, units: IssueStages[], openFindings = 0): Line {
  const counts = new Map<DisplayStatus, number>();
  for (const unit of units) counts.set(unit[name], (counts.get(unit[name]) ?? 0) + 1);
  const eligible = units.length - (counts.get("skipped") ?? 0);
  const done = counts.get("completed") ?? 0;
  const node: Line = [{ text: name[0]!.toUpperCase() + name.slice(1), color: "text" }];
  const detail = (text: string, color: string) => {
    node.push(wire(node.length === 1 ? " " : " · "), { text, color });
  };
  if (name === "implement" || name === "ship") {
    detail(`${done}/${eligible}`, eligible > 0 && done === eligible ? "success" : "muted");
  }
  for (const [state, label] of [
    ["failed", "failed"], ["blocked", "blocked"], ["unknown", "unknown"], ["in_progress", "active"],
  ] as const) {
    const count = counts.get(state);
    if (count) detail(`${count} ${label}`, statusStyle(state).color);
  }
  if (name === "fix") {
    const pending = counts.get("pending");
    if (pending) detail(`${pending} pending`, "muted");
    if (node.length === 1) detail(done ? `${done} fixed` : "as needed", done ? "success" : "dim");
  }
  if (name === "review") {
    if (openFindings) detail(`${openFindings} open finding${openFindings === 1 ? "" : "s"}`, "muted");
    if (node.length === 1) detail(done ? `${done}/${eligible} passed` : "pending", done && done === eligible ? "success" : "muted");
  }
  return node;
}

/** The main path leads directly from review to ship. Fix branches below it and returns to review. */
export function workflowDiagram(units: IssueStages[], openFindings: number, width: number): Line[] {
  const implement = stageNode("implement", units);
  const review = stageNode("review", units, openFindings);
  const fix = stageNode("fix", units);
  const ship = stageNode("ship", units);
  const reviewWidth = cells(review);
  const fixWidth = cells(fix);
  const branch = Math.max(reviewWidth + 3, fixWidth + 6);

  const lead = [...implement, wire(" ──→ ")];
  const top = [...lead, ...review, wire(" " + "─".repeat(branch - reviewWidth - 1) + "┬──→ "), ...ship];
  if (cells(top) <= width) {
    const indent = " ".repeat(cells(lead));
    return [
      top,
      [wire(indent + "↑" + " ".repeat(branch - 1) + "│")],
      [wire(indent + "└─ "), ...fix, wire(" ←" + "─".repeat(branch - fixWidth - 5) + "┘")],
    ];
  }

  const turn = Math.max(reviewWidth + 3, fixWidth + 8);
  if (turn < width) {
    return [
      implement, [wire("  ↓")],
      [...review, wire(" ←" + "─".repeat(turn - reviewWidth - 2) + "┐")],
      [wire("  ├─→ "), ...fix, wire(" " + "─".repeat(turn - fixWidth - 7) + "┘")],
      [wire("  ↓")], ship,
    ];
  }
  // Keep the return destination readable when even the vertical branch cannot fit.
  return [implement, [wire("↓ "), ...review], [wire("  ↳ "), ...fix], [wire("  ↺ Review")], [wire("↓ "), ...ship]];
}
