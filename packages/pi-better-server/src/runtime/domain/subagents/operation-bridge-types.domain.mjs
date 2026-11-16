// Generated fixed launch domain from packages/pi-better-subagents/operation-bridge-types.ts. Do not edit directly.
/**
 * Shared contracts for the trusted parent-hosted worker operation bridge.
 *
 * The bridge is a local transport, not a permission system. The host validates
 * transport identity, request shape and the run's task ownership callback, then
 * invokes injectable handlers. Those handlers must intersect the worker's task
 * authority with the current Background profile; this module deliberately does
 * not implement or claim that authorization decision.
 *
 * No function in this module reads credentials from a request body. The only
 * secret is the per-run bearer token, which is compared by hash and never
 * copied into a result, wait record, checkpoint or diagnostic event.
 */
import { createHash, randomBytes } from "node:crypto";
import { resolve, sep } from "node:path";
export const OPERATION_BRIDGE_VERSION = 1;
/** Parent-to-child environment. The child uses these instead of reading the parent process. */
export const OPERATIONS_ENABLED_ENV = "PI_BETTER_OPERATIONS_ENABLED";
export const OPERATIONS_ENDPOINT_ENV = "PI_BETTER_OPERATIONS_ENDPOINT";
export const OPERATIONS_TOKEN_ENV = "PI_BETTER_OPERATIONS_TOKEN";
export const OPERATIONS_RUN_ID_ENV = "PI_BETTER_OPERATIONS_RUN_ID";
export const OPERATIONS_CONVERSATION_ID_ENV = "PI_BETTER_OPERATIONS_CONVERSATION_ID";
export const OPERATIONS_ATTEMPT_ID_ENV = "PI_BETTER_OPERATIONS_ATTEMPT_ID";
export const OPERATIONS_WRITER_LEASE_ID_ENV = "PI_BETTER_OPERATIONS_WRITER_LEASE_ID";
export const OPERATIONS_CHILD_ID_ENV = "PI_BETTER_OPERATIONS_CHILD_ID";
/**
 * Parent-provided bridge environment. A launched background task must not
 * inherit any of these names: the token authorizes this child, not a shell it
 * starts. The host rejects them in request bodies and result details; the
 * parent must also strip them from the environment it passes to a spawned task.
 */
export const OPERATION_BRIDGE_ENV_KEYS = Object.freeze([
    OPERATIONS_ENABLED_ENV,
    OPERATIONS_ENDPOINT_ENV,
    OPERATIONS_TOKEN_ENV,
    OPERATIONS_RUN_ID_ENV,
    OPERATIONS_CONVERSATION_ID_ENV,
    OPERATIONS_ATTEMPT_ID_ENV,
    OPERATIONS_WRITER_LEASE_ID_ENV,
    OPERATIONS_CHILD_ID_ENV,
]);
const BRIDGE_ENV_KEY_SET = new Set(OPERATION_BRIDGE_ENV_KEYS);
export function findBridgeEnvironmentKey(value, seen = new Set()) {
    if (!value || typeof value !== "object")
        return undefined;
    if (seen.has(value))
        return undefined;
    seen.add(value);
    if (Array.isArray(value)) {
        for (const entry of value) {
            const found = findBridgeEnvironmentKey(entry, seen);
            if (found)
                return found;
        }
        return undefined;
    }
    for (const [key, entry] of Object.entries(value)) {
        if (BRIDGE_ENV_KEY_SET.has(key))
            return key;
        const found = findBridgeEnvironmentKey(entry, seen);
        if (found)
            return found;
    }
    return undefined;
}
/** Tools a child may expose. An endpoint cannot add names outside this list. */
export const OPERATION_BRIDGE_TOOL_NAMES = [
    "bg_task_spawn",
    "bg_task_watch",
    "bg_task_status",
    "bg_task_log",
    "wait_for_operations",
    "acknowledge_operation_result",
    "report_assignment_result",
];
/** Tools whose successful call starts one physical operation and therefore needs replay idempotency. */
export const OPERATION_LAUNCH_TOOL_NAMES = ["bg_task_spawn", "bg_task_watch"];
export const WAIT_OPERATIONS_TOOL = "wait_for_operations";
export const ACKNOWLEDGE_OPERATION_TOOL = "acknowledge_operation_result";
export const OPERATION_BRIDGE_METHODS = [
    "handshake",
    "ping",
    "checkpoint",
    "park_failed",
    "close",
    ...OPERATION_BRIDGE_TOOL_NAMES,
];
export class OperationBridgeError extends Error {
    code;
    retryable;
    constructor(code, message, retryable = false) {
        super(message);
        this.name = "OperationBridgeError";
        this.code = code;
        this.retryable = retryable;
    }
}
/** A handler may throw this to return a model-facing tool error without exposing an internal stack. */
export class OperationToolError extends Error {
    code;
    constructor(message, code = "tool-error") {
        super(message);
        this.name = "OperationToolError";
        this.code = code;
    }
}
export function isOperationBridgeError(error) {
    return error instanceof OperationBridgeError;
}
export function generateOperationBridgeToken() {
    return randomBytes(32).toString("base64url");
}
export function hashOperationBridgeToken(token) {
    return createHash("sha256").update(token, "utf8").digest();
}
/** Deterministic JSON used for fingerprints. Objects with `undefined` are not accepted. */
export function canonicalJson(value) {
    return JSON.stringify(sortJson(value));
}
function sortJson(value) {
    if (value === null || typeof value !== "object")
        return value;
    if (Array.isArray(value))
        return value.map(sortJson);
    const source = value;
    const out = {};
    for (const key of Object.keys(source).sort()) {
        const entry = source[key];
        if (entry !== undefined)
            out[key] = sortJson(entry);
    }
    return out;
}
export function descriptorFingerprint(tools, capabilities) {
    return createHash("sha256")
        .update(canonicalJson({
        bridgeVersion: OPERATION_BRIDGE_VERSION,
        tools: [...tools].sort((a, b) => a.name.localeCompare(b.name)),
        capabilities,
    }), "utf8")
        .digest("hex");
}
const IGNORED_SCHEMA_KEYWORDS = new Set([
    "$schema", "$id", "$comment", "title", "description", "default", "examples", "deprecated",
    "readOnly", "writeOnly", "format", "contentMediaType", "contentEncoding",
]);
function valueFailure(path, message) {
    return { ok: false, path, message };
}
function schemaFailure(path, message) {
    return { ok: false, path, message, schemaError: true };
}
const SUPPORTED_SCHEMA_KEYWORDS = new Set([
    "type", "const", "enum", "allOf", "anyOf", "oneOf", "not", "minLength", "maxLength", "pattern",
    "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minItems", "maxItems", "uniqueItems",
    "items", "required", "properties", "additionalProperties", "minProperties", "maxProperties",
]);
/**
 * Preflight the whole schema, including branches a particular value would not
 * visit. Without this, `{not:{properties:{x:{$ref:...}}}}` with `{}` could pass
 * because the unsupported subschema was never selected.
 */
