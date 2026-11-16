import { createHash } from "node:crypto";

const ordered = value => value === null || typeof value !== "object" ? value
    : Array.isArray(value) ? value.map(ordered)
    : Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]));
export const launchDigest = value => createHash("sha256").update(JSON.stringify(ordered(value))).digest("hex");
