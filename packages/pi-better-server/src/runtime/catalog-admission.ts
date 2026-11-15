import { createHash, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { processMatchesStart } from "../daemon-owner.ts";

/** Private fixed-host registrations, not client-supplied trust decisions. */
export class CatalogAdmission {
  private live = new Map<string, object>();
  private revoked = new Set<string>();
  private root: string;
  private instanceId: string;
  constructor(agentDir: string, instanceId: string) { this.root = join(realpathSync(agentDir), "catalog-host-admission"); this.instanceId = instanceId; }
  read(authority: any) {
    if (!authority || typeof authority.id !== "string" || !/^[a-f0-9-]{36}$/.test(authority.id)
      || typeof authority.secret !== "string" || !/^[a-f0-9]{64}$/.test(authority.secret)) throw new Error("catalog-authority-refused");
    const root = lstatSync(this.root), path = join(this.root, `${authority.id}.json`), file = lstatSync(path);
    if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o077) !== 0 || root.uid !== process.getuid?.()
      || !file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0 || file.uid !== root.uid || file.size > 8192) throw new Error("catalog-authority-refused");
    const record = JSON.parse(readFileSync(path, "utf8"));
    const digest = createHash("sha256").update(authority.secret).digest("hex");
    if (record.version !== 1 || record.serverInstance !== this.instanceId || record.id !== authority.id || record.generation !== authority.generation
      || typeof record.secretHash !== "string" || record.secretHash.length !== digest.length
      || !timingSafeEqual(Buffer.from(record.secretHash), Buffer.from(digest))
      || record.cwd !== authority.cwd || record.cwd !== realpathSync(record.cwd)
      || record.sessionId !== authority.sessionId || record.branchId !== authority.branchId
      || typeof record.projectTrusted !== "boolean" || !Number.isSafeInteger(record.pid) || record.pid <= 0
      || typeof record.sessionId !== "string" || !record.sessionId || typeof record.branchId !== "string" || !record.branchId
      || typeof record.overlayDigest !== "string" || !/^[a-f0-9]{64}$/.test(record.overlayDigest)) throw new Error("catalog-authority-refused");
    if (!processMatchesStart(record.pid, record.pidStartTime)) throw new Error("catalog-host-identity-refused");
    return record;
  }
  bind(authority: unknown, socket: object) {
    const record = this.read(authority);
    if (this.revoked.has(record.id)) throw new Error("catalog-host-revoked");
    if (this.live.has(record.id) && this.live.get(record.id) !== socket) throw new Error("catalog-host-already-bound");
    this.live.set(record.id, socket);
  }
  verify(authority: unknown) {
    const record = this.read(authority);
    if (!this.live.has(record.id)) throw new Error("catalog-host-revoked");
    return record;
  }
  close(socket: object) {
    for (const [id, owner] of this.live) if (owner === socket) {
      this.live.delete(id);
      try { rmSync(join(this.root, `${id}.json`), { force: true }); }
      catch { this.revoked.add(id); }
    }
  }
}