function scanSchemaSupport(schema, path) {
    if (schema === true || schema === undefined || schema === false)
        return { ok: true };
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
        return schemaFailure(path, "schema is not an object");
    }
    const spec = schema;
    for (const key of Object.keys(spec)) {
        if (IGNORED_SCHEMA_KEYWORDS.has(key) || SUPPORTED_SCHEMA_KEYWORDS.has(key))
            continue;
        return schemaFailure(path, `unsupported schema keyword ${key}`);
    }
    if (typeof spec.pattern === "string") {
        try {
            new RegExp(spec.pattern);
        }
        catch {
            return schemaFailure(path, "schema pattern is invalid");
        }
    }
    if (spec.required !== undefined && !Array.isArray(spec.required)) {
        return schemaFailure(path, "required must be an array");
    }
    if (spec.enum !== undefined && !Array.isArray(spec.enum)) {
        return schemaFailure(path, "enum must be an array");
    }
    if (spec.type !== undefined) {
        const types = Array.isArray(spec.type) ? spec.type : [spec.type];
        const known = new Set(["object", "array", "string", "integer", "number", "boolean", "null"]);
        if (types.some((type) => typeof type !== "string" || !known.has(type))) {
            return schemaFailure(path, "schema type is unsupported");
        }
    }
    for (const key of ["allOf", "anyOf", "oneOf"]) {
        if (spec[key] === undefined)
            continue;
        if (!Array.isArray(spec[key]))
            return schemaFailure(path, `${key} must be an array`);
        for (const [index, sub] of spec[key].entries()) {
            const result = scanSchemaSupport(sub, `${path}/${key}/${index}`);
            if (!result.ok)
                return result;
        }
    }
    if (spec.not !== undefined) {
        const result = scanSchemaSupport(spec.not, `${path}/not`);
        if (!result.ok)
            return result;
    }
    if (spec.items !== undefined) {
        if (Array.isArray(spec.items))
            return schemaFailure(path, "tuple items are unsupported");
        const result = scanSchemaSupport(spec.items, `${path}/items`);
        if (!result.ok)
            return result;
    }
    if (spec.properties !== undefined) {
        if (!spec.properties || typeof spec.properties !== "object" || Array.isArray(spec.properties)) {
            return schemaFailure(path, "properties must be an object");
        }
        for (const [key, sub] of Object.entries(spec.properties)) {
            const result = scanSchemaSupport(sub, `${path}/properties/${key}`);
            if (!result.ok)
                return result;
        }
    }
    if (spec.additionalProperties !== undefined && spec.additionalProperties !== true && spec.additionalProperties !== false) {
        const result = scanSchemaSupport(spec.additionalProperties, `${path}/additionalProperties`);
        if (!result.ok)
            return result;
    }
    return { ok: true };
}
/** Checks schema support without requiring a value, so bad descriptors fail early. */
export function validateJsonSchemaSupport(schema) {
    return scanSchemaSupport(schema, "$");
}
/**
 * A deliberately small JSON Schema subset. It covers the TypeBox schemas the
 * parent hands over without importing TypeBox into the child and without ever
 * evaluating code from an endpoint. Unsupported keywords that can change
 * acceptance are refused instead of being treated as permissive.
 *
 * A `schemaError` result means the validator could not understand part of the
 * schema. It must never be treated as "the value did not match this branch";
 * composition keywords propagate it so an unsupported subschema cannot make a
 * value pass.
 */
