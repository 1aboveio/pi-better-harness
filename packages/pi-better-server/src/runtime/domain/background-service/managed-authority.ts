import { createHash, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { readAdmissionStartToken, readProcessStartTokenFresh } from './process-identity.js';
const ordered = (value: any): any => value === null || typeof value !== 'object' ? value : Array.isArray(value) ? value.map(ordered) : Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]));
export const backgroundDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');

export const TASK_TIMEOUT_HELP = "Optional whole-task timeout in seconds. Command watchers default to 900 seconds when omitted; pass 0 to use the 24-hour maximum. Spawned processes also have a 24-hour maximum. When the Background tasks sandbox profile sets a command time limit, that cap applies to each actual command (and each watch check) independently: a smaller timeout_seconds still wins, and 0 does not disable the policy cap.";
// Basalt 0.5.6 misreads an escaped dollar in nested tool schemas.
export const JSON_PATH_ROOT_PATTERN = '^[$]';
// Admission v1/v2 hashes the full schema. Use the published spelling of
// equivalent patterns and timeout help so clients and servers can upgrade independently.
const PUBLISHED_TIMEOUT_HELP = "Optional whole-task timeout in seconds. Command watchers default to 900 seconds when omitted; pass 0 to disable. Spawned processes have no default timeout. When the Background tasks sandbox profile sets a command time limit, that cap applies to each actual command (and each watch check) independently: a smaller timeout_seconds still wins, and 0 does not disable the policy cap.";

export function backgroundParametersDigest(parameters: unknown): string {
    const wire = JSON.stringify(ordered(parameters), (key, value) => {
        if (key === 'timeout_seconds' && value?.description === TASK_TIMEOUT_HELP) {
            return { ...value, description: PUBLISHED_TIMEOUT_HELP };
        }
        if (key === 'path' && value?.type === 'string' && value.pattern === JSON_PATH_ROOT_PATTERN) {
            return { ...value, pattern: '^\\$' };
        }
        return value;
    });
    return createHash('sha256').update(wire).digest('hex');
}

export function readBackgroundAuthority(root: string, instance: string, authority: any, requireLive = true): any {
    if (!authority || !/^[a-f0-9-]{36}$/.test(authority.id) || !/^[a-f0-9]{64}$/.test(authority.secret))
        throw new Error('background-authority-refused');
    const directory = join(root, 'background-tool-admission'), path = join(directory, `${authority.id}.json`);
    const dir = lstatSync(directory), stat = lstatSync(path);
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || (dir.mode & 0o077)
        || !stat.isFile() || stat.isSymbolicLink() || stat.uid !== dir.uid || (stat.mode & 0o077) || stat.size > 1024 * 1024)
        throw new Error('background-authority-refused');
    const record = JSON.parse(readFileSync(path, 'utf8')), digest = createHash('sha256').update(authority.secret).digest('hex');
    if ((record.version !== 1 && record.version !== 2) || record.instanceId !== instance || record.id !== authority.id || typeof record.secretHash !== 'string'
        || record.secretHash.length !== digest.length || !timingSafeEqual(Buffer.from(record.secretHash), Buffer.from(digest))
        || typeof record.key !== 'string' || !record.key || typeof record.tool !== 'string' || !record.owner?.sessionId
        || record.owner.workspace !== realpathSync(record.owner.workspace) || !Number.isSafeInteger(record.pid) || !record.start
        || !Array.isArray(record.branchIds) || record.branchIds.some((id: unknown) => typeof id !== 'string'))
        throw new Error('background-authority-refused');
    if (requireLive) {
        const start = record.version === 2 ? readAdmissionStartToken(record.pid) : readProcessStartTokenFresh(record.pid);
        if (!start) throw new Error('background-authority-refused: cannot verify host start time');
        if (start !== record.start)
            throw new Error('background-authority-refused: host identity changed');
        process.kill(record.pid, 0);
    }
    return record;
}
