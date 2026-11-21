// Generated fixed launch domain from packages/pi-better-sandbox/state.ts. Do not edit directly.
/**
 * Session-local foreground sandbox state.
 *
 * One controller per Pi session owns three things: the canonical project root
 * captured at session start, the persisted default plus session override, and
 * the *effective* status derived from live runtime evidence (which backend this
 * platform actually resolves, not what the package intended).
 *
 * The extension persists permission snapshots in Pi custom entries and restores
 * the active branch after `beginSession` resets this in-memory controller.
 */
import { getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTaskScratch, ensureHarnessRuntimeDirectories, harnessRuntimeDirectories, runtimeCodeRoot, writableRuntimeAlias } from "./shared-task-sandbox.domain.mjs";
import { parseSandboxPermissions } from "./permissions.domain.mjs";
import { canonicalizePath, describeSandboxSupport, } from "./shared-sandbox-core.domain.mjs";
import { describeUnsafeProjectRoot, PACKAGED_DENY_WRITE_TEMPLATES, resolveDenyWriteTemplates, } from "./policy.domain.mjs";
/** Thrown when a protected operation must be blocked instead of run unconfined. */
export class ForegroundSandboxBlockedError extends Error {
    status;
    constructor(status) {
        super(`Foreground sandbox is ${status.state}; this command was blocked rather than run unconfined. ${status.reason}`);
        this.name = "ForegroundSandboxBlockedError";
        this.status = status;
    }
}
/**
 * What an operator can do about a missing backend on a foreground surface.
 *
 * `sandbox:false` is the subagent tool's opt-out and means nothing here; the
 * only lever on a session is the slash command.
 */
