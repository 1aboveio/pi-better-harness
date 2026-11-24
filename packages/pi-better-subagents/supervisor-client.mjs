import { openSharedCatalog } from "./shared-catalog.ts";
import { resolveSelection } from "./catalog-resolver.ts";

export async function openSupervisorClient(cwd, sessionId, signal) {
    const catalog = await openSharedCatalog(cwd, undefined, sessionId, undefined, signal);
    return {
        close: catalog.close,
        review: catalog.review,
        decision: catalog.decision,
        sharedReadDiagnosis: catalog.sharedReadDiagnosis,
        async role() {
            const snapshot = await catalog.get();
            const selected = resolveSelection(snapshot, { roleId: "role.supervisor" });
            if (!selected.launchable || !selected.effective) return;
            const { instructions, model, effort } = selected.effective;
            return { revision: snapshot.revision, instructions, model: model.value, effort: effort.value };
        },
    };
}
