/**
 * Session-local foreground sandbox state.
 *
 * One controller per Pi session owns three things: the canonical project root
 * captured at session start, whether a human has switched protection off, and
 * the *effective* status derived from live runtime evidence (which backend this
 * platform actually resolves, not what the package intended).
 *
 * The enabled state is deliberately in-memory only. Every session start —
 * startup, new, resume, fork, reload — calls `beginSession` and lands back on
 * enabled, which is what "an off state is never persisted" means in practice.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
    canonicalizePath,
    describeSandboxSupport,
    type SandboxBackendId,
    type SandboxWritePolicy,
} from "./shared-sandbox-core.ts";
import {
    describeUnsafeProjectRoot,
    PACKAGED_DENY_WRITE_TEMPLATES,
    type PolicySeams,
    resolveDenyWriteTemplates,
} from "./policy.ts";

/**
 * What the foreground sandbox is actually doing right now.
 *
 * - `enabled`   - a backend is resolved and protected operations are wrapped.
 * - `disabled`  - a human turned it off for this session.
 * - `unavailable` - this platform resolves no backend; protected operations are blocked.
 * - `failed`    - protection cannot be applied here (no session yet, or an
 *                 unsafe launch root); protected operations are blocked.
 */
export type ForegroundSandboxState = "enabled" | "disabled" | "unavailable" | "failed";

/**
 * The immutable effective-policy snapshot published to first-party consumers
 * and rendered by `/sandbox` and the footer. Everything in it is evidence, not
 * intent: `backend` and `executable` come from backend resolution, not config.
 */
export type ForegroundSandboxStatus = {
    readonly state: ForegroundSandboxState;
    /** Canonical launch directory, or undefined before the first session start. */
    readonly projectRoot: string | undefined;
    /** The only writable subtree while `state` is `enabled`. */
    readonly writableRoot: string | undefined;
    /** Canonical paths that stay non-writable inside the writable root. */
    readonly denyWrite: readonly string[];
    readonly platform: string;
    readonly backend: SandboxBackendId | undefined;
    readonly executable: string | undefined;
    /** Reads are never restricted by this sandbox. */
    readonly readPolicy: "unrestricted";
    /** Network is never restricted by this sandbox. */
    readonly networkPolicy: "unrestricted";
    /** Human-readable evidence for why `state` is what it is. */
    readonly reason: string;
};

/** A launch decision for one protected operation. */
export type ForegroundSandboxLaunchPlan =
    | { readonly confined: false }
    | {
          readonly confined: true;
          readonly policy: SandboxWritePolicy;
          readonly profilePath: string;
      };

/** Thrown when a protected operation must be blocked instead of run unconfined. */
export class ForegroundSandboxBlockedError extends Error {
    readonly status: ForegroundSandboxStatus;

    constructor(status: ForegroundSandboxStatus) {
        super(
            `Foreground sandbox is ${status.state}; this command was blocked rather than run unconfined. ${status.reason}`,
        );
        this.name = "ForegroundSandboxBlockedError";
        this.status = status;
    }
}

export type ForegroundSandboxSeams = PolicySeams & {
    /** Creates the directory generated sandbox profiles are written into. */
    createProfileDir?: () => string;
};

/**
 * What an operator can do about a missing backend on a foreground surface.
 *
 * `sandbox:false` is the subagent tool's opt-out and means nothing here; the
 * only lever on a session is the slash command.
 */
export const FOREGROUND_SANDBOX_REMEDY =
    "Run unconfined on purpose with /sandbox off, or work in a session that has a backend.";

const NO_SESSION_REASON =
    "No session has started yet, so no canonical project root has been captured.";

export class ForegroundSandboxController {
    readonly #seams: ForegroundSandboxSeams;
    #projectRoot: string | undefined;
    #unsafeRootReason: string | undefined;
    #denyWrite: readonly string[] = [];
    #denyTemplates: readonly string[] = PACKAGED_DENY_WRITE_TEMPLATES;
    #userEnabled = true;
    #profileDir: string | undefined;

    constructor(seams: ForegroundSandboxSeams = {}) {
        this.#seams = seams;
    }

