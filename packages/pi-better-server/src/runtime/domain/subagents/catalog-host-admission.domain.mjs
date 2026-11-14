// Generated fixed launch domain from packages/pi-better-subagents/catalog-host-admission.ts. Do not edit directly.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkClient } from "./shared-work-client.mjs";
export function createCatalogHostAdapter() {
    let current;
    let live;
    let timer;
    let epoch = 0;
    let admitting = Promise.resolve(undefined);
    /** Fixed Pi adapter only. Never exposed as a tool or socket issuance operation. */
    function noteCatalogHostContext(ctx, overlay) {
        current = { ctx, overlay };
    }
    function closeCatalogHost() {
        epoch++;
        clearInterval(timer);
        timer = undefined;
        if (live) {
            live.client.close();
            rmSync(live.path, { force: true });
            live = undefined;
        }
        current = undefined;
    }
    function catalogHostAuthority(agentDir, cwd, socketPath) {
        admitting = admitting.catch(() => undefined).then(() => admit(agentDir, cwd, socketPath));
        return admitting;
    }
    async function admit(agentDir, cwd, socketPath) {
        const admittedEpoch = epoch;
        if (!current || realpathSync(current.ctx.cwd) !== realpathSync(cwd))
            return undefined;
        const ctx = current.ctx;
        const scope = { cwd: realpathSync(cwd), sessionId: ctx.sessionManager?.getSessionId?.() ?? `local-${process.pid}`,
            branchId: ctx.sessionManager?.getLeafId?.() ?? "root", projectTrusted: typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted(),
            overlayDigest: overlayDigest(current.overlay()) };
        const key = JSON.stringify([agentDir, socketPath, scope]);
        if (live?.key === key && !live.client.closed)
            return live.authority;
        if (live) {
            live.client.close();
            rmSync(live.path, { force: true });
            live = undefined;
        }
        const root = join(realpathSync(agentDir), "catalog-host-admission");
        mkdirSync(root, { mode: 0o700, recursive: true });
        const stat = lstatSync(root);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
            throw new Error("Unsafe catalog host admission directory");
        const id = randomUUID(), secret = randomBytes(32).toString("hex"), generation = randomUUID();
        const path = join(root, `${id}.json`), staging = join(root, `.${id}`);
        const authority = { id, secret, generation, cwd: scope.cwd, sessionId: scope.sessionId, branchId: scope.branchId };
        const client = new WorkClient(socketPath, agentDir, ["runtime-catalog-v1"]);
        try {
            const hello = await client.ready;
            writeFileSync(staging, JSON.stringify({ version: 1, id, generation, serverInstance: hello.instanceId, pid: process.pid, secretHash: hash(secret), ...scope }), { mode: 0o600, flag: "wx" });
            renameSync(staging, path);
            await client.request("runtime_bind_catalog_host", { authority });
            if (epoch !== admittedEpoch || !current)
                throw new Error("catalog-host-revoked");
            live = { client, path, key, authority };
            if (!timer) {
                timer = setInterval(() => { void catalogHostAuthority(agentDir, current?.ctx.cwd ?? cwd, socketPath).catch(() => closeCatalogHost()); }, 500);
                timer.unref();
            }
            return authority;
        }
        catch (error) {
            client.close();
            rmSync(path, { force: true });
            rmSync(staging, { force: true });
            throw error;
        }
    }
    return { noteCatalogHostContext, closeCatalogHost, catalogHostAuthority };
}
export const { noteCatalogHostContext, closeCatalogHost, catalogHostAuthority } = createCatalogHostAdapter();
export function overlayDigest(value = {}) {
    return hash(JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(id => [id, Object.fromEntries(Object.entries(value[id]).sort(([a], [b]) => a.localeCompare(b)))]))));
}
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