export function validateJsonSchema(schema, value, path = "$") {
    const support = scanSchemaSupport(schema, path);
    if (!support.ok)
        return support;
    if (schema === true || schema === undefined)
        return { ok: true };
    if (schema === false)
        return valueFailure(path, "value is not allowed");
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
        return schemaFailure(path, "schema is not an object");
    }
    const spec = schema;
    for (const key of ["$ref", "if", "then", "else", "dependentSchemas", "patternProperties", "propertyNames"]) {
        if (key in spec)
            return schemaFailure(path, `unsupported schema keyword ${key}`);
    }
    if ("const" in spec && canonicalJson(value) !== canonicalJson(spec.const)) {
        return valueFailure(path, "value does not match const");
    }
    if (Array.isArray(spec.enum)) {
        const encoded = canonicalJson(value);
        if (!spec.enum.some((entry) => canonicalJson(entry) === encoded)) {
            return valueFailure(path, "value is not in enum");
        }
    }
    if (Array.isArray(spec.allOf)) {
        for (const [index, sub] of spec.allOf.entries()) {
            const result = validateJsonSchema(sub, value, `${path}/allOf/${index}`);
            if (!result.ok)
                return result;
        }
    }
    if (Array.isArray(spec.anyOf)) {
        const results = spec.anyOf.map((sub, index) => validateJsonSchema(sub, value, `${path}/anyOf/${index}`));
        const unsupported = results.find((result) => !result.ok && result.schemaError);
        if (unsupported)
            return unsupported;
        if (!results.some((result) => result.ok)) {
            return valueFailure(path, "value matches none of anyOf");
        }
    }
    if (Array.isArray(spec.oneOf)) {
        const results = spec.oneOf.map((sub, index) => validateJsonSchema(sub, value, `${path}/oneOf/${index}`));
        const unsupported = results.find((result) => !result.ok && result.schemaError);
        if (unsupported)
            return unsupported;
        if (results.filter((result) => result.ok).length !== 1) {
            return valueFailure(path, "value must match exactly one oneOf branch");
        }
    }
    if (spec.not !== undefined) {
        const forbidden = validateJsonSchema(spec.not, value, `${path}/not`);
        if (!forbidden.ok && forbidden.schemaError)
            return forbidden;
        if (forbidden.ok)
            return valueFailure(path, "value matches the forbidden schema");
    }
    if (spec.type !== undefined) {
        const types = Array.isArray(spec.type) ? spec.type : [spec.type];
        if (!types.some((type) => typeof type === "string" && matchesJsonType(type, value))) {
            return valueFailure(path, `expected ${types.join(" or ")}`);
        }
    }
    if (typeof value === "string") {
        if (typeof spec.minLength === "number" && value.length < spec.minLength) {
            return valueFailure(path, `shorter than ${spec.minLength}`);
        }
        if (typeof spec.maxLength === "number" && value.length > spec.maxLength) {
            return valueFailure(path, `longer than ${spec.maxLength}`);
        }
        if (typeof spec.pattern === "string") {
            let pattern;
            try {
                pattern = new RegExp(spec.pattern);
            }
            catch {
                return schemaFailure(path, "schema pattern is invalid");
            }
            if (!pattern.test(value))
                return valueFailure(path, "does not match pattern");
        }
    }
    if (typeof value === "number") {
        if (typeof spec.minimum === "number" && value < spec.minimum) {
            return valueFailure(path, `less than ${spec.minimum}`);
        }
        if (typeof spec.maximum === "number" && value > spec.maximum) {
            return valueFailure(path, `greater than ${spec.maximum}`);
        }
        if (typeof spec.exclusiveMinimum === "number" && value <= spec.exclusiveMinimum) {
            return valueFailure(path, `not greater than ${spec.exclusiveMinimum}`);
        }
        if (typeof spec.exclusiveMaximum === "number" && value >= spec.exclusiveMaximum) {
            return valueFailure(path, `not less than ${spec.exclusiveMaximum}`);
        }
    }
    if (Array.isArray(value)) {
        if (typeof spec.minItems === "number" && value.length < spec.minItems) {
            return valueFailure(path, `fewer than ${spec.minItems} items`);
        }
        if (typeof spec.maxItems === "number" && value.length > spec.maxItems) {
            return valueFailure(path, `more than ${spec.maxItems} items`);
        }
        if (spec.uniqueItems === true) {
            const seen = new Set(value.map((entry) => canonicalJson(entry)));
            if (seen.size !== value.length)
                return valueFailure(path, "items are not unique");
        }
        if (spec.items !== undefined) {
            for (const [index, item] of value.entries()) {
                const result = validateJsonSchema(spec.items, item, `${path}/${index}`);
                if (!result.ok)
                    return result;
            }
        }
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const object = value;
        if (Array.isArray(spec.required)) {
            for (const key of spec.required) {
                if (typeof key === "string" && !Object.prototype.hasOwnProperty.call(object, key)) {
                    return valueFailure(`${path}/${key}`, "is required");
                }
            }
        }
        const properties = spec.properties && typeof spec.properties === "object" && !Array.isArray(spec.properties)
            ? spec.properties
            : undefined;
        if (properties) {
            for (const [key, subschema] of Object.entries(properties)) {
                if (!Object.prototype.hasOwnProperty.call(object, key))
                    continue;
                const result = validateJsonSchema(subschema, object[key], `${path}/${key}`);
                if (!result.ok)
                    return result;
            }
        }
        const additional = spec.additionalProperties;
        if (additional === false) {
            for (const key of Object.keys(object)) {
                if (!properties || !Object.prototype.hasOwnProperty.call(properties, key)) {
                    return valueFailure(`${path}/${key}`, "is not an allowed property");
                }
            }
        }
        else if (additional && typeof additional === "object") {
            for (const key of Object.keys(object)) {
                if (properties && Object.prototype.hasOwnProperty.call(properties, key))
                    continue;
                const result = validateJsonSchema(additional, object[key], `${path}/${key}`);
                if (!result.ok)
                    return result;
            }
        }
        if (typeof spec.minProperties === "number" && Object.keys(object).length < spec.minProperties) {
            return valueFailure(path, `fewer than ${spec.minProperties} properties`);
        }
        if (typeof spec.maxProperties === "number" && Object.keys(object).length > spec.maxProperties) {
            return valueFailure(path, `more than ${spec.maxProperties} properties`);
        }
    }
    for (const key of Object.keys(spec)) {
        if (IGNORED_SCHEMA_KEYWORDS.has(key))
            continue;
        if ([
            "type", "const", "enum", "allOf", "anyOf", "oneOf", "not", "minLength", "maxLength", "pattern",
            "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minItems", "maxItems", "uniqueItems",
            "items", "required", "properties", "additionalProperties", "minProperties", "maxProperties",
        ].includes(key))
            continue;
        // A descriptor from a newer production schema must not silently weaken validation.
        return schemaFailure(path, `unsupported schema keyword ${key}`);
    }
    return { ok: true };
}
function matchesJsonType(type, value) {
    switch (type) {
        case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
        case "array": return Array.isArray(value);
        case "string": return typeof value === "string";
        case "integer": return typeof value === "number" && Number.isInteger(value);
        case "number": return typeof value === "number" && Number.isFinite(value);
        case "boolean": return typeof value === "boolean";
        case "null": return value === null;
        default: return false;
    }
}
// ---- canonical tool schemas -------------------------------------------------
const string = (extra = {}) => ({ type: "string", ...extra });
const object = (properties, required = [], extra = {}) => ({
    type: "object",
    additionalProperties: false,
    ...(required.length ? { required } : {}),
    properties,
    ...extra,
});
const LOOSE_BACKGROUND_SCHEMA = { type: "object", additionalProperties: true };
export const WAIT_FOR_OPERATIONS_SCHEMA = object({
    task_ids: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: string({ minLength: 1, maxLength: 128 }),
    },
    continuation_note: string({ minLength: 1, maxLength: 2_000 }),
}, ["task_ids", "continuation_note"]);
export const ACKNOWLEDGE_OPERATION_RESULT_SCHEMA = object({
    wait_id: string({ minLength: 1, maxLength: 128 }),
    generation: { type: "integer", minimum: 1 },
    terminal_revisions: {
        anyOf: [
            {
                type: "array",
                minItems: 1,
                maxItems: 100,
                items: object({
                    task_id: string({ minLength: 1, maxLength: 128 }),
                    operation_id: string({ minLength: 1, maxLength: 128 }),
                    revision: { type: "integer", minimum: 1 },
                }, ["operation_id", "revision"]),
            },
            {
                type: "object",
                additionalProperties: { type: "integer", minimum: 1 },
            },
        ],
    },
    disposition: { type: "string", enum: ["continue", "blocked", "assignment-complete"] },
    note: string({ maxLength: 4_000 }),
}, ["wait_id", "generation", "terminal_revisions", "disposition", "note"]);
export const CHECKPOINT_SCHEMA = object({
    wait_id: string({ minLength: 1, maxLength: 128 }),
    generation: { type: "integer", minimum: 1 },
    tool_call_id: string({ minLength: 1, maxLength: 256 }),
    attempt_id: string({ minLength: 1, maxLength: 256 }),
    writer_lease_id: string({ minLength: 1, maxLength: 256 }),
    evidence: object({
        version: { type: "integer", const: 1 },
        sessionId: string({ minLength: 1, maxLength: 256 }),
        sessionFile: string({ minLength: 1, maxLength: 4_096 }),
        toolCallId: string({ minLength: 1, maxLength: 256 }),
        waitId: string({ minLength: 1, maxLength: 128 }),
        generation: { type: "integer", minimum: 1 },
        entryId: string({ minLength: 1, maxLength: 256 }),
        prefixBytes: { type: "integer", minimum: 1 },
        prefixSha256: string({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }),
    }, ["version", "sessionId", "sessionFile", "toolCallId", "waitId", "generation", "entryId", "prefixBytes", "prefixSha256"]),
}, ["wait_id", "generation", "tool_call_id", "evidence"]);
export const PARK_FAILED_SCHEMA = object({
    wait_id: string({ minLength: 1, maxLength: 128 }),
    generation: { type: "integer", minimum: 1 },
    reason: string({ minLength: 1, maxLength: 2_000 }),
}, ["wait_id", "generation", "reason"]);
const HANDSHAKE_SCHEMA = object({
    bridge_version: { type: "integer", const: OPERATION_BRIDGE_VERSION },
    client: object({
        name: string({ minLength: 1, maxLength: 128 }),
        version: string({ minLength: 1, maxLength: 128 }),
    }, [], { additionalProperties: true }),
}, ["bridge_version"]);
export function canonicalToolSchema(name) {
    switch (name) {
        case "report_assignment_result": return {
            type: "object", additionalProperties: false, required: ["status", "reason", "evidence"],
            properties: {
                status: { type: "string", enum: ["complete", "incomplete"] },
                reason: { type: "string", minLength: 1, maxLength: 2048 },
                remaining_work: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", minLength: 1, maxLength: 1024 }, description: "For incomplete work, list the concrete steps still required." },
                blocker: { type: "object", additionalProperties: false, required: ["kind", "reason"], properties: {
                        kind: { type: "string", enum: ["permission", "external-input"] },
                        reason: { type: "string", minLength: 1, maxLength: 1024 },
                    }, description: "Use only for an actual permission or external-input blocker that prevents further local work." },
                evidence: { type: "array", minItems: 1, maxItems: 4, items: {
                        type: "object", additionalProperties: false, required: ["path", "explanation"],
                        properties: {
                            path: { type: "string", minLength: 1, maxLength: 1024, description: "An existing workspace file. Foreign paths and credential files are refused." },
                            explanation: { type: "string", minLength: 1, maxLength: 1024 },
                            offset: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Zero-based byte offset, inclusive. Requires max_bytes." },
                            max_bytes: { type: "integer", minimum: 1, maximum: 65536, description: "Retain at most this many bytes from offset (default zero), ending at EOF if earlier. Required for files larger than 65536 bytes." },
                        },
                    } },
            },
        };
        case "wait_for_operations": return WAIT_FOR_OPERATIONS_SCHEMA;
        case "acknowledge_operation_result": return ACKNOWLEDGE_OPERATION_RESULT_SCHEMA;
        default: return LOOSE_BACKGROUND_SCHEMA;
    }
}
const TOOL_LABELS = {
    report_assignment_result: "Report Assignment Result",
    bg_task_spawn: "BG Spawn",
    bg_task_watch: "BG Watch",
    bg_task_status: "BG Status",
    bg_task_log: "BG Log",
    wait_for_operations: "Wait for Operations",
    acknowledge_operation_result: "Acknowledge Operation Result",
};
const TOOL_DESCRIPTIONS = {
    report_assignment_result: "Record your complete or incomplete assignment judgment with retained workspace file evidence before your final answer. Each retained file or explicit byte excerpt is limited to 65536 bytes; use offset and max_bytes for larger source files. A refused report may be corrected and retried. Once retained, only identical retries are allowed. Reporting does not terminalize the assignment, interpret waits or record parent acceptance.",
    bg_task_spawn: "Start one long-running background operation through the trusted parent supervisor. Returns immediately. The operation is owned by the parent, not by this worker process.",
    bg_task_watch: "Start one background command watch through the trusted parent supervisor. Returns immediately. The operation is owned by the parent, not by this worker process.",
    bg_task_status: "Inspect one operation owned by this worker conversation. Only task ids accepted by the parent ownership check are readable.",
    bg_task_log: "Read the retained log of one operation owned by this worker conversation. Only task ids accepted by the parent ownership check are readable.",
    wait_for_operations: "Register an all-settled wait on operations owned by this conversation. A settled result returns evidence and keeps this attempt running; an unsettled result parks the worker only after the parent certifies the saved tool result.",
    acknowledge_operation_result: "Interpret the exact terminal evidence of a registered wait and mark that wait generation consumed. The disposition does not complete the assignment by itself.",
};
const TOOL_GUIDELINES = {
    report_assignment_result: ["Continue available local work until the assignment is complete or a concrete blocker prevents progress. For incomplete work, provide remaining_work and any actual permission or external-input blocker. If evidence is refused, correct the path or excerpt range and retry before returning."],
    bg_task_spawn: ["Use bg_task_spawn for established long commands; do not emulate background execution with polling, sleep loops, nohup or shell detachment."],
    bg_task_watch: ["Use bg_task_watch for repeated observation. Do not run a foreground poll loop."],
    wait_for_operations: ["Call wait_for_operations only when no independent work remains. A final answer that says you are waiting is not a park request."],
};
export function createToolDescriptor(name, overrides = {}) {
    // The wait/acknowledge schemas are fixed here; a parent descriptor may not
    // loosen the contract that decides when a worker parks or consumes evidence.
    const parameters = name === WAIT_OPERATIONS_TOOL || name === ACKNOWLEDGE_OPERATION_TOOL || name === "report_assignment_result"
        ? canonicalToolSchema(name)
        : (overrides.parameters ?? canonicalToolSchema(name));
    return deepFreeze({
        name,
        label: overrides.label ?? TOOL_LABELS[name],
        description: overrides.description ?? TOOL_DESCRIPTIONS[name],
        parameters: cloneJson(parameters),
        ...(overrides.promptGuidelines ? { promptGuidelines: [...overrides.promptGuidelines] } : TOOL_GUIDELINES[name] ? { promptGuidelines: [...TOOL_GUIDELINES[name]] } : {}),
        ...(overrides.promptSnippet ? { promptSnippet: overrides.promptSnippet } : {}),
    });
}
export function descriptorsForCapabilities(capabilities) {
    return deepFreeze([
        ...(capabilities.reportAssignment === true ? [createToolDescriptor("report_assignment_result")] : []),
        ...(capabilities.background.spawn ? [createToolDescriptor("bg_task_spawn")] : []),
        ...(capabilities.background.watch ? [createToolDescriptor("bg_task_watch")] : []),
        ...(capabilities.background.status ? [createToolDescriptor("bg_task_status")] : []),
        ...(capabilities.background.log ? [createToolDescriptor("bg_task_log")] : []),
        ...(capabilities.wait && capabilities.parking ? [createToolDescriptor("wait_for_operations")] : []),
        ...(capabilities.acknowledge ? [createToolDescriptor("acknowledge_operation_result")] : []),
    ]);
}
/**
 * Validates and freezes a descriptor set. Unknown tool names are a handshake
 * failure, not a reason to expose an extra tool.
 */
