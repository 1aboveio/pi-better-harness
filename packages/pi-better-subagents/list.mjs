import { fmtElapsed, fmtSpend } from "./widget.mjs";
import { formatListHealthSuffix } from "./health-surface.mjs";

export const SUBAGENT_LIST_DEFAULT_LIMIT = 20;
export const SUBAGENT_LIST_MAX_LIMIT = 100;
/** Effective + durable supervision statuses accepted by subagent_list filters. */
export const SUBAGENT_LIST_STATUSES = [
    "running",
    "completed",
    "failed",
    "killed",
    "exited",
    "orphaned",
    "lost",
];

const STATUS_SET = new Set(SUBAGENT_LIST_STATUSES);

function promptPreview(meta) {
    return String(meta.promptPreview ?? "").replace(/\s+/g, " ").slice(0, 100);
}

export function normalizeSubagentListOptions(params = {}) {
    const warnings = [];
    const rawLimit = params.limit;
    let limit = SUBAGENT_LIST_DEFAULT_LIMIT;
    if (rawLimit !== undefined && rawLimit !== null) {
        const n = Number(rawLimit);
        if (!Number.isFinite(n)) {
            throw new Error("subagent_list limit must be a finite number.");
        }
        limit = Math.floor(n);
        if (limit < 0) {
            warnings.push(`Requested limit ${rawLimit} is below 0; using 0.`);
            limit = 0;
        }
        if (limit > SUBAGENT_LIST_MAX_LIMIT) {
            warnings.push(
                `Requested limit ${rawLimit} exceeds maximum ${SUBAGENT_LIST_MAX_LIMIT}; using ${SUBAGENT_LIST_MAX_LIMIT}.`,
            );
            limit = SUBAGENT_LIST_MAX_LIMIT;
        }
    }

    const rawStatus = params.status;
    let statuses = null;
    if (rawStatus !== undefined && rawStatus !== null) {
        const values = Array.isArray(rawStatus) ? rawStatus : [rawStatus];
        const normalized = values.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
        const invalid = normalized.filter((s) => !STATUS_SET.has(s));
        if (invalid.length) {
            throw new Error(
                `Unsupported subagent_list status: ${[...new Set(invalid)].join(", ")}. ` +
                `Supported statuses: ${SUBAGENT_LIST_STATUSES.join(", ")}.`,
            );
        }
        statuses = new Set(normalized);
    }

    return {
        all: params.all === true,
        limit,
        statuses,
        warnings,
    };
}

export function formatSubagentListRow(meta, p) {
    const status = p.status;
    const now = p.now ?? Date.now();
    const usage = p.usage;
    const elapsed = fmtElapsed((meta.endedAt ?? now) - meta.startedAt);
    const spend = fmtSpend(usage);
    const name = meta.name ? `${meta.name} ` : "";
    const stat = `${elapsed}${spend ? ` · ${spend}` : ""}`;
    const health = formatListHealthSuffix(p.health);
    const batch = meta.batchId
        ? `  [batch: ${meta.batchName ? `${meta.batchName} ` : ""}${meta.batchId}]`
        : "";
    return `• ${name}${meta.id}  [${status}]  ${meta.model ?? "?"}  ${stat}${health}${batch}\n    ${promptPreview(meta)}`;
}

export function buildSubagentList(p) {
    const options = normalizeSubagentListOptions(p.params ?? {});
    const now = p.now ?? Date.now();
    const parentPid = p.parentPid ?? process.pid;
    const statusOf = p.statusOf ?? ((meta) => meta.status);
    const usageById = p.usageById ?? (() => undefined);
    const healthById = p.healthById ?? (() => undefined);

    const scoped = (p.metas ?? [])
        .filter((meta) => options.all || meta.spawnPid === parentPid)
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((meta) => ({ meta, status: statusOf(meta) }));

    const matching = options.statuses === null
        ? scoped
        : scoped.filter((row) => options.statuses.has(row.status));

    const displayed = matching.slice(0, options.limit);
    const lines = [...options.warnings];

    if (matching.length === 0) {
        lines.push("No subagent runs match filters.");
        return lines.join("\n");
    }

    lines.push(...displayed.map((row) => formatSubagentListRow(row.meta, {
        status: row.status,
        now,
        usage: usageById(row.meta.id),
        health: healthById(row.meta.id),
    })));

    if (matching.length > displayed.length) {
        lines.push(
            `Showing ${displayed.length} of ${matching.length} matching subagent runs ` +
            `(limit ${options.limit}). Increase limit up to ${SUBAGENT_LIST_MAX_LIMIT} to see more.`,
        );
    }

    return lines.join("\n");
}
