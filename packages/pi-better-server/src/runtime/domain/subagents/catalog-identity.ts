/**
 * Registry-wide display labels for direct role runs.
 *
 * Named-agent labels are not allocated here. Lifecycle writes the agent's
 * defined name onto `RunMeta.name`. This module only reserves role labels
 * (`developer-1`, `developer-checkout`, `developer-checkout-2`) and refuses to
 * reuse or rewrite a label already stored on a run.
 *
 * Reservations are empty-claim files under the existing run registry root
 * (`{baseDir()}/labels` by default — the same directory `registry.ts` uses,
 * never a session directory and never a second registry). Create is
 * `O_EXCL`, so two processes cannot take the same label.
 *
 * Retention: `removeMetaArtifacts` and the daily/size sweeps delete
 * `runs/<id>` only. A removed run does not free `developer-1`. Reservations
 * are tiny JSON files, are not counted by the run-directory size cap, and
 * share the registry root's lifetime (`os.tmpdir()/pi-better-subagents`,
 * which the OS may clear). Resetting numbering means deleting `labels/`
 * on purpose; surviving run names are still adopted and not rewritten.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseDir } from "./registry.ts";

/** Directory name under the run-registry root. Not a separate registry. */
export const CATALOG_LABEL_DIRECTORY = "labels";

const MAX_ATTEMPTS = 100_000;

export interface AllocateCatalogLabelInput {
    /** Existing run-registry root. Omit to use `baseDir()` from registry.ts. */
    registryDir?: string;
    roleId: string;
    roleName: string;
    /** Per-run alias. Not a reusable agent name. Omit for numeric labels. */
    alias?: string;
}

interface ReservationRecord {
    label: string;
    kind: "numeric" | "alias" | "adopted";
    roleId?: string;
    roleName?: string;
    alias?: string | null;
    allocatedAt: number;
    adopted?: boolean;
}

/**
 * The run-registry root label allocation uses. An omitted or empty
 * `registryDir` is `baseDir()` — `join(os.tmpdir(), "pi-better-subagents")` —
 * which is shared by every session on this machine for this temp root.
 */
export function resolveCatalogRegistryRoot(registryDir?: string): string {
    if (typeof registryDir === "string" && registryDir.length > 0) return registryDir;
    return baseDir();
}

/** Stable display slug for a role. Display name wins; `role.<id>` is the fallback. */
export function roleDisplaySlug(roleName: string, roleId: string): string {
    const fromName = slugify(roleName);
    if (fromName) return fromName;
    const fromId = slugify(roleId.trim().replace(/^role\./i, ""));
    if (fromId) return fromId;
    throw new Error("allocateCatalogLabel requires a roleName or roleId that yields a display slug");
}

/**
 * Reserve the next direct-role label. Synchronous; callers may await it.
 * Numeric form is `<slug>-1`, `<slug>-2`, ... Alias form is `<slug>-<alias>`,
 * then `<slug>-<alias>-2` on collision. The reservation namespace is shared,
 * so a numeric label and an alias label cannot allocate the same string.
 */
export function allocateCatalogLabel(input: AllocateCatalogLabelInput): string {
    if (typeof input?.roleId !== "string" || input.roleId.trim() === "") {
        throw new Error("allocateCatalogLabel requires roleId");
    }
    const root = resolveCatalogRegistryRoot(input.registryDir);
    const slug = roleDisplaySlug(input.roleName ?? "", input.roleId);
    const aliasSlug = qualifyAlias(slug, input.alias);
    const persisted = readPersistedLabels(root);
    adoptPersistedLabels(root, persisted);
    const reserved = readReservedLabels(root);
    const allocatedAt = Date.now();

    if (!aliasSlug) {
        return claimSeries(root, reserved, persisted, (n) => `${slug}-${n}`, 1, {
            kind: "numeric",
            roleId: input.roleId,
            roleName: input.roleName,
            alias: null,
            allocatedAt,
        });
    }

    const base = `${slug}-${aliasSlug}`;
    if (claim(root, base, reserved, persisted, {
        label: base,
        kind: "alias",
        roleId: input.roleId,
        roleName: input.roleName,
        alias: aliasSlug,
        allocatedAt,
    })) return base;

    return claimSeries(root, reserved, persisted, (n) => `${base}-${n}`, 2, {
        kind: "alias",
        roleId: input.roleId,
        roleName: input.roleName,
        alias: aliasSlug,
        allocatedAt,
    });
}

