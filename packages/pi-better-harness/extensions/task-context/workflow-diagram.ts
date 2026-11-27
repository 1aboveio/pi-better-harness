import { visibleWidth } from "@earendil-works/pi-tui";

export interface DiagramPart {
  text: string;
  color: string;
  selected?: boolean;
}

/** Use the same status marks as the task rows, with a count for each nonempty group. */
export function diagramCounts(groups: { glyph: string; color: string; count: number }[]): DiagramPart[] {
  return groups.filter(group => group.count > 0).map(({ glyph, color, count }) => ({ text: ` ${glyph}${count}`, color }));
}

export interface WorkflowNode {
  /** Parallel steps can share a node while remaining individually addressable by edges. */
  ids: string[];
  name: string;
  label: DiagramPart[];
  parents: string[];
  revision?: string;
}

const wire = (text: string): DiagramPart => ({ text, color: "dim" });
const labelWidth = (parts: DiagramPart[]) => parts.reduce((size, part) => size + visibleWidth(part.text), 0);

export function workflowDiagram(nodes: WorkflowNode[], width: number): DiagramPart[][] {
  if (!nodes.length) return [];
  const byId = new Map(nodes.flatMap(node => node.ids.map(id => [id, node] as const)));
  const fixes = new Set(nodes.map(node => node.revision));
  const main = nodes.filter(node => !fixes.has(node.ids[0]!));
  const path: WorkflowNode[] = [];
  let next = main.filter(node => !node.parents.length);
  while (next.length === 1) {
    const current = next[0]!;
    path.push(current);
    next = main.filter(node => node.parents.length === current.ids.length && node.parents.every(id => byId.get(id) === current));
  }
  if (path.length === main.length) {
    const top: DiagramPart[] = [];
    const loops: DiagramPart[][] = [];
    let x = 0;
    for (const [i, node] of path.entries()) {
      top.push(...node.label);
      const size = labelWidth(node.label);
      if (node.revision) {
        const fix = byId.get(node.revision)!.label;
        const fixSize = labelWidth(fix);
        const span = Math.max(size + 2, fixSize + 6);
        const indent = " ".repeat(x);
        top.push(wire(" " + "─".repeat(span - size - 1) + "┬"));
        loops.push([wire(indent + "↑" + " ".repeat(span - 1) + "│")],
          [wire(indent + "└─ "), ...fix, wire(" ←" + "─".repeat(span - fixSize - 5) + "┘")]);
        x += span + 1;
      } else x += size;
      if (i < path.length - 1) { top.push(wire(" ─→ ")); x += 4; }
    }
    if (x <= width) return [top, ...loops];
    // Preserve edge direction without wrapping connectors away from their nodes.
    return path.flatMap((node, i) => {
      const lines = [[wire(i ? "↓ " : ""), ...node.label]];
      if (node.revision) lines.push([wire("  ↳ "), ...byId.get(node.revision)!.label], [wire("  ↺ " + node.name)]);
      return lines;
    });
  }
  return nodes.map(node => {
    const parents = node.parents.map(id => {
      const parent = byId.get(id)!;
      return parent.ids.length > 1 ? id : parent.name;
    });
    return [wire(parents.length ? parents.join(" + ") + " → " : ""), ...node.label,
      ...(node.revision ? [wire(" ↔ "), ...byId.get(node.revision)!.label] : [])];
  });
}
