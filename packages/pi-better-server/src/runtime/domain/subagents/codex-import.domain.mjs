// Generated fixed launch domain from packages/pi-better-subagents/codex-import.ts. Do not edit directly.
/**
 * Codex TOML adapter. Parses an explicit file into a native agent proposal.
 *
 * This module does not discover `.codex/agents`, does not write the catalog,
 * and does not resolve model availability. The command module confirms role,
 * replacement mode, and re-import before `saveDefinition`.
 *
 * Codex gives an agent file's model and effort precedence over the
 * conversation. Pi does not copy that rule: explicit invocation parameters
 * and authoritative workflow instructions override definition defaults.
 */
import { createHash } from "node:crypto";
import { parse as parseToml, TomlError } from "smol-toml";
import { CATALOG_SCHEMA_VERSION, DiagnosticCodes, EFFORT_LEVELS, HOST_EXECUTION_CONTROL_KEYS, parseDefinition, serializeDefinition, } from "./catalog-schema.domain.mjs";
export const CODEX_FORMAT = "codex-toml";
export const PI_VS_CODEX_PRECEDENCE = {
    codex: "Codex gives the agent file's model and model_reasoning_effort precedence over the conversation default.",
    pi: "Pi does not copy that precedence. Structured invocation parameters, then applicable task or workflow instructions, override named-agent overrides and role defaults.",
};
const MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const SECRET_KEY = /api[_-]?key|apikey|secret|password|passwd|token|credential|authorization|connectionstring|databaseurl/i;
const EXACT_SECRET_KEY = /^(?:auth|dsn|access[_-]?token|refresh[_-]?token|credentials)$/i;
/**
 * Scalar Codex controls this catalog cannot enforce. Objects and arrays are
 * already restrictions. Missing one of these and calling it cosmetic would
 * leave the agent launchable: an unenforced grant of the restricted capability.
 */