export function normalizeToolDescriptors(tools, capabilities) {
    const seen = new Set();
    const normalized = [];
    for (const tool of tools) {
        if (!OPERATION_BRIDGE_TOOL_NAMES.includes(tool.name)) {
            throw new OperationBridgeError("invalid-request", `Unknown bridge tool ${String(tool.name)}`);
        }
        if (seen.has(tool.name))
            throw new OperationBridgeError("invalid-request", `Duplicate bridge tool ${tool.name}`);
        seen.add(tool.name);
        const allowed = capabilityForTool(tool.name, capabilities);
        if (!allowed)
            throw new OperationBridgeError("invalid-request", `${tool.name} is not enabled by the run capabilities`);
        normalized.push(createToolDescriptor(tool.name, tool));
    }
    // A capability without a descriptor would let the child believe a tool
    // exists while the host rejects it. Reject the inconsistent registration.
    for (const name of OPERATION_BRIDGE_TOOL_NAMES) {
        if (!seen.has(name) && capabilityForTool(name, capabilities)) {
            throw new OperationBridgeError("invalid-request", `${name} is enabled but has no descriptor`);
        }
    }
    return deepFreeze(normalized.sort((a, b) => a.name.localeCompare(b.name)));
}
export function capabilityForTool(name, capabilities) {
    switch (name) {
        case "report_assignment_result": return capabilities.reportAssignment === true;
        case "bg_task_spawn": return capabilities.background.spawn;
        case "bg_task_watch": return capabilities.background.watch;
        case "bg_task_status": return capabilities.background.status;
        case "bg_task_log": return capabilities.background.log;
        case "wait_for_operations": return capabilities.wait && capabilities.parking;
        case "acknowledge_operation_result": return capabilities.acknowledge;
        default: return false;
    }
}
export function createBridgeDescriptor(runId, conversationId, tools, capabilities, limits) {
    return deepFreeze({
        bridgeVersion: OPERATION_BRIDGE_VERSION,
        fingerprint: descriptorFingerprint(tools, capabilities),
        runId,
        conversationId,
        tools: [...tools],
        capabilities: deepFreezeCopy(capabilities),
        limits: { ...limits },
    });
}
// ---- identity, authority and task helpers -------------------------------------------------
const AUTHORITY_FIELDS = new Set([
    "run_id", "runId", "conversation_id", "conversationId", "owner", "owner_id", "ownerId",
    "session_id", "sessionId", "endpoint", "token", "access_token", "accessToken",
    "capabilities", "authority", "authority_reference", "authorityReference",
    "permissions", "permission", "parent", "parent_id", "parentId", "child_id", "childId",
    "workspace_root", "workspaceRoot",
]);
/** Caller fields that would override parent-owned authority are refused, never merged. */
export function findAuthorityField(params) {
    for (const key of Object.keys(params)) {
        if (AUTHORITY_FIELDS.has(key))
            return key;
    }
    return undefined;
}
const SECRET_FIELDS = new Set([
    "token", "access_token", "accessToken", "launch_token", "launchToken",
    "claim_token", "claimToken", "bearer", "authorization", "secret",
    "client_secret", "clientSecret", "password", "passwd", "private_key", "privateKey",
    "credential", "credentials",
]);
/** Shallow and nested scan used to keep secrets out of child-visible results and checkpoint records. */
export function findSecretField(value, seen = new Set()) {
    if (!value || typeof value !== "object")
        return undefined;
    if (seen.has(value))
        return undefined;
    seen.add(value);
    if (Array.isArray(value)) {
        for (const entry of value) {
            const found = findSecretField(entry, seen);
            if (found)
                return found;
        }
        return undefined;
    }
    for (const [key, entry] of Object.entries(value)) {
        if (SECRET_FIELDS.has(key))
            return key;
        const found = findSecretField(entry, seen);
        if (found)
            return found;
    }
    return undefined;
}
export function extractTaskIds(tool, params) {
    const ids = [];
    const add = (value) => { if (value !== undefined)
        ids.push(value); };
    add(params.id);
    add(params.task_id);
    add(params.taskId);
    add(params.task_ids);
    add(params.taskIds);
    if (Array.isArray(params.terminal_revisions)) {
        for (const revision of params.terminal_revisions) {
            if (revision && typeof revision === "object") {
                const record = revision;
                add(record.task_id);
                add(record.taskId);
            }
        }
    }
    const flattened = [];
    for (const value of ids) {
        if (Array.isArray(value)) {
            for (const entry of value)
                if (typeof entry === "string")
                    flattened.push(entry);
        }
        else if (typeof value === "string") {
            flattened.push(value);
        }
    }
    return [...new Set(flattened)];
}
/** Task ids the supervisor returned for a launch; used to reject a handler that claimed a foreign task. */
export function extractResultTaskIds(value, seen = new Set()) {
    const found = [];
    if (!value || typeof value !== "object")
        return found;
    if (seen.has(value))
        return found;
    seen.add(value);
    if (Array.isArray(value)) {
        for (const entry of value)
            found.push(...extractResultTaskIds(entry, seen));
        return [...new Set(found)];
    }
    const record = value;
    const looksLikeTaskId = (entry) => typeof entry === "string" && entry.startsWith("bg_") && !entry.startsWith("bg_batch_") && isValidTaskId(entry);
    for (const key of ["taskId", "task_id", "taskIds", "task_ids"]) {
        const entry = record[key];
        if (typeof entry === "string")
            found.push(entry);
        else if (Array.isArray(entry)) {
            for (const item of entry)
                if (typeof item === "string")
                    found.push(item);
        }
    }
    // A read result may expose the task as `id`, and a list-shaped result may
    // put task ids under `task`/`tasks`. Treat only background-task-shaped ids
    // as tasks so operation and request ids are not mistaken for them.
    if (looksLikeTaskId(record.id))
        found.push(record.id);
    for (const key of ["task", "tasks"]) {
        const entries = Array.isArray(record[key]) ? record[key] : [record[key]];
        for (const entry of entries) {
            if (entry && typeof entry === "object" && looksLikeTaskId(entry.id)) {
                found.push(entry.id);
            }
        }
    }
    for (const [key, entry] of Object.entries(record)) {
        if (key === "taskId" || key === "task_id" || key === "taskIds" || key === "task_ids" || key === "id" || key === "task" || key === "tasks")
            continue;
        if (entry && typeof entry === "object")
            found.push(...extractResultTaskIds(entry, seen));
    }
    return [...new Set(found)];
}
export function isValidTaskId(value) {
    return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
}
export function isLaunchTool(tool, params) {
    if (OPERATION_LAUNCH_TOOL_NAMES.includes(tool))
        return true;
    // Wrapper names are not exposed by this bridge, but keeping the classifier
    // correct makes the host safe if the parent later adds one to the handshake.
    if (tool === "bg_task" || tool === "bg_status")
        return params.action === "spawn" || params.action === "watch";
    return false;
}
export function isInsideWorkspace(workspace, candidate) {
    const root = resolve(workspace);
    const path = resolve(root, candidate);
    return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}
