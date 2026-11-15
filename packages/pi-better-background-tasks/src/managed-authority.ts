import { createHash, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { readProcessStartTokenFresh } from './process-identity.js';
const ordered = (value: any): any => value === null || typeof value !== 'object' ? value : Array.isArray(value) ? value.map(ordered) : Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]));
export const backgroundDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
export function readBackgroundAuthority(root: string, instance: string, authority: any, requireLive = true): any {
    if (!authority || !/^[a-f0-9-]{36}$/.test(authority.id) || !/^[a-f0-9]{64}$/.test(authority.secret))
        throw new Error('background-authority-refused');
    const directory = join(root, 'background-tool-admission'), path = join(directory, `${authority.id}.json`);
    const dir = lstatSync(directory), stat = lstatSync(path);
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || (dir.mode & 0o077)
        || !stat.isFile() || stat.isSymbolicLink() || stat.uid !== dir.uid || (stat.mode & 0o077) || stat.size > 1024 * 1024)
        throw new Error('background-authority-refused');
    const record = JSON.parse(readFileSync(path, 'utf8')), digest = createHash('sha256').update(authority.secret).digest('hex');
    if (record.version !== 1 || record.instanceId !== instance || record.id !== authority.id || typeof record.secretHash !== 'string'
        || record.secretHash.length !== digest.length || !timingSafeEqual(Buffer.from(record.secretHash), Buffer.from(digest))
        || typeof record.key !== 'string' || !record.key || typeof record.tool !== 'string' || !record.owner?.sessionId
        || record.owner.workspace !== realpathSync(record.owner.workspace) || !Number.isSafeInteger(record.pid) || !record.start
        || !Array.isArray(record.branchIds) || record.branchIds.some((id: unknown) => typeof id !== 'string'))
        throw new Error('background-authority-refused');
    if (requireLive) {
        if (readProcessStartTokenFresh(record.pid) !== record.start)
            throw new Error('background-authority-refused: host identity changed');
        process.kill(record.pid, 0);
    }
    return record;
}
