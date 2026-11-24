import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createAgentSessionSettings } from "./agent-session-settings.ts";
import { openSharedCatalog } from "./shared-catalog.ts";
import { resolveSelection } from "./catalog-resolver.ts";

export async function openSupervisorClient(cwd, sessionId, signal) {
    const catalog = await openSharedCatalog(cwd, getAgentDir(), sessionId, undefined, signal);
    return {
        close: catalog.close,
        review: catalog.review,
        decision: catalog.decision,
        sharedReadDiagnosis: catalog.sharedReadDiagnosis,
        async role(pi, ctx) {
            const settings = createAgentSessionSettings(pi);
            settings.restore(ctx);
            const snapshot = await catalog.get(settings.snapshot());
            const selected = resolveSelection(snapshot, { roleId: "role.supervisor" });
            if (!selected.launchable || !selected.effective) return;
            const { instructions, model, effort } = selected.effective;
            return { revision: snapshot.revision, instructions, model: model.value, effort: effort.value };
        },
    };
}
