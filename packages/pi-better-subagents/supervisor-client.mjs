import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createCatalogHostAdapter } from "./catalog-host-admission.ts";
import { createAgentSessionSettings } from "./agent-session-settings.ts";
import { openSharedCatalog } from "./shared-catalog.ts";
import { resolveSelection } from "./catalog-resolver.ts";

export async function openSupervisorClient(pi, ctx, signal) {
    const settings = createAgentSessionSettings(pi);
    settings.restore(ctx);
    // Pi loads extensions independently. Bind this request to its own live host context.
    const host = createCatalogHostAdapter();
    host.noteCatalogHostContext(ctx, () => settings.snapshot());
    let catalog;
    try {
        catalog = await openSharedCatalog(ctx.cwd, getAgentDir(), ctx.sessionManager.getSessionId(), undefined, signal, host.catalogHostAuthority);
    } catch (error) {
        host.closeCatalogHost();
        throw error;
    }
    return {
        close() { catalog.close(); host.closeCatalogHost(); },
        review: catalog.review,
        decision: catalog.decision,
        sharedReadDiagnosis: catalog.sharedReadDiagnosis,
        async role() {
            settings.restore(ctx);
            const snapshot = await catalog.get(settings.snapshot());
            const selected = resolveSelection(snapshot, { roleId: "role.supervisor" });
            if (!selected.launchable || !selected.effective) return;
            const { instructions, model, effort } = selected.effective;
            return { revision: snapshot.revision, instructions, model: model.value, effort: effort.value };
        },
    };
}
