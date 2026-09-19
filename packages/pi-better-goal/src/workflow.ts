import { readFileSync } from "node:fs";
import { parse } from "yaml";

export const WORKFLOW_ENTRY_TYPE = "pi-better-workflow";

export interface WorkflowOwner {
  name: string;
  path: string;
  role: "coordinator";
  planOwner: "workflow";
}

interface SessionEntryLike {
  type: string;
  customType?: string;
  data?: unknown;
}

export function workflowOwnerFromSkill(name: string, path: string): WorkflowOwner | null {
  const source = readFileSync(path, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match) return null;
  const frontmatter: unknown = parse(match[1]!);
  if (!frontmatter || typeof frontmatter !== "object") return null;
  const metadata = (frontmatter as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const fields = metadata as Record<string, unknown>;
  if (fields["pi-better-workflow-role"] === undefined && fields["pi-better-plan-owner"] === undefined) return null;
  if (fields["pi-better-workflow-role"] !== "coordinator" || fields["pi-better-plan-owner"] !== "workflow") {
    throw new Error(`Invalid workflow ownership metadata in ${path}. Expected coordinator/workflow.`);
  }
  return { name, path, role: "coordinator", planOwner: "workflow" };
}

export function workflowEntry(owner: WorkflowOwner | null) {
  return owner === null
    ? { version: 1, kind: "clear" as const }
    : { version: 1, kind: "set" as const, owner };
}

export function currentWorkflowOwner(entries: Iterable<SessionEntryLike>): WorkflowOwner | null {
  let owner: WorkflowOwner | null = null;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== WORKFLOW_ENTRY_TYPE) continue;
    const data = entry.data as { version?: unknown; kind?: unknown; owner?: Partial<WorkflowOwner> } | null;
    if (data?.version !== 1) continue;
    if (data.kind === "clear") owner = null;
    else if (data.kind === "set" && typeof data.owner?.name === "string" &&
      typeof data.owner.path === "string" && data.owner.role === "coordinator" && data.owner.planOwner === "workflow") {
      owner = data.owner as WorkflowOwner;
    }
  }
  return owner;
}

export function skillCommandName(text: string): string | null {
  return /^\/skill:([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s|$)/.exec(text.trim())?.[1] ?? null;
}