/** Exact-name selection of saved conversations; attempt IDs never become session IDs. */
import type { RunMeta } from "./registry.ts";

/**
 * Select a single conversation in the caller's workspace scope. Several attempts
 * of one conversation count once; distinct conversations with the same display
 * name must be disambiguated by session_id. Admission/status/lease checks remain
 * the launcher's responsibility, including refusal of an active conversation.
 */
export function selectSessionByName(
    metas: readonly RunMeta[],
    name: string,
    inWorkspace: (cwd: string) => boolean,
): string {
    const requested = name.trim();
    if (!requested) throw new Error("session_name is empty.");
    const latest = new Map<string, RunMeta>();
    for (const meta of metas) {
        if (!meta.sessionId) continue;
        const previous = latest.get(meta.sessionId);
        if (!previous || meta.startedAt > previous.startedAt) latest.set(meta.sessionId, meta);
    }
    const matches = [...latest.values()]
        .filter((meta) => meta.name === requested && inWorkspace(meta.cwd))
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    if (matches.length === 0) {
        throw new Error(`No saved subagent conversation named ${JSON.stringify(requested)} in the current folder. Use subagent_list({all:true}) to find its session_id.`);
    }
    if (matches.length > 1) {
        const shown = matches.slice(0, 10).map((meta) => `session_id=${meta.sessionId} (${meta.cwd})`).join("; ");
        const remaining = matches.length > 10 ? `; ${matches.length - 10} more` : "";
        throw new Error(`Ambiguous session_name ${JSON.stringify(requested)}: ${shown}${remaining}. Pass session_id to choose the conversation.`);
    }
    return matches[0]!.sessionId;
}
