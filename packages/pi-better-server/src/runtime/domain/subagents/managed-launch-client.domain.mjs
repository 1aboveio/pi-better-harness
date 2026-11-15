// Generated fixed launch domain from packages/pi-better-subagents/managed-launch-client.ts. Do not edit directly.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { currentSandboxPermissions } from "./permission-policy.domain.mjs";
import { ownerBindingFromContext, getWorkerOperationService, resolveProductionSchemas, DEFAULT_WORKER_BRIDGE_TOOLS } from "./worker-waits.domain.mjs";
import { processStartToken } from "./registry.domain.mjs";
import { WorkClient } from "./shared-work-client.mjs";
import { catalogHostAuthority } from "./catalog-host-admission.domain.mjs";
import { openSharedCatalog } from "./shared-catalog.domain.mjs";
import { SANDBOX_POLICY_CHANNEL } from "./permission-policy.domain.mjs";
import { canonicalJson } from "./operation-bridge-types.domain.mjs";
/** The fixed Pi host issues execution grants. Catalog registration grants no execution. */
export async function submitManagedLaunch(pi, ctx, key, tool, params) {
    mkdirSync(getAgentDir(), { recursive: true });
    const root = realpathSync(getAgentDir());
    const catalog = await openSharedCatalog(ctx.cwd, root);
    catalog.close();
    const registration = JSON.parse(readFileSync(join(root, "server-registration-v1.json"), "utf8"));
    if (registration.agentDir !== root || registration.version !== 1)
        throw new Error("Invalid runtime registration");
    const client = new WorkClient(join(registration.serverDir, "pi-server.sock"), root, ["runtime-subagent-launch-v1"]);
    const directory = join(root, "subagent-launch-admission");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077))
        throw new Error("Unsafe launch admission directory");
    const id = randomUUID(), secret = randomBytes(32).toString("hex"), path = join(directory, `${id}.json`);
    let unsubscribe;
    try {
        const hello = await client.ready;
        const catalogAuthority = await catalogHostAuthority(root, ctx.cwd, join(registration.serverDir, "pi-server.sock"));
        const owner = ownerBindingFromContext(ctx);
        if (!owner.sessionId)
            throw new Error("Launch requires a registered parent session");
        // Only branch-local settings travel to the mechanical host, never the transcript.
        const settings = ctx.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType.startsWith("pi-better-subagents-"));
        const payload = { version: 1, id, secretHash: createHash("sha256").update(secret).digest("hex"), instanceId: hello.instanceId,
            owner, pid: process.pid, start: processStartToken(process.pid), projectTrusted: ctx.isProjectTrusted(),
            background: { available: getWorkerOperationService(pi)?.assignmentContinuation === 1, tools: [...resolveProductionSchemas(pi, DEFAULT_WORKER_BRIDGE_TOOLS).schemas.keys()] },
            permissions: currentSandboxPermissions(pi) ?? {}, settings, model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
            catalogAuthority, key, tool, params };
        const staging = `${path}.tmp`;
        writeFileSync(staging, JSON.stringify(payload), { flag: "wx", mode: 0o600 });
        renameSync(staging, path);
        let checking = false;
        unsubscribe = pi.events.on(SANDBOX_POLICY_CHANNEL, () => {
            if (checking)
                return;
            checking = true;
            try {
                if (canonicalJson(currentSandboxPermissions(pi) ?? {}) !== canonicalJson(payload.permissions))
                    rmSync(path, { force: true });
            }
            catch {
                rmSync(path, { force: true });
            }
            finally {
                checking = false;
            }
        });
        return await client.request("runtime_launch_subagent", { authority: { id, secret } });
    }
    finally {
        if (typeof unsubscribe === "function")
            unsubscribe();
        client.close();
        rmSync(path, { force: true });
    }
}
