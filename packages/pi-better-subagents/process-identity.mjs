import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Best-effort process start identity. Unavailable does not prove the pid is dead. */
export function processStartToken(pid) {
    if (process.platform === "linux") {
        try {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
            const close = stat.lastIndexOf(") ");
            if (close >= 0) {
                const starttime = stat.slice(close + 2).split(" ")[19];
                if (starttime && /^\d+$/.test(starttime)) return starttime;
            }
        } catch (error) {
            if (error.code !== "ENOENT" && error.code !== "EACCES") return undefined;
        }
    }
    try {
        const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
            encoding: "utf-8",
            timeout: 1_000,
            env: { ...process.env, LC_ALL: "C" },
            stdio: ["ignore", "pipe", "ignore"],
        }).trim().replace(/\s+/g, " ");
        return out === "" ? undefined : out;
    } catch {
        return undefined;
    }
}
