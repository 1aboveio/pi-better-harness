// Generated fixed launch domain from packages/pi-better-sandbox/files.ts. Do not edit directly.
/**
 * Foreground file-mutation confinement for the built-in `write` and `edit`
 * tools.
 *
 * These two tools never spawn a child process — they call `fs` in Pi's own
 * process — so the argv wrapping that confines `bash` cannot reach them. The
 * enforcement here is therefore an in-process containment check against the
 * same compiled write policy the kernel backends are built from, run on the
 * absolute path Pi itself resolved.
 *
 * Placement is the whole point. Pi's built-in `write`/`edit` implementations
 * take `WriteOperations`/`EditOperations` and call them *inside*
 * `withFileMutationQueue(absolutePath, ...)`, after their own abort checks. By
 * replacing only those operations, every check below runs inside Pi's per-file
 * mutation queue and inside its cancellation window, and no denied mutation can
 * be re-targeted between the check and the syscall: the guard and the `fs` call
 * are the same operation.
 *
 * Reads and mutations use the same canonical file-permission decisions as the
 * kernel policy; protected-path write denials remain stricter than broad grants.
 */
import { constants } from "node:fs";
import { access as fsAccess, mkdir as fsMkdir, readFile as fsReadFile, writeFile as fsWriteFile, } from "node:fs/promises";
import { compileWritePolicy, evaluateWriteAccess, evaluateReadAccess, } from "./shared-sandbox-core.domain.mjs";
/**
 * Thrown instead of mutating a path the foreground sandbox does not allow.
 *
 * It surfaces through Pi's normal tool-error path — the built-in `write` and
 * `edit` implementations already let operation errors propagate — so the model
 * sees an ordinary failed tool call and the host filesystem is untouched.
 */
export class ForegroundSandboxWriteDeniedError extends Error {
    decision;
    /** The compiled policy that refused the write. */
    policy;
    constructor(decision, policy, kind = "write") {
        super(explainDenial(decision, policy, kind));
        this.name = "ForegroundSandboxWriteDeniedError";
        this.decision = decision;
        this.policy = policy;
    }
}
function explainDenial(decision, policy, kind) {
    const attempt = kind === "directory" ? "create directory" : "write";
    const refused = `Foreground sandbox refused to ${attempt} ${decision.path}; nothing was changed on disk.`;
    if (decision.reason === "outside-writable-root")
        return `${refused} Writes are confined to ${policy.writableRoot}.`;
    if (decision.reason === "write-denied")
        return `${refused} ${decision.deniedBy} is a write-denied path.`;
    return `${refused} The selected file permissions do not allow this write.`;
}
/** Identity of a compiled policy, so it is recompiled on change and not per mutation. */
function policyKey(policy) {
    return JSON.stringify(policy);
}
/**
 * Build the guard the file operations run before every mutation.
 *
 * The launch decision is taken per mutation, so `/sandbox on` and `/sandbox off`
 * take effect for mutations attempted after the toggle. The policy behind it is
 * compiled once and reused until the policy itself changes.
 *
 * The canonical path comes back so callers mutate the path that was checked
 * rather than the one they were handed. A path-based check can otherwise be
 * raced by a symlink swapped in after the check and before the syscall; writing
 * the already-resolved path removes that final-component race.
 */
export function createForegroundWriteGuard(controller, seams = {}) {
    let compiledKey;
    let compiled;
    return function assertWritable(absolutePath, kind = "write") {
        // Throws when the sandbox is enabled but unusable: an unavailable or
        // failed backend blocks the mutation instead of quietly delegating.
        const plan = controller.requireLaunchPlan();
        if (!plan.confined)
            return absolutePath;
        const key = policyKey(plan.policy);
        if (compiled === undefined || key !== compiledKey) {
            compiled = compileWritePolicy(plan.policy, seams);
            compiledKey = key;
        }
        const decision = evaluateWriteAccess(absolutePath, compiled, seams);
        if (!decision.allowed) {
            throw new ForegroundSandboxWriteDeniedError(decision, compiled, kind);
        }
        return decision.path;
    };
}
/** Enforce reads in Pi's in-process file tools using the same canonical policy. */
export function createForegroundReadGuard(controller, seams = {}) {
    return (absolutePath) => {
        const plan = controller.requireLaunchPlan();
        if (!plan.confined)
            return absolutePath;
        const decision = evaluateReadAccess(absolutePath, compileWritePolicy(plan.policy, seams), seams);
        if (!decision.allowed)
            throw new Error(`Foreground sandbox refused to read ${decision.path}: ${decision.reason}.`);
        return decision.path;
    };
}
/** Pi's own default local backends, which the guarded operations delegate to. */
const localWriteOperations = {
    writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
    mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => { }),
};
const localEditOperations = {
    readFile: (path) => fsReadFile(path),
    writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
    access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};
/**
 * Write operations that confine every mutation they perform.
 *
 * `mkdir` is guarded as well as `writeFile`: the built-in `write` tool creates
 * parent directories before writing, so an unguarded `mkdir` would materialise
 * host directories outside the project root before the write itself was
 * refused.
 */
export function createSandboxedWriteOperations(controller, options = {}) {
    const assertWritable = createForegroundWriteGuard(controller, options);
    const local = options.localOperations ?? localWriteOperations;
    return {
        async mkdir(dir) {
            return local.mkdir(assertWritable(dir, "directory"));
        },
        async writeFile(absolutePath, content) {
            return local.writeFile(assertWritable(absolutePath), content);
        },
    };
}
/**
 * Edit operations that confine every mutation they perform.
 *
 * `access` is Pi's own pre-flight gate for `edit`, so guarding it refuses a
 * denied target before the file is read or a diff is computed; `writeFile` is
 * guarded because it is the mutation. `readFile` also checks the selected read
 * permissions before accessing content.
 */
export function createSandboxedEditOperations(controller, options = {}) {
    const assertWritable = createForegroundWriteGuard(controller, options);
    const assertReadable = createForegroundReadGuard(controller, options);
    const local = options.localOperations ?? localEditOperations;
    return {
        readFile: (absolutePath) => local.readFile(assertReadable(absolutePath)),
        async access(absolutePath) {
            return local.access(assertWritable(absolutePath));
        },
        async writeFile(absolutePath, content) {
            return local.writeFile(assertWritable(absolutePath), content);
        },
    };
}