const EXECUTION_KEY_PATTERN = /(?:^|[._-])(?:sandbox(?:[_-]mode|[_-]workspace[_-]write)?|permissions?|mcp(?:[_-]servers?)?|skills?|hooks?|approvals?|web[_-]search(?:[_-]modes)?|allowed[_-]web[_-]search[_-]modes|web[_-]fetch|filesystem|network(?:[_-]access)?|tools?|tool[_-]presets?|shell(?:[_-]environment[_-]policy)?|environment|browsing|internet(?:[_-]access)?)(?:$|[._-])/i;
const EXTRA_EXECUTION_KEYS = new Set([
    "skills",
    "skill",
    "mcp_servers",
    "mcp_server",
    "hooks",
    "approval",
    "approval_policy",
    "approvals",
    "command",
    "exec",
    "agents",
]);
const SUPPORTED_KEYS = new Set(["name", "description", "developer_instructions", "model", "model_reasoning_effort"]);
const HINTS = {
    "role.researcher": ["research", "researcher"],
    "role.explorer": ["explore", "explorer"],
    "role.product-manager": ["product", "prd"],
    "role.developer": ["develop", "developer", "implement"],
    "role.reviewer": ["review", "reviewer"],
    "role.architect": ["architect", "architecture"],
};
export function isCodexSkillMetadataPath(filePath) {
    return /(?:^|\/)agents\/openai\.ya?ml$/i.test(filePath.replace(/\\/g, "/"));
}
export function codexSourceRef(filePath) {
    const prefix = "codex-file:";
    if (prefix.length + filePath.length <= 500 && !/[\r\n]/.test(filePath))
        return `${prefix}${filePath}`;
    return `codex-file-sha256:${createHash("sha256").update(filePath).digest("hex")}`;
}
export function agentIdFromDisplayName(name) {
    const slug = name
        .trim()
        .toLowerCase()
        .replace(/['"]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
        return undefined;
    const id = `agent.${slug}`;
    return id.length <= 128 ? id : undefined;
}
export function suggestBaseRoles(corpus, roles) {
    const ranked = [];
    for (const role of roles) {
        let score = 0;
        const hints = new Set([role.name.toLowerCase(), ...(HINTS[role.id] ?? [])]);
        for (const part of role.id.replace(/^role\./, "").split(/[.-]/)) {
            if (part)
                hints.add(part);
        }
        for (const hint of hints) {
            if (!hint || !includesWord(corpus, hint))
                continue;
            score += hint === role.name.toLowerCase() ? 5 : 3;
        }
        if (score > 0)
            ranked.push({ id: role.id, score });
    }
    ranked.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
    const top = ranked[0]?.score ?? 0;
    const leaders = ranked.filter((item) => item.score === top && top > 0);
    return {
        ranked,
        unique: leaders.length === 1 ? leaders[0]?.id : undefined,
        ambiguous: leaders.length > 1 ? leaders.map((item) => item.id) : [],
    };
}
/**
 * Documents the intentional precedence difference. This is not the launch
 * resolver and does not read prose, prompts, or provider registries.
 */
export function explainCodexImportPrecedence(input) {
    const model = pickPrecedence(input.invocationModel, input.workflowModel, input.agentOverrideModel, input.roleModel);
    const effort = pickPrecedence(input.invocationEffort, input.workflowEffort, input.agentOverrideEffort, input.roleEffort);
    return {
        model: model.value,
        modelSource: model.source,
        effort: effort.value,
        effortSource: effort.source,
        note: `${PI_VS_CODEX_PRECEDENCE.codex} ${PI_VS_CODEX_PRECEDENCE.pi}`,
    };
}
export function parseCodexSource(source, sourcePath) {
    const diagnostics = [];
    if (sourcePath && isCodexSkillMetadataPath(sourcePath)) {
        return { ok: false, diagnostics: [skillDiagnostic(sourcePath)] };
    }
    if (sourcePath && /\.ya?ml$/i.test(sourcePath)) {
        return {
            ok: false,
            diagnostics: [problem("not-codex-agent", `${sourcePath} is YAML, not a Codex custom agent. Codex agents are TOML files, and agents/openai.yaml is skill metadata. Nothing was imported.`, sourcePath)],
        };
    }
    if (Buffer.byteLength(source) > 512 * 1024) {
        return {
            ok: false,
            diagnostics: [problem("parser-limit", "Codex file is larger than 512 KiB. Shorten it and run import-codex again. Nothing was imported.", sourcePath)],
        };
    }
    let parsed;
    try {
        parsed = parseToml(source);
    }
    catch (error) {
        const where = error instanceof TomlError ? ` at line ${error.line}, column ${error.column}` : "";
        const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
        return {
            ok: false,
            diagnostics: [problem("malformed-toml", `Codex file is not valid TOML${where}: ${detail}. Fix the file and run import-codex again. Nothing was imported.`, sourcePath)],
        };
    }
    if (!isPlainObject(parsed)) {
        return {
            ok: false,
            diagnostics: [problem("malformed-toml", "Codex custom agent TOML must be a table with name, description, and developer_instructions. Nothing was imported.", sourcePath)],
        };
    }
    const missing = ["name", "description", "developer_instructions"].filter((key) => !hasNonEmptyString(parsed[key]));
    if (missing.length > 0) {
        return {
            ok: false,
            diagnostics: [problem("missing-codex-field", `Codex custom agents require name, description, and developer_instructions. Missing or empty: ${missing.join(", ")}. Nothing was imported.`, sourcePath, missing[0])],
        };
    }
    const name = String(parsed.name).trim();
    const description = String(parsed.description).trim();
    const developerInstructions = String(parsed.developer_instructions);
    const proposedId = agentIdFromDisplayName(name);
    if (!proposedId) {
        return {
            ok: false,
            diagnostics: [problem("invalid-id", `Codex name ${JSON.stringify(name)} does not make a stable id of the form agent.<slug>. Use letters or numbers and import again. Nothing was imported.`, sourcePath, "name")],
        };
    }
    if (name.length > 120) {
        return {
            ok: false,
            diagnostics: [problem("invalid-field", "Codex name is longer than 120 characters. Shorten it. Nothing was imported.", sourcePath, "name")],
        };
    }
    if (description.length > 2000) {
        return {
            ok: false,
            diagnostics: [problem("invalid-field", "Codex description is longer than 2000 characters. Shorten it. Nothing was imported.", sourcePath, "description")],
        };
    }
    if (developerInstructions.trim().length === 0) {
        return {
            ok: false,
            diagnostics: [problem(DiagnosticCodes.emptyReplacement, "developer_instructions is empty. Imported instructions use replace mode and must be nonempty. Nothing was imported.", sourcePath, "developer_instructions")],
        };
    }
    const restrictions = [];
    const preserved = {};
    const cosmetic = {};
    let model;
    let modelReasoningEffort;
    let storableModel;
    let storableEffort;
    if (Object.prototype.hasOwnProperty.call(parsed, "model")) {
        const value = parsed.model;
        if (typeof value !== "string" || value.trim() === "") {
            diagnostics.push(warning("invalid-codex-model", "Codex model is present but empty or not a string. It was not saved as an override and no provider was guessed.", sourcePath, "model"));
        }
        else {
            model = value.trim();
            if (MODEL_PATTERN.test(model))
                storableModel = model;
            else {
                diagnostics.push(warning("unsupported-codex-model-form", `Codex model ${JSON.stringify(model)} is not provider/model. It is kept as provenance only and was not saved as an override. No provider prefix was added.`, sourcePath, "model"));
            }
        }
    }
    if (Object.prototype.hasOwnProperty.call(parsed, "model_reasoning_effort")) {
        const value = parsed.model_reasoning_effort;
        if (typeof value !== "string" || value.trim() === "") {
            diagnostics.push(warning("invalid-codex-effort", "Codex model_reasoning_effort is present but empty or not a string. It was not saved as an override.", sourcePath, "model_reasoning_effort"));
        }
        else {
            modelReasoningEffort = value.trim();
            const normalized = modelReasoningEffort.toLowerCase();
            if (EFFORT_LEVELS.includes(normalized))
                storableEffort = normalized;
            else {
                diagnostics.push(warning("unsupported-codex-effort", `Codex model_reasoning_effort ${JSON.stringify(modelReasoningEffort)} is not one of ${EFFORT_LEVELS.join(", ")}. It is kept as provenance only and was not saved as an override.`, sourcePath, "model_reasoning_effort"));
            }
        }
    }
    for (const [key, raw] of Object.entries(parsed)) {
        if (SUPPORTED_KEYS.has(key))
            continue;
        if (isSecretKey(key)) {
            restrictions.push(restriction(key, "[redacted]", `Field ${key} looks like credential material. The value was not stored. Launch stays blocked until the field is removed.`));
            diagnostics.push(problem(DiagnosticCodes.credentialMaterial, `Codex field ${key} looks like a secret and was redacted. Remove it from the source. The imported copy is not launchable while the restriction remains.`, sourcePath, key));
            continue;
        }
        const safe = toJsonSafe(raw);
        if (!safe.ok) {
            diagnostics.push(problem("invalid-codex-value", `Codex field ${key} is not JSON-compatible and was not imported. Nothing was written.`, sourcePath, key));
            return { ok: false, diagnostics };
        }
        const redaction = { redacted: false };
        const stored = redactNestedSecrets(safe.value, redaction);
        if (redaction.redacted) {
            diagnostics.push(problem(DiagnosticCodes.credentialMaterial, `Codex field ${key} contains nested credential material. Those values were redacted before any reason, diagnostic, preview, or provenance text was built. Remove the field from the source. The imported copy is not launchable while the restriction remains.`, sourcePath, key));
        }
        if (isExecutionSetting(key, stored) || redaction.redacted) {
            const reason = restrictionReason(key, stored);
            restrictions.push(restriction(key, stored, reason));
            if (HOST_EXECUTION_CONTROL_KEYS.includes(key))
                preserved[key] = stored;
            diagnostics.push(problem(DiagnosticCodes.unsupportedExecutionRestriction, reason, sourcePath, key, false));
            continue;
        }
        cosmetic[key] = stored;
        diagnostics.push(warning(DiagnosticCodes.cosmeticMetadata, `Codex field ${key} is cosmetic metadata. It was preserved and is not a tool, sandbox, or permission grant.`, sourcePath, key));
    }
    return {
        ok: true,
        diagnostics,
        document: {
            name,
            description,
            developerInstructions,
            proposedId,
            model,
            modelReasoningEffort,
            storableModel,
            storableEffort,
            restrictions,
            preservedExecutionControls: Object.keys(preserved).length > 0 ? preserved : undefined,
            cosmetic,
        },
    };
}
export function buildImportedAgent(document, choices) {
    const diagnostics = [];
    const overrides = {};
    if (choices.saveOverrides) {
        if (document.storableModel)
            overrides.model = document.storableModel;
        if (document.storableEffort)
            overrides.effort = document.storableEffort;
        if (!document.storableModel && !document.storableEffort) {
            diagnostics.push(warning("overrides-not-stored", "No supported Codex model or effort could be stored as an explicit override. Inherited role values were not copied into overrides.", undefined, "overrides"));
        }
    }
    const metadata = redactNestedSecrets({
        codex: {
            model: document.model ?? null,
            modelReasoningEffort: document.modelReasoningEffort ?? null,
            precedence: "pi-invocation-and-workflow-override-definition-defaults",
            codexPrecedence: "agent-file-model-and-effort-win",
        },
    });
    if (Object.keys(document.cosmetic).length > 0)
        metadata.codexCosmetic = redactNestedSecrets(document.cosmetic);
    const draft = {
        schema: CATALOG_SCHEMA_VERSION,
        kind: "agent",
        id: choices.id,
        name: document.name,
        description: document.description,
        roleId: choices.roleId,
        instructionMode: "replace",
        overrides,
        provenance: {
            origin: "imported",
            format: CODEX_FORMAT,
            sourceRef: scrubEmbeddedSecrets(choices.sourceRef),
            importedAt: choices.importedAt,
            note: "Independent copy. Source edits do not update this file. Pi invocation and workflow choices override Codex model and effort precedence.",
        },
        executionRestrictions: document.restrictions.map((item) => ({ ...item, honored: false })),
        metadata,
        preservedExecutionControls: document.preservedExecutionControls
            ? { ...document.preservedExecutionControls }
            : undefined,
        body: document.developerInstructions,
    };
    const serialized = serializeDefinition(draft);
    diagnostics.push(...serialized.diagnostics);
    if (!serialized.ok || !serialized.markdown)
        return { ok: false, diagnostics };
    const parsed = parseDefinition(serialized.markdown);
    diagnostics.push(...parsed.diagnostics.filter((item) => !diagnostics.some((existing) => existing.code === item.code && existing.field === item.field && existing.message === item.message)));
    if (!parsed.ok || parsed.definition?.kind !== "agent")
        return { ok: false, diagnostics };
    return { ok: true, definition: parsed.definition, diagnostics };
}
export function renderReimportPreview(existing, next) {
    const before = semanticView(existing);
    const after = semanticView(next);
    const changes = diffSemantic(before, after, "");
    const lostLocalInstructionLines = lostLines(textOf(before.body), textOf(after.body)).map((line) => scrubEmbeddedSecrets(line));
    const detail = changes
        .filter((item) => item.field !== "roleId" && item.field !== "instructionMode" && item.field !== "body")
        .map(formatChange)
        .filter((line) => line !== undefined);
    const lines = [
        `Re-import replaces agent ${next.id}. It does not merge.`,
        `stable id retained: ${next.id}`,
        `role: ${existing.roleId} → ${next.roleId}`,
        `instruction mode: ${existing.instructionMode} → ${next.instructionMode}`,
        `instructions before: ${displayValue(before.body)}`,
        `instructions after: ${displayValue(after.body)}`,
        ...lostLocalInstructionLines.map((line) => `lost local instruction line: ${JSON.stringify(line)}`),
        `changed fields: ${changes.length === 0 ? "(none)" : changes.map((item) => item.field).join(", ")}`,
        ...detail,
        "Local instruction text is not appended to the imported developer_instructions.",
        `${PI_VS_CODEX_PRECEDENCE.codex} ${PI_VS_CODEX_PRECEDENCE.pi}`,
    ];
    return {
        id: next.id,
        text: scrubEmbeddedSecrets(lines.join("\n")),
        changes,
        lostLocalInstructionLines,
        replacedNotMerged: true,
    };
}
function semanticView(definition) {
    try {
        return redactNestedSecrets(JSON.parse(JSON.stringify(definition)));
    }
    catch {
        return redactNestedSecrets(definition);
    }
}
function diffSemantic(before, after, path) {
    if (sameJson(before, after))
        return [];
    if (isPlainObject(before) && isPlainObject(after)) {
        const changes = [];
        const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
        for (const key of keys) {
            const child = path ? `${path}.${key}` : key;
            const hasBefore = Object.prototype.hasOwnProperty.call(before, key);
            const hasAfter = Object.prototype.hasOwnProperty.call(after, key);
            if (!hasBefore)
                changes.push(...addedSemantic(after[key], child));
            else if (!hasAfter)
                changes.push(...removedSemantic(before[key], child));
            else
                changes.push(...diffSemantic(before[key], after[key], child));
        }
        return changes;
    }
    if (Array.isArray(before) && Array.isArray(after) && namedItems(before) && namedItems(after)) {
        return diffNamed(before, after, path);
    }
    if (Array.isArray(before) && Array.isArray(after)) {
        const changes = [];
        const length = Math.max(before.length, after.length);
        for (let index = 0; index < length; index += 1) {
            const child = `${path}[${index}]`;
            if (index >= before.length)
                changes.push(change(child, "", displayValue(after[index])));
            else if (index >= after.length)
                changes.push(change(child, displayValue(before[index]), ""));
            else
                changes.push(...diffSemantic(before[index], after[index], child));
        }
        return changes;
    }
    return [change(path || "(definition)", displayValue(before), displayValue(after))];
}
function diffNamed(before, after, path) {
    const left = groupByName(before);
    const right = groupByName(after);
    const changes = [];
    for (const name of [...new Set([...left.keys(), ...right.keys()])].sort()) {
        const beforeItems = left.get(name) ?? [];
        const afterItems = right.get(name) ?? [];
        const count = Math.max(beforeItems.length, afterItems.length);
        for (let index = 0; index < count; index += 1) {
            const child = count === 1 ? `${path}[name=${JSON.stringify(name)}]` : `${path}[name=${JSON.stringify(name)}][${index}]`;
            const beforeItem = beforeItems[index];
            const afterItem = afterItems[index];
            if (beforeItem === undefined)
                changes.push(...addedSemantic(afterItem, child));
            else if (afterItem === undefined)
                changes.push(...removedSemantic(beforeItem, child));
            else
                changes.push(...diffSemantic(beforeItem, afterItem, child));
        }
    }
    return changes;
}
function groupByName(items) {
    const groups = new Map();
    for (const item of items) {
        const name = typeof item.name === "string" ? item.name : "";
        const group = groups.get(name) ?? [];
        group.push(item);
        groups.set(name, group);
    }
    return groups;
}
function namedItems(items) {
    return items.every((item) => isPlainObject(item) && typeof item.name === "string");
}
function removedSemantic(value, path) {
    if (isPlainObject(value))
        return diffSemantic(value, {}, path);
    if (Array.isArray(value))
        return diffSemantic(value, [], path);
    return [change(path, displayValue(value), "")];
}
function addedSemantic(value, path) {
    if (isPlainObject(value))
        return diffSemantic({}, value, path);
    if (Array.isArray(value))
        return diffSemantic([], value, path);
    return [change(path, "", displayValue(value))];
}
function formatChange(item) {
    if (item.after === "") {
        if (item.field.startsWith("overrides."))
            return `lost local override ${item.field.slice("overrides.".length)}: ${item.before}`;
        return `lost local ${item.field}: ${item.before}`;
    }
    if (item.before === "")
        return `added ${item.field}: ${item.after}`;
    return `${item.field}: ${item.before} → ${item.after}`;
}
function displayValue(value) {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "" : scrubEmbeddedSecrets(encoded);
}
function textOf(value) {
    return typeof value === "string" ? value : "";
}
function sameJson(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
function change(field, before, after) {
    return { field, before, after };
}
function lostLines(before, after) {
    const afterLines = new Set(after.split(/\r?\n/));
    return before.split(/\r?\n/).filter((line) => line.trim() !== "" && !afterLines.has(line));
}
function pickPrecedence(invocation, workflow, agentOverride, roleDefault) {
    if (present(invocation))
        return { value: invocation, source: "invocation" };
    if (present(workflow))
        return { value: workflow, source: "workflow" };
    if (present(agentOverride))
        return { value: agentOverride, source: "agent-override" };
    if (present(roleDefault))
        return { value: roleDefault, source: "role-default" };
    return { source: "absent" };
}
function present(value) {
    return typeof value === "string" && value.trim() !== "";
}
function includesWord(text, word) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, "i").test(text);
}
function isExecutionKey(key) {
    return HOST_EXECUTION_CONTROL_KEYS.includes(key)
        || EXTRA_EXECUTION_KEYS.has(key)
        || EXECUTION_KEY_PATTERN.test(key);
}
function isExecutionSetting(key, value) {
    return isExecutionKey(key) || isPlainObject(value) || Array.isArray(value);
}
function isSecretKey(key) {
    return SECRET_KEY.test(key) || EXACT_SECRET_KEY.test(key);
}
function restrictionReason(key, value) {
    const shown = displayValue(redactNestedSecrets(value));
    if (key === "sandbox_mode" || /sandbox/i.test(key)) {
        return `Codex ${key}=${shown} is preserved and blocks launch. It is not enforced. A read-only sandbox mode is not applied by the catalog or by the existing subagent sandbox. Remove the restriction from the native definition before launch.`;
    }
    if (/web[_-]search|web[_-]fetch/i.test(key)) {
        return `Codex ${key}=${shown} is preserved and blocks launch. It is not enforced. The catalog cannot honor this search restriction, so it is not cosmetic metadata and it does not grant or disable search. Remove it once a real host control covers it.`;
    }
    return `Codex ${key}=${shown} is an execution setting the catalog cannot enforce. It was preserved and blocks launch. No permission, tool preset, sandbox behavior, or other capability was granted. Remove it once a real host control covers it.`;
}
function redactNestedSecrets(value, state = { redacted: false }, seen = new WeakSet()) {
    if (Array.isArray(value)) {
        if (seen.has(value))
            return "[redacted]";
        seen.add(value);
        return value.map((item) => redactNestedSecrets(item, state, seen));
    }
    if (!isPlainObject(value))
        return value;
    if (seen.has(value))
        return "[redacted]";
    seen.add(value);
    const output = {};
    for (const [key, child] of Object.entries(value)) {
        if (isSecretKey(key)) {
            state.redacted = true;
            output[key] = "[redacted]";
            continue;
        }
        output[key] = redactNestedSecrets(child, state, seen);
    }
    return output;
}
const EMBEDDED_SECRET_KEY = "api[_-]?key|apikey|secret|password|passwd|token|credential|authorization|connectionstring|databaseurl|access[_-]?token|refresh[_-]?token|credentials|dsn|auth";
function scrubEmbeddedSecrets(text) {
    const pattern = new RegExp(String.raw `((?:\\*")?(?:${EMBEDDED_SECRET_KEY})(?:\\*")?\s*[:=]\s*(?:\\*")?)(?:"(?:[^"\\]|\\.)*"|[^\\"',}\s]+)`, "gi");
    return text.replace(pattern, "$1[redacted]");
}
function restriction(name, value, reason) {
    return { name, value, required: true, honored: false, reason };
}
function hasNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
}
function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function toJsonSafe(value) {
    try {
        const encoded = JSON.stringify(value, (_key, item) => {
            if (typeof item === "bigint")
                return item.toString();
            if (item instanceof Date)
                return item.toISOString();
            return item;
        });
        if (encoded === undefined)
            return { ok: false };
        return { ok: true, value: JSON.parse(encoded) };
    }
    catch {
        return { ok: false };
    }
}
function problem(code, message, path, field, structural = true) {
    return { severity: "error", code, message: scrubEmbeddedSecrets(message), path, field, blocking: true, structural };
}
function warning(code, message, path, field) {
    return { severity: "warning", code, message: scrubEmbeddedSecrets(message), path, field, blocking: false, structural: false };
}
function skillDiagnostic(path) {
    return problem("skill-metadata-not-agent", `${path} is Codex skill metadata (agents/openai.yaml), not a custom agent. Import a TOML file such as .codex/agents/<name>.toml. Nothing was imported.`, path);
}
