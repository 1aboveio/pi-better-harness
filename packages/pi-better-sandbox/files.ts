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
 * Reads stay unrestricted. `edit`'s `readFile` is delegated untouched; only the
 * operations that can change the host filesystem are guarded.
 */

import { constants } from "node:fs";
import {
    access as fsAccess,
    mkdir as fsMkdir,
    readFile as fsReadFile,
    writeFile as fsWriteFile,
} from "node:fs/promises";

import type { EditOperations, WriteOperations } from "@earendil-works/pi-coding-agent";

import {
    type CompiledSandboxWritePolicy,
    compileWritePolicy,
    evaluateWriteAccess,
    type SandboxSeams,
    type SandboxWritePolicy,
    type WriteAccessDecision,
} from "./shared-sandbox-core.ts";
import type { ForegroundSandboxController } from "./state.ts";

/** The refusing half of a write decision. */
export type DeniedWriteAccess = Extract<WriteAccessDecision, { allowed: false }>;

/** What the refused operation would have done, so the message names it. */
export type MutationKind = "write" | "directory";

/**
 * Thrown instead of mutating a path the foreground sandbox does not allow.
 *
 * It surfaces through Pi's normal tool-error path — the built-in `write` and
 * `edit` implementations already let operation errors propagate — so the model
 * sees an ordinary failed tool call and the host filesystem is untouched.
 */
export class ForegroundSandboxWriteDeniedError extends Error {
    readonly decision: DeniedWriteAccess;
    /** The compiled policy that refused the write. */
    readonly policy: CompiledSandboxWritePolicy;

    constructor(
        decision: DeniedWriteAccess,
        policy: CompiledSandboxWritePolicy,
        kind: MutationKind = "write",
    ) {
        super(explainDenial(decision, policy, kind));
        this.name = "ForegroundSandboxWriteDeniedError";
        this.decision = decision;
        this.policy = policy;
    }
}

function explainDenial(
    decision: DeniedWriteAccess,
    policy: CompiledSandboxWritePolicy,
    kind: MutationKind,
): string {
    const attempt = kind === "directory" ? "create directory" : "write";
    const refused = `Foreground sandbox refused to ${attempt} ${decision.path}; nothing was changed on disk.`;
    return decision.reason === "outside-writable-root"
        ? `${refused} Writes are confined to ${policy.writableRoot}.`
        : `${refused} ${decision.deniedBy} is a write-denied path.`;
}

/**
 * Assert one mutation target is writable under the current effective policy.
 *
 * Throws `ForegroundSandboxBlockedError` when the sandbox is enabled but cannot
 * be applied (no backend, unsafe launch root, no session yet), and
 * `ForegroundSandboxWriteDeniedError` when the canonical target is outside the
 * writable root or write-denied. Returns silently when a human explicitly
 * disabled the sandbox, which is the only path to an unconfined mutation.
 */
export type ForegroundWriteGuard = (absolutePath: string, kind?: MutationKind) => string;

/** Identity of a compiled policy, so it is recompiled on change and not per mutation. */
function policyKey(policy: SandboxWritePolicy): string {
    return JSON.stringify([policy.writableRoot, policy.denyWrite ?? [], policy.home]);
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
export function createForegroundWriteGuard(
    controller: ForegroundSandboxController,
    seams: SandboxSeams = {},
): ForegroundWriteGuard {
    let compiledKey: string | undefined;
    let compiled: CompiledSandboxWritePolicy | undefined;

    return function assertWritable(absolutePath: string, kind: MutationKind = "write"): string {
        // Throws when the sandbox is enabled but unusable: an unavailable or
        // failed backend blocks the mutation instead of quietly delegating.
        const plan = controller.requireLaunchPlan();
        if (!plan.confined) return absolutePath;

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

/** Pi's own default local backends, which the guarded operations delegate to. */
const localWriteOperations: WriteOperations = {
    writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
    mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
};

const localEditOperations: EditOperations = {
    readFile: (path) => fsReadFile(path),
    writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
    access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export type SandboxedWriteOperationsOptions = SandboxSeams & {
    /** The local filesystem backend to delegate allowed mutations to. */
    localOperations?: WriteOperations;
};

export type SandboxedEditOperationsOptions = SandboxSeams & {
    /** The local filesystem backend to delegate allowed mutations to. */
    localOperations?: EditOperations;
};

/**
 * Write operations that confine every mutation they perform.
 *
 * `mkdir` is guarded as well as `writeFile`: the built-in `write` tool creates
 * parent directories before writing, so an unguarded `mkdir` would materialise
 * host directories outside the project root before the write itself was
 * refused.
 */
export function createSandboxedWriteOperations(
    controller: ForegroundSandboxController,
    options: SandboxedWriteOperationsOptions = {},
): WriteOperations {
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
 * guarded because it is the mutation. `readFile` is delegated untouched — this
 * sandbox never restricts reads.
 */
export function createSandboxedEditOperations(
    controller: ForegroundSandboxController,
    options: SandboxedEditOperationsOptions = {},
): EditOperations {
    const assertWritable = createForegroundWriteGuard(controller, options);
    const local = options.localOperations ?? localEditOperations;

    return {
        readFile: (absolutePath) => local.readFile(absolutePath),
        async access(absolutePath) {
            return local.access(assertWritable(absolutePath));
        },
        async writeFile(absolutePath, content) {
            return local.writeFile(assertWritable(absolutePath), content);
        },
    };
}