// ---- request envelope and wait-result validation -------------------------------------------------
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/;
export function validateRequestEnvelope(value) {
    const id = value && typeof value === "object" && typeof value.id === "string"
        ? value.id
        : "";
    if (!value || typeof value !== "object" || Array.isArray(value))
        return { ok: false, id, message: "request must be an object" };
    const record = value;
    if (record.v !== OPERATION_BRIDGE_VERSION)
        return { ok: false, id, message: "unsupported bridge version" };
    if (typeof record.id !== "string" || !REQUEST_ID_PATTERN.test(record.id))
        return { ok: false, id, message: "invalid request id" };
    if (typeof record.token !== "string" || record.token.length < 16 || record.token.length > 512 || /[\r\n]/.test(record.token)) {
        return { ok: false, id, message: "invalid token shape" };
    }
    if (typeof record.runId !== "string" || !ID_PATTERN.test(record.runId))
        return { ok: false, id, message: "invalid run id" };
    if (typeof record.conversationId !== "string" || !ID_PATTERN.test(record.conversationId)) {
        return { ok: false, id, message: "invalid conversation id" };
    }
    if (typeof record.method !== "string" || !OPERATION_BRIDGE_METHODS.includes(record.method)) {
        return { ok: false, id, message: "unknown method" };
    }
    if (record.params !== undefined && record.params !== null &&
        (typeof record.params !== "object" || Array.isArray(record.params))) {
        return { ok: false, id, message: "params must be an object" };
    }
    if (record.key !== undefined && (typeof record.key !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(record.key))) {
        return { ok: false, id, message: "invalid idempotency key" };
    }
    return {
        ok: true,
        envelope: {
            v: OPERATION_BRIDGE_VERSION,
            id: record.id,
            token: record.token,
            runId: record.runId,
            conversationId: record.conversationId,
            method: record.method,
            params: cloneJson(record.params),
            ...(record.key === undefined ? {} : { key: record.key }),
        },
    };
}
export function validateHandshakeParams(params) {
    const result = validateJsonSchema(HANDSHAKE_SCHEMA, params);
    if (!result.ok)
        return { ok: false, message: result.message };
    const record = (params ?? {});
    const client = record.client && typeof record.client === "object"
        ? record.client
        : undefined;
    return {
        ok: true,
        ...(client && typeof client.name === "string" && typeof client.version === "string"
            ? { client: { name: client.name, version: client.version } }
            : {}),
    };
}
/** Settled dependencies do not bypass a checkpoint while the writer is still parking. */
export function requiresParkCheckpoint(wait) {
    return wait.park && (wait.phase === "parking" || !wait.settled);
}
export function normalizeWaitForOperationsResult(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return { ok: false, message: "wait result must be an object" };
    const record = value;
    const nested = record.operationWait && typeof record.operationWait === "object"
        ? record.operationWait
        : undefined;
    const source = nested ?? record;
    const waitRecord = record.wait && typeof record.wait === "object" ? record.wait : undefined;
    const waitId = source.waitId ?? source.wait_id ?? waitRecord?.waitId;
    const generation = source.generation ?? waitRecord?.generation;
    const phase = source.phase ?? waitRecord?.phase ?? "waiting";
    if (typeof waitId !== "string" || !waitId)
        return { ok: false, message: "wait result has no wait id" };
    if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1) {
        return { ok: false, message: "wait result has no valid generation" };
    }
    if (typeof phase !== "string" || !phase)
        return { ok: false, message: "wait result has no phase" };
    const origin = waitRecord?.origin && typeof waitRecord.origin === "object"
        ? waitRecord.origin
        : undefined;
    const rawTaskIds = source.taskIds ?? source.task_ids ?? record.taskIds ?? record.task_ids ??
        origin?.taskIds ?? origin?.task_ids ?? [];
    const taskIds = Array.isArray(rawTaskIds) ? rawTaskIds.filter((entry) => typeof entry === "string") : [];
    if (taskIds.some((taskId) => !isValidTaskId(taskId)))
        return { ok: false, message: "wait result contains an invalid task id" };
    const rawDependencies = source.dependencies ?? record.dependencies ?? waitRecord?.dependencies;
    const dependencies = [];
    if (Array.isArray(rawDependencies)) {
        for (const entry of rawDependencies) {
            if (!entry || typeof entry !== "object")
                continue;
            const dep = entry;
            const revision = dep.terminalRevision ?? dep.terminal_revision;
            const outcome = dep.terminalOutcome ?? dep.terminal_outcome;
            if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
                return { ok: false, message: "wait dependency has no valid terminal revision" };
            }
            if (outcome !== null && outcome !== undefined && !["succeeded", "failed", "cancelled", "lost"].includes(outcome)) {
                return { ok: false, message: "wait dependency has an unknown outcome" };
            }
            const operationId = dep.operationId ?? dep.operation_id;
            const taskId = dep.taskId ?? dep.task_id;
            if (operationId !== undefined && (typeof operationId !== "string" || !operationId)) {
                return { ok: false, message: "wait dependency has an invalid operation id" };
            }
            if (taskId !== undefined && (typeof taskId !== "string" || !isValidTaskId(taskId))) {
                return { ok: false, message: "wait dependency has an invalid task id" };
            }
            dependencies.push({
                ...(typeof taskId === "string" ? { taskId } : {}),
                ...(typeof operationId === "string" ? { operationId } : {}),
                terminalRevision: revision,
                terminalOutcome: (outcome ?? null),
            });
        }
    }
    const settled = source.settled === true || record.settled === true || record.settledAtRegistration === true ||
        waitRecord?.settled === true || (dependencies.length > 0 && dependencies.every((dep) => dep.terminalRevision > 0));
    const park = source.park === true || record.park === true ||
        (waitRecord?.park !== undefined && waitRecord.park !== null);
    const continuationNote = source.continuationNote ?? source.continuation_note ??
        record.continuationNote ?? record.continuation_note ?? waitRecord?.continuationNote;
    if (findSecretField(value))
        return { ok: false, message: "wait result contains a credential-shaped field" };
    return {
        ok: true,
        result: {
            waitId,
            generation,
            phase,
            settled,
            park,
            taskIds,
            dependencies,
            ...(typeof continuationNote === "string" ? { continuationNote } : {}),
        },
    };
}
export function validateCheckpointParams(params) {
    const result = validateJsonSchema(CHECKPOINT_SCHEMA, params);
    if (!result.ok)
        return { ok: false, message: result.message };
    if (findSecretField(params))
        return { ok: false, message: "checkpoint contains a credential-shaped field" };
    return { ok: true, value: cloneJson(params) };
}
export function validateParkFailedParams(params) {
    const result = validateJsonSchema(PARK_FAILED_SCHEMA, params);
    if (!result.ok)
        return { ok: false, message: result.message };
    return { ok: true, value: cloneJson(params) };
}
// ---- cloning and freezing -------------------------------------------------
export function cloneJson(value) {
    if (value === undefined)
        return value;
    return JSON.parse(JSON.stringify(value));
}
export function deepFreeze(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const entry of Object.values(value))
            deepFreeze(entry);
    }
    return value;
}
export function deepFreezeCopy(value) {
    return deepFreeze(cloneJson(value));
}
export function endpointKind(endpoint) {
    if (endpoint.startsWith("unix://"))
        return "unix";
    if (endpoint.startsWith("tcp://"))
        return "tcp";
    throw new OperationBridgeError("invalid-request", "endpoint must be unix:// or tcp://");
}
export function parseBridgeEndpoint(endpoint) {
    if (endpoint.startsWith("unix://")) {
        const path = endpoint.slice("unix://".length);
        if (!path.startsWith("/") || path.length > 4_096 || path.includes("\0")) {
            throw new OperationBridgeError("invalid-request", "invalid unix endpoint");
        }
        return { kind: "unix", path };
    }
    if (endpoint.startsWith("tcp://")) {
        const url = new URL(endpoint);
        const port = Number(url.port);
        if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65_535) {
            throw new OperationBridgeError("invalid-request", "invalid tcp endpoint");
        }
        return { kind: "tcp", host: url.hostname, port };
    }
    throw new OperationBridgeError("invalid-request", "endpoint must be unix:// or tcp://");
}
/** Redacts a known token or token-shaped assignment from a model-facing error string. */
export function redactSecret(message, token) {
    let redacted = message.replace(/\b(authorization|token|access_token|secret|password)\s*[:=]\s*\S+/gi, "$1=[redacted]");
    if (token && token.length >= 8)
        redacted = redacted.split(token).join("[redacted]");
    return redacted.replace(/[\r\n]+/g, " ").slice(0, 2_000);
}
export function operationBridgeErrorBody(error, token) {
    const bridge = isOperationBridgeError(error) ? error : undefined;
    const tool = error instanceof OperationToolError ? error : undefined;
    return {
        code: bridge?.code ?? (tool ? "tool-error" : "handler-error"),
        message: redactSecret(error instanceof Error ? error.message : String(error), token),
        retryable: bridge?.retryable ?? false,
    };
}