    /**
     * Capture the canonical launch directory and re-arm protection.
     *
     * Called for every session start reason, which is what keeps a previous
     * `/sandbox off` from surviving a new, resumed, forked, or reloaded session.
     */
    beginSession(cwd: string): ForegroundSandboxStatus {
        const projectRoot = canonicalizePath(cwd, this.#seams);
        this.#projectRoot = projectRoot;
        this.#unsafeRootReason = describeUnsafeProjectRoot(projectRoot, this.#seams);
        this.#denyWrite = Object.freeze(
            this.#unsafeRootReason
                ? []
                : resolveDenyWriteTemplates(this.#denyTemplates, projectRoot, this.#seams),
        );
        this.#userEnabled = true;
        return this.status();
    }

    /** Re-enable protection for operations launched from now on. */
    enable(): ForegroundSandboxStatus {
        this.#userEnabled = true;
        return this.status();
    }

    /** Turn protection off for this session only. Never persisted. */
    disable(): ForegroundSandboxStatus {
        this.#userEnabled = false;
        return this.status();
    }

    /** Whether a human has left protection switched on. */
    isUserEnabled(): boolean {
        return this.#userEnabled;
    }

    /** The deny-write templates currently in force (packaged defaults for now). */
    denyWriteTemplates(): readonly string[] {
        return this.#denyTemplates;
    }

    /**
     * Replace the deny-write template set and recompile it against the current
     * project root. Persistence and validation of user overrides belong to the
     * deny-rule unit; this is the single place a new set takes effect.
     */
    setDenyWriteTemplates(templates: readonly string[]): ForegroundSandboxStatus {
        this.#denyTemplates = Object.freeze([...templates]);
        if (this.#projectRoot !== undefined && this.#unsafeRootReason === undefined) {
            this.#denyWrite = Object.freeze(
                resolveDenyWriteTemplates(this.#denyTemplates, this.#projectRoot, this.#seams),
            );
        }
        return this.status();
    }

    /** The current effective status, recomputed from live runtime evidence. */
    status(): ForegroundSandboxStatus {
        const support = describeSandboxSupport(this.#seams);
        const base = {
            projectRoot: this.#projectRoot,
            denyWrite: this.#denyWrite,
            platform: support.platform,
            readPolicy: "unrestricted",
            networkPolicy: "unrestricted",
        } as const;

        if (this.#projectRoot === undefined) {
            return Object.freeze({
                ...base,
                state: "failed",
                writableRoot: undefined,
                backend: undefined,
                executable: undefined,
                reason: NO_SESSION_REASON,
            });
        }

        if (!this.#userEnabled) {
            return Object.freeze({
                ...base,
                state: "disabled",
                writableRoot: undefined,
                backend: support.supported ? support.backend : undefined,
                executable: support.supported ? support.executable : undefined,
                reason: "A human turned the foreground sandbox off for this session with /sandbox off.",
            });
        }

        if (this.#unsafeRootReason !== undefined) {
            return Object.freeze({
                ...base,
                state: "failed",
                writableRoot: undefined,
                backend: support.supported ? support.backend : undefined,
                executable: support.supported ? support.executable : undefined,
                reason: this.#unsafeRootReason,
            });
        }

        if (!support.supported) {
            return Object.freeze({
                ...base,
                state: "unavailable",
                writableRoot: undefined,
                backend: undefined,
                executable: undefined,
                reason: `${support.reason} ${FOREGROUND_SANDBOX_REMEDY}`,
            });
        }

        return Object.freeze({
            ...base,
            state: "enabled",
            writableRoot: this.#projectRoot,
            backend: support.backend,
            executable: support.executable,
            reason: `Writes are confined to ${this.#projectRoot} by ${support.backend} (${support.executable}).`,
        });
    }

    /**
     * Decide how to launch one protected operation.
     *
     * Returns an unconfined plan only when a human explicitly disabled the
     * sandbox. Every other non-enabled state throws, so a missing or unusable
     * backend blocks the operation rather than silently degrading it.
     */
    requireLaunchPlan(): ForegroundSandboxLaunchPlan {
        const status = this.status();
        if (status.state === "disabled") return { confined: false };
        if (status.state !== "enabled" || status.writableRoot === undefined) {
            throw new ForegroundSandboxBlockedError(status);
        }
        // The generated profiles live in a temp directory, and both backends
        // leave temp writable by design (pi's own tooling needs it). A confined
        // command that could rewrite the profile the next one is launched under
        // would be choosing its own confinement, so the directory holding them
        // is denied to everything the sandbox launches. It stays out of the
        // published status: this is the mechanism protecting itself, not a rule
        // the operator wrote or can remove.
        const profileDir = this.#profileDirectory();
        const policy: SandboxWritePolicy = {
            writableRoot: status.writableRoot,
            denyWrite: Object.freeze([...status.denyWrite, profileDir]),
            home: (this.#seams.home ?? homedir)(),
        };
        return { confined: true, policy, profilePath: this.#profilePathFor(policy) };
    }

    /** Drop the generated profiles this session created. */
    dispose(): void {
        if (this.#profileDir === undefined) return;
        if (this.#seams.createProfileDir === undefined) {
            rmSync(this.#profileDir, { recursive: true, force: true });
        }
        this.#profileDir = undefined;
    }

    /**
     * Name the generated profile after the policy it encodes.
     *
     * Two commands launching concurrently under the same policy write identical
     * bytes to the same path, and a policy change lands on a different path
     * instead of rewriting the profile a starting command is about to read.
     */
    #profilePathFor(policy: SandboxWritePolicy): string {
        const digest = createHash("sha256")
            .update(JSON.stringify([policy.writableRoot, policy.denyWrite, policy.home]))
            .digest("hex")
            .slice(0, 16);
        return join(this.#profileDirectory(), `foreground-${digest}.sb`);
    }

    #profileDirectory(): string {
        this.#profileDir ??= (
            this.#seams.createProfileDir ??
            (() => mkdtempSync(join(tmpdir(), "pi-better-sandbox-")))
        )();
        return this.#profileDir;
    }
}