function claimSeries(
    root: string,
    reserved: Set<string>,
    persisted: Set<string>,
    format: (n: number) => string,
    start: number,
    template: Omit<ReservationRecord, "label">,
): string {
    for (let n = start; n < start + MAX_ATTEMPTS; n += 1) {
        const label = format(n);
        if (claim(root, label, reserved, persisted, { ...template, label })) return label;
    }
    throw new Error(`allocateCatalogLabel exhausted reservations after ${MAX_ATTEMPTS} attempts`);
}

function claim(
    root: string,
    label: string,
    reserved: Set<string>,
    persisted: Set<string>,
    record: ReservationRecord,
): boolean {
    if (reserved.has(label) || persisted.has(label)) return false;
    try {
        writeReservation(root, record);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            reserved.add(label);
            return false;
        }
        throw error;
    }
    reserved.add(label);
    // A run label that appeared after the initial adopt still owns this string.
    if (readPersistedLabels(root).has(label)) {
        persisted.add(label);
        return false;
    }
    return true;
}

function writeReservation(root: string, record: ReservationRecord): void {
    const directory = join(root, CATALOG_LABEL_DIRECTORY);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, reservationFileName(record.label)), `${JSON.stringify(record)}\n`, { flag: "wx" });
}

function adoptPersistedLabels(root: string, labels: Set<string>): void {
    const allocatedAt = Date.now();
    for (const label of labels) {
        try {
            writeReservation(root, {
                label,
                kind: "adopted",
                adopted: true,
                allocatedAt,
            });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
    }
}

function readReservedLabels(root: string): Set<string> {
    const labels = new Set<string>();
    let names: string[];
    try {
        names = readdirSync(join(root, CATALOG_LABEL_DIRECTORY));
    } catch {
        return labels;
    }
    for (const name of names) {
        // Hashed filenames are only for "." / ".." and are not display labels.
        if (/^~[0-9a-f]{64}$/.test(name)) continue;
        try {
            labels.add(decodeURIComponent(name));
        } catch {
            // Unreadable reservation names still occupy their file via O_EXCL.
        }
    }
    return labels;
}

function readPersistedLabels(root: string): Set<string> {
    const labels = new Set<string>();
    let ids: string[];
    try {
        ids = readdirSync(join(root, "runs"));
    } catch {
        return labels;
    }
    for (const id of ids) {
        try {
            const meta = JSON.parse(readFileSync(join(root, "runs", id, "meta.json"), "utf8")) as {
                name?: unknown;
                catalog?: { identity?: unknown };
            };
            if (typeof meta.name === "string" && meta.name.length > 0) labels.add(meta.name);
            const identity = meta.catalog?.identity;
            if (identity && typeof identity === "object" && !Array.isArray(identity)) {
                const snapshotLabel = (identity as { label?: unknown }).label;
                if (typeof snapshotLabel === "string" && snapshotLabel.length > 0) labels.add(snapshotLabel);
            }
        } catch {
            // A missing or unreadable meta does not reserve a label.
        }
    }
    return labels;
}

function qualifyAlias(roleSlug: string, alias: string | undefined): string | undefined {
    if (typeof alias !== "string") return undefined;
    let aliasSlug = slugify(alias);
    if (!aliasSlug) return undefined;
    const roleParts = roleSlug.split("-");
    const aliasParts = aliasSlug.split("-");
    if (
        aliasParts.length > roleParts.length
        && roleParts.every((part, index) => aliasParts[index] === part)
    ) {
        aliasSlug = aliasParts.slice(roleParts.length).join("-");
    }
    return aliasSlug || undefined;
}

function slugify(value: string): string {
    return value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-{2,}/g, "-");
}

function reservationFileName(label: string): string {
    const encoded = encodeURIComponent(label);
    if (!encoded || encoded === "." || encoded === "..") {
        return `~${createHash("sha256").update(label).digest("hex")}`;
    }
    return encoded;
}
