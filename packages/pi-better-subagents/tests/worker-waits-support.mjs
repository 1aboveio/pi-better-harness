/**
 * Test harness that runs the ACTUAL modules together:
 *
 * - the real Background observed-waits host (`src/observed-waits.ts`), opening
 *   the real coordinator store and using the real local supervisor,
 * - the real Background tool registrations (production schemas),
 * - the real Subagents bridge host from `worker-waits.ts`, resolving the
 *   published service and its request/reply fence over the event bus,
 * - real child subprocesses using the real child bridge client and the shared
 *   `park-checkpoint.ts` capture helper.
 *
 * Nothing here fakes a wait phase, claim, checkpoint, park disposition or task
 * result. Only the Goal gate and the continuation launcher are injected, because
 * those are the seams the production code calls out to.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerTools } from "../../pi-better-background-tasks/src/tools.ts";
import { createObservedWaitHost } from "../../pi-better-background-tasks/src/observed-waits.ts";
import { openStore } from "../../operation-coordinator/index.ts";
import {
    childBridgeExtensionPath,
    createWorkerOperationsHost,
    planWorkerBridgeTools,
    resolveProductionSchemas,
} from "../worker-waits.ts";

export const WORKER_CONVERSATION = "conversation-worker-1";

/** A Pi-shaped object: an event bus plus the tool inventory Background publishes. */
export function createPiStub() {
    const events = new EventEmitter();
    const tools = new Map();
    const pi = {
        events,
        registerTool(definition) {
            tools.set(definition.name, {
                name: definition.name,
                label: definition.label,
                description: definition.description,
                parameters: definition.parameters,
                sourceInfo: { path: join(process.cwd(), "packages/pi-better-background-tasks/src/tools.ts") },
            });
            return definition;
        },
        registerCommand() { return () => {}; },
        on() { return () => {}; },
        getAllTools: () => [...tools.values()],
        getActiveTools: () => [...tools.keys()],
        setActiveTools() {},
        appendEntry() {},
        getAllCommands: () => [],
        sendMessage() {},
        ui: { notify() {} },
    };
    // Production schemas: Background registers its real tool definitions.
    registerTools(pi);
    return { pi, events, tools };
}

export function createCtx(cwd, sessionId = "parent-session-1", branchId = "branch-1") {
    return {
        cwd,
        sessionManager: {
            getSessionId: () => sessionId,
            getBranch: () => [{ id: branchId }],
        },
        isIdle: () => true,
        model: undefined,
        modelRegistry: undefined,
    };
}

let cleanupId = 0;
const cleanups = [];

export function tempDirectory(prefix) {
    const directory = mkdtempSync(join(tmpdir(), `${prefix}-${cleanupId++}-`));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
    return directory;
}

export function cleanupAll() {
    while (cleanups.length > 0) {
        try { cleanups.pop()(); } catch { /* best effort */ }
    }
}

/**
 * Start the real stack: Background host (real store + supervisor) and the
 * Subagents bridge host. Returns the shared store handle for durable assertions.
 */
export async function startStack(options = {}) {
    const root = tempDirectory("observed-stack");
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const { pi, events, tools } = createPiStub();
    const storePath = join(root, "operations.sqlite");
    const supervisorDirectory = join(root, "supervisor");
    const notifications = [];
    const host = createObservedWaitHost(pi, {
        storePath,
        supervisorDirectory,
        pollMs: 0,
        notifyParent: (notification) => notifications.push(notification),
    });
    const ctx = createCtx(workspace);
    host.start(ctx);
    const service = host.service;
    const packageRoot = fileURLToPath(new URL("../", import.meta.url));
    const bridge = createWorkerOperationsHost({ pi, childExtensionPath: childBridgeExtensionPath(packageRoot) });
    const started = await bridge.start();
    cleanupOnExit(() => {
        bridge.close();
        host.close();
    });
    // A read handle on the same database, for durable assertions only.
    const store = openStore({ path: storePath });
    cleanups.push(() => { try { store.close(); } catch { /* closed */ } });
    return { root, workspace, pi, events, tools, host, service, bridge, store, ctx, notifications, started, storePath };
}

function cleanupOnExit(fn) {
    cleanups.push(() => { void fn(); });
}

/** The six bridge tool names a default worker gets. */
export function defaultPlan() {
    return planWorkerBridgeTools({
        allow: ["read", "write", "bash"],
        excluded: [],
        clean: false,
        explicitTools: false,
    });
}

export function schemasFor(pi, tools) {
    const resolved = resolveProductionSchemas(pi, tools);
    return tools.map((name) => resolved.schemas.get(name)).filter(Boolean);
}

export function writeCoherentLog(path) {
    writeFileSync(path, [
        JSON.stringify({ type: "agent_start" }),
        JSON.stringify({ type: "agent_end" }),
        JSON.stringify({ type: "agent_settled" }),
        "",
    ].join("\n"));
}

let childIndex = 0;
/** A per-attempt native-session fixture directory under the durable root. */
export function sessionFixture(durableRoot, sessionId) {
    const sessionDirectory = join(durableRoot, "sessions", sessionId);
    mkdirSync(sessionDirectory, { recursive: true });
    return { sessionDirectory, sessionFile: join(sessionDirectory, `${randomUUID()}_${sessionId}.jsonl`) };
}