export const FOREGROUND_SANDBOX_REMEDY = "Run unconfined on purpose with /sandbox off, or work in a session that has a backend.";
const NO_SESSION_REASON = "No session has started yet, so no canonical project root has been captured.";
export class ForegroundSandboxController {
    #seams;
    #projectRoot;
    #unsafeRootReason;
    #denyWrite = [];
    #denyTemplates = PACKAGED_DENY_WRITE_TEMPLATES;
    #defaultEnabled = false;
    #sessionOverride;
    #profileDir;
    #permissions;
    #policyProblem;
    #runtimePaths = [];
    #taskScratch;
    constructor(seams = {}) {
        this.#seams = seams;
    }
    /**
     * Capture the canonical launch directory and apply the persisted default.
     * The extension then restores any permissions on the active session branch.
     */
    beginSession(cwd, defaultEnabled = false) {
        const projectRoot = canonicalizePath(cwd, this.#seams);
        this.#projectRoot = projectRoot;
        this.#unsafeRootReason = describeUnsafeProjectRoot(projectRoot, this.#seams);
        this.#denyWrite = Object.freeze(this.#unsafeRootReason
            ? []
            : resolveDenyWriteTemplates(this.#denyTemplates, projectRoot, this.#seams));
        this.#defaultEnabled = defaultEnabled;
        this.#sessionOverride = undefined;
        this.#permissions = undefined;
        this.#policyProblem = undefined;
        return this.status();
    }
    /** Re-enable protection for operations launched from now on. */
    enable() {
        this.#sessionOverride = true;
        return this.status();
    }
    /** Turn protection off for this session; persistence belongs to the extension. */
    disable() {
        this.#sessionOverride = false;
        this.#policyProblem = undefined;
        return this.status();
    }
    /** Apply a newly persisted default immediately and clear the session override. */
    applyDefault(defaultEnabled) {
        this.#defaultEnabled = defaultEnabled;
        this.#sessionOverride = undefined;
        return this.status();
    }
    /** Whether a human has left protection switched on. */
    isUserEnabled() {
        return this.#sessionOverride ?? this.#defaultEnabled;
    }
    /** Apply human-selected profiles. Disabled profiles keep their detail values. */
    setPermissionSettings(settings) {
        this.#permissions = parseSandboxPermissions(settings);
        this.#policyProblem = undefined;
        this.#sessionOverride = settings.main.enabled;
        return this.status();
    }
    block(reason) {
        this.#policyProblem = reason;
        return this.status();
    }
    permissionSettings() {
        if (!this.#permissions)
            return undefined;
        return parseSandboxPermissions({
            ...this.#permissions,
            main: { ...this.#permissions.main, enabled: this.isUserEnabled() },
        });
    }
    /** The deny-write templates currently in force (packaged defaults for now). */
    denyWriteTemplates() {
        return this.#denyTemplates;
    }
    /**
     * Replace the deny-write template set and recompile it against the current
     * project root. Persistence and validation of user overrides belong to the
     * deny-rule unit; this is the single place a new set takes effect.
     */
    setDenyWriteTemplates(templates) {
        this.#denyTemplates = Object.freeze([...templates]);
        if (this.#projectRoot !== undefined && this.#unsafeRootReason === undefined) {
            this.#denyWrite = Object.freeze(resolveDenyWriteTemplates(this.#denyTemplates, this.#projectRoot, this.#seams));
        }
        return this.status();
    }
    /** Host-discovered runtime code, never task-supplied permission grants. */
    protectRuntimePaths(paths) {
        this.#runtimePaths = Object.freeze(paths.map((path) => canonicalizePath(path, this.#seams)));
    }
    /** The current effective status, recomputed from live runtime evidence. */
    status() {
        return this.#status("main");
    }
    /** Background launches use their own switch and the same safety checks as Main. */
    backgroundStatus() {
        return this.#status("background");
    }
    #status(profile) {
        const support = describeSandboxSupport(this.#seams);
        const permissions = this.#permissions?.[profile];
        const enabled = profile === "main" ? this.isUserEnabled() : permissions?.enabled ?? this.isUserEnabled();
        const base = {
            projectRoot: this.#projectRoot,
            denyWrite: this.#permissions
                ? Object.freeze([...this.#denyWrite, getAgentDir(), ...harnessRuntimeDirectories(),
                    runtimeCodeRoot(join(getPackageDir(), "dist", "index.js")),
                    dirname(fileURLToPath(import.meta.url)),
                    ...(this.#projectRoot ? [join(this.#projectRoot, ".pi")] : []), ...this.#runtimePaths])
                : this.#denyWrite,
            platform: support.platform,
            readPolicy: enabled && permissions && (permissions.projectFiles === "off" || permissions.outsideProject === "off" || permissions.storedCredentials === "off") ? "restricted" : "unrestricted",
            networkPolicy: enabled && permissions?.network === false ? "blocked" : "unrestricted",
            ...(this.#permissions ? {
                permissions: Object.freeze({ ...this.#permissions[profile], enabled }),
                subagentPermissions: Object.freeze({ ...this.#permissions.subagents }),
                subagentTools: Object.freeze({ applyPatch: this.#permissions.subagentTools.applyPatch,
                    trusted: Object.freeze(this.#permissions.subagentTools.trusted.map((tool) => Object.freeze({ ...tool }))) }),
            } : {}),
        };
        if (this.#policyProblem !== undefined) {
            return Object.freeze({ ...base, state: "failed", writableRoot: undefined,
                backend: support.supported ? support.backend : undefined,
                executable: support.supported ? support.executable : undefined,
                reason: this.#policyProblem });
        }
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
        if (!enabled) {
            const explicitlyDisabled = profile === "background" || this.#sessionOverride === false;
            return Object.freeze({
                ...base,
                state: explicitlyDisabled ? "disabled" : "inactive",
                writableRoot: undefined,
                backend: support.supported ? support.backend : undefined,
                executable: support.supported ? support.executable : undefined,
                reason: profile === "background"
                    ? "The Background tasks sandbox is off. Change it in /sandbox."
                    : explicitlyDisabled
                        ? "A human turned the foreground sandbox off for this session with /sandbox off."
                        : support.supported
                            ? "The foreground sandbox is available but inactive by default. Use /sandbox on for this session or /sandbox default on to persist opt-in."
                            : `The foreground sandbox is inactive by default, and no backend is available: ${support.reason}`,
            });
        }
        if (this.#unsafeRootReason !== undefined) {
            return Object.freeze({ ...base, state: "failed", writableRoot: undefined,
                backend: support.supported ? support.backend : undefined,
                executable: support.supported ? support.executable : undefined,
                reason: this.#unsafeRootReason });
        }
        const projectRoot = this.#projectRoot;
        let runtimeAlias;
        try {
            runtimeAlias = permissions && [getAgentDir(), tmpdir(), getPackageDir()]
                .map((path) => writableRuntimeAlias(path, projectRoot, permissions, true)).find(Boolean);
        }
        catch (error) {
            return Object.freeze({ ...base, state: "failed", writableRoot: undefined,
                backend: support.supported ? support.backend : undefined,
                executable: support.supported ? support.executable : undefined,
                reason: `Runtime compatibility discovery failed: ${error instanceof Error ? error.message : String(error)}` });
        }
        if (runtimeAlias) {
            return Object.freeze({ ...base, state: "failed", writableRoot: undefined,
                backend: support.supported ? support.backend : undefined,
                executable: support.supported ? support.executable : undefined,
                reason: `A Pi runtime directory uses a task-writable symlink (${runtimeAlias}). Restart Pi with canonical runtime, PI_CODING_AGENT_DIR, and TMPDIR paths before enabling confinement.` });
        }
        if (!support.supported) {
            return Object.freeze({
                ...base,
                state: "unavailable",
                writableRoot: undefined,
                backend: undefined,
                executable: undefined,
                reason: `${support.reason} ${profile === "main" ? FOREGROUND_SANDBOX_REMEDY
                    : "Turn Background tasks off in /sandbox to run unconfined, or use a session that has a backend."}`,
            });
        }
        return Object.freeze({
            ...base,
            state: "enabled",
            writableRoot: this.#projectRoot,
            backend: support.backend,
            executable: support.executable,
            reason: this.#permissions
                ? `Sandbox permissions are enforced by ${support.backend} (${support.executable}) for ${this.#projectRoot}.`
                : `Writes are confined to ${this.#projectRoot} by ${support.backend} (${support.executable}).`,
        });
    }
    /**
     * Decide how to launch one protected operation.
     *
     * Returns an unconfined plan while the sandbox is inactive or explicitly
     * disabled. Once enabled, missing or unusable backends fail closed.
     */
    requireLaunchPlan() {
        const status = this.status();
        if (status.state === "inactive" || status.state === "disabled")
            return { confined: false };
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
        ensureHarnessRuntimeDirectories();
        this.#taskScratch ??= createTaskScratch();
        const policy = {
            writableRoot: status.writableRoot,
            denyWrite: Object.freeze([...status.denyWrite, profileDir, this.#taskScratch.anchor]),
            runtimeCompatibility: true,
            runtimeWrite: Object.freeze([this.#taskScratch.path]),
            home: (this.#seams.home ?? homedir)(),
            ...(status.permissions ? { permissions: status.permissions } : {}),
        };
        return { confined: true, policy, profilePath: this.#profilePathFor(policy) };
    }
    /** Drop the generated profiles this session created. */
    dispose() {
        if (this.#taskScratch) {
            rmSync(this.#taskScratch.path, { recursive: true, force: true });
            this.#taskScratch = undefined;
        }
        if (this.#profileDir === undefined)
            return;
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
    #profilePathFor(policy) {
        const digest = createHash("sha256")
            .update(JSON.stringify(policy))
            .digest("hex")
            .slice(0, 16);
        return join(this.#profileDirectory(), `foreground-${digest}.sb`);
    }
    #profileDirectory() {
        this.#profileDir ??= (this.#seams.createProfileDir ??
            (() => mkdtempSync(join(tmpdir(), "pi-better-sandbox-"))))();
        return this.#profileDir;
    }
}
