// Generated fixed launch domain from packages/pi-better-subagents/supervisor-client.mjs. Do not edit directly.
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createCatalogHostAdapter } from "./catalog-host-admission.domain.mjs";
import { createAgentSessionSettings } from "./agent-session-settings.domain.mjs";
import { openSharedCatalog } from "./shared-catalog.domain.mjs";
import { resolveSelection } from "./catalog-resolver.domain.mjs";
export async function openSupervisorClient(pi, ctx, signal) {
    const settings = createAgentSessionSettings(pi);
    settings.restore(ctx);
    // Pi loads extensions independently. Bind this request to its own live host context.
    const host = createCatalogHostAdapter();
    host.noteCatalogHostContext(ctx, () => settings.snapshot());
    let catalog;
    try {
        catalog = await openSharedCatalog(ctx.cwd, getAgentDir(), ctx.sessionManager.getSessionId(), undefined, signal, host.catalogHostAuthority);
    }
    catch (error) {
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
            if (!selected.launchable || !selected.effective)
                return;
            const { instructions, model, effort } = selected.effective;
            return { revision: snapshot.revision, instructions, model: model.value, effort: effort.value };
        },
    };
}
