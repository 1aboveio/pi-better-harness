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

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Resolves a registered skill's name to its SKILL.md path, or undefined when it is not registered. */
export type SkillPathResolver = (name: string) => string | undefined;

function skillMetadata(path: string): Record<string, unknown> | null {
  const source = readFileSync(path, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match) return null;
  const frontmatter: unknown = parse(match[1]!);
  if (!frontmatter || typeof frontmatter !== "object") return null;
  const metadata = (frontmatter as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== "object") return null;
  return metadata as Record<string, unknown>;
}

/**
 * Reads a skill's workflow declaration. A coordinator declares `workflow-role: coordinator`.
 * An alias declares `workflow-alias-of: <skill>` and resolves, through the registered skill
 * commands, to that coordinator: the recorded owner is the target (its name and path), so
 * invoking the alias is indistinguishable from invoking the coordinator. Aliases do not chain.
 */
export function workflowOwnerFromSkill(name: string, path: string, resolveSkillPath?: SkillPathResolver): WorkflowOwner | null {
  const fields = skillMetadata(path);
  if (!fields) return null;
  const role = fields["workflow-role"];
  const legacyRole = fields["pi-better-plan-workflow"];
  const aliasOf = fields["workflow-alias-of"];
  if (aliasOf !== undefined) {
    if (typeof aliasOf !== "string" || !SKILL_NAME.test(aliasOf) || aliasOf === name ||
        role !== undefined || legacyRole !== undefined) {
      throw new Error(`Invalid workflow metadata in ${path}. Expected workflow-alias-of: <coordinator skill name> without workflow-role.`);
    }
    const targetPath = resolveSkillPath?.(aliasOf);
    if (!targetPath) throw new Error(`Workflow alias ${name} targets ${aliasOf}, which is not a registered skill.`);
    const target = workflowOwnerFromSkill(aliasOf, targetPath, () => {
      throw new Error(`Workflow alias ${name} targets ${aliasOf}, which is itself an alias; aliases do not chain.`);
    });
    if (!target) throw new Error(`Workflow alias ${name} targets ${aliasOf}, which is not a workflow coordinator.`);
    return target;
  }
  if (role === undefined && legacyRole === undefined) {
    if (fields["pi-better-workflow-role"] !== undefined || fields["pi-better-plan-owner"] !== undefined) {
      throw new Error(`Outdated workflow metadata in ${path}. Use workflow-role: coordinator.`);
    }
    return null;
  }
  if ((role !== undefined && role !== "coordinator") ||
      (legacyRole !== undefined && legacyRole !== "coordinator")) {
    throw new Error(`Invalid workflow metadata in ${path}. Expected workflow-role: coordinator.`);
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