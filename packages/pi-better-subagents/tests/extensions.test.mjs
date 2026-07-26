/**
 * Unit tests for headless extension resolution (issue #17).
 *
 * Pins the contract that makes subagents survive: the child loads only the
 * extension code backing its requested tools, via `--no-extensions -e <path>`.
 *
 * Measured behavior these tests encode (see extensions.mjs header):
 * - extensions ON + tools read,bash,edit,write,web_search,web_fetch → 2 start /
 *   1 end, no agent_end (dies: patty overrode builtin bash)
 * - --no-extensions -e web-tools, same 6 tools → 3 start / 3 end, agent_settled,
 *   web_fetch returned the page title
 *
 * // @covers extensions.derive-from-tools
 * // @level unit
 * // @covers extensions.isolation-default
 * // @level unit
 * // @covers extensions.provider-auth
 * // @level unit
 * // @covers extensions.unmapped-visible
 * // @level unit
 * // @covers extensions.nesting
 * // @level unit
 * // @covers extensions.inherit-optout
 * // @level unit
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    BUILTIN_TOOLS,
    SELF_SPEC,
    providerOf,
    toolList,
    resolveExtensions,
    extensionArgs,
} from "../extensions.mjs";

const WEB = "npm:@juicesharp/rpiv-web-tools";
const CFG = {
    toolExtensions: { web_search: WEB, web_fetch: WEB },
    providerExtensions: { xai: "npm:pi-xai-oauth" },
};
/** The default allowlist shipped in config.json. */
const DEFAULT_TOOLS = "read,bash,edit,write,web_search,web_fetch";

// ---------------------------------------------------------------------------
// Isolation is the default, and it is what excludes a lifetime-breaking package
// ---------------------------------------------------------------------------
describe("isolation by default", () => {
    // @covers extensions.isolation-default
    // @level unit
    it("defaults to isolated mode (never inherits every installed package)", () => {
        const r = resolveExtensions({ tools: DEFAULT_TOOLS, config: CFG });
        assert.equal(r.mode, "isolated");
    });

    // @covers extensions.isolation-default
    // @level unit
    it("always passes --no-extensions so unrequested packages never load", () => {
        const r = resolveExtensions({ tools: DEFAULT_TOOLS, config: CFG });
        const { args } = extensionArgs(r, (s) => `/p/${s}`);
        assert.equal(args[0], "--no-extensions");
    });

    // @covers extensions.derive-from-tools
    // @level unit
    it("the default 6-tool allowlist loads ONLY the web-tools package", () => {
        // This is the exact config that dies with extensions on and survives here.
        const r = resolveExtensions({ tools: DEFAULT_TOOLS, config: CFG });
        assert.deepEqual(r.specs, [WEB]);
    });

    // @covers extensions.derive-from-tools
    // @level unit
    it("a package backing no requested tool is not loaded (patty is never named)", () => {
        const cfg = { ...CFG, toolExtensions: { ...CFG.toolExtensions, bg_task: "npm:pi-patty-bg-tasks" } };
        const r = resolveExtensions({ tools: DEFAULT_TOOLS, config: cfg });
        assert.ok(!r.specs.includes("npm:pi-patty-bg-tasks"));
        // Exclusion is structural, not a denylist entry.
        assert.deepEqual(r.specs, [WEB]);
    });

    // @covers extensions.derive-from-tools
    // @level unit
    it("builtins alone need no extension at all", () => {
        const r = resolveExtensions({ tools: "read,bash,edit,write", config: CFG });
        assert.deepEqual(r.specs, []);
        assert.deepEqual(r.unmapped, []);
        const { args } = extensionArgs(r, (s) => `/p/${s}`);
        assert.deepEqual(args, ["--no-extensions"]);
    });

    // @covers extensions.derive-from-tools
    // @level unit
    it("deduplicates a package that backs several requested tools", () => {
        const r = resolveExtensions({ tools: "web_search,web_fetch", config: CFG });
        assert.deepEqual(r.specs, [WEB]);
        assert.deepEqual(r.reasons[WEB], ["tool:web_search", "tool:web_fetch"]);
    });
});

// ---------------------------------------------------------------------------
// Model auth is not tool-shaped
// ---------------------------------------------------------------------------
describe("provider auth", () => {
    // @covers extensions.provider-auth
    // @level unit
    it("loads the provider's auth extension even with builtins-only tools", () => {
        const r = resolveExtensions({ tools: "read,bash", model: "xai/grok-4.5", config: CFG });
        assert.deepEqual(r.specs, ["npm:pi-xai-oauth"]);
        assert.deepEqual(r.reasons["npm:pi-xai-oauth"], ["provider:xai"]);
    });

    // @covers extensions.provider-auth
    // @level unit
    it("combines provider auth with tool-derived extensions", () => {
        const r = resolveExtensions({ tools: DEFAULT_TOOLS, model: "xai/grok-4.5", config: CFG });
        assert.deepEqual(r.specs, [WEB, "npm:pi-xai-oauth"]);
    });

    // @covers extensions.provider-auth
    // @level unit
    it("an unmapped provider adds nothing", () => {
        const r = resolveExtensions({ tools: "read", model: "anthropic/claude-opus-5", config: CFG });
        assert.deepEqual(r.specs, []);
    });

    // @covers extensions.provider-auth
    // @level unit
    it("providerOf splits provider/id and tolerates a bare id", () => {
        assert.equal(providerOf("xai/grok-4.5"), "xai");
        assert.equal(providerOf("minimax-cn/MiniMax-M3"), "minimax-cn");
        assert.equal(providerOf("grok-4.5"), undefined);
        assert.equal(providerOf(undefined), undefined);
    });
});

// ---------------------------------------------------------------------------
// The one quiet failure left in this path must not be quiet
// ---------------------------------------------------------------------------
describe("unmapped tools are surfaced", () => {
    // @covers extensions.unmapped-visible
    // @level unit
    it("reports a requested tool with no backing extension", () => {
        const r = resolveExtensions({ tools: "read,bash,mcp_query", config: CFG });
        assert.deepEqual(r.unmapped, ["mcp_query"]);
    });

    // @covers extensions.unmapped-visible
    // @level unit
    it("does not report builtins as unmapped", () => {
        const r = resolveExtensions({ tools: BUILTIN_TOOLS.join(","), config: CFG });
        assert.deepEqual(r.unmapped, []);
    });

    // @covers extensions.unmapped-visible
    // @level unit
    it("an unmapped tool does not silently pull in some other package", () => {
        const r = resolveExtensions({ tools: "mcp_query", config: CFG });
        assert.deepEqual(r.specs, []);
    });

    // @covers extensions.unmapped-visible
    // @level unit
    it("extensionArgs reports specs that are not installed rather than dropping them", () => {
        const r = resolveExtensions({ tools: DEFAULT_TOOLS, config: CFG });
        const { args, missing } = extensionArgs(r, () => undefined);
        assert.deepEqual(missing, [WEB]);
        assert.deepEqual(args, ["--no-extensions"]);
    });
});

// ---------------------------------------------------------------------------
// clean / nesting / operator opt-out
// ---------------------------------------------------------------------------
describe("clean, nesting and the operator opt-out", () => {
    // @covers extensions.isolation-default
    // @level unit
    it("clean:true loads nothing — the narrowest case of the same mechanism", () => {
        const r = resolveExtensions({ tools: DEFAULT_TOOLS, model: "xai/grok-4.5", clean: true, config: CFG });
        assert.equal(r.mode, "clean");
        assert.deepEqual(r.specs, []);
        const { args } = extensionArgs(r, (s) => `/p/${s}`);
        assert.deepEqual(args, ["--no-extensions"]);
    });

    // @covers extensions.nesting
    // @level unit
    it("allow_nested loads this package so the child actually has subagent tools", () => {
        const r = resolveExtensions({ tools: "read,bash", allowNested: true, config: CFG });
        assert.ok(r.specs.includes(SELF_SPEC));
    });

    // @covers extensions.nesting
    // @level unit
    it("without allow_nested this package is not loaded, so nesting is structurally impossible", () => {
        const r = resolveExtensions({ tools: DEFAULT_TOOLS, config: CFG });
        assert.ok(!r.specs.includes(SELF_SPEC));
    });

    // @covers extensions.inherit-optout
    // @level unit
    it("inheritExtensions is operator-only and yields no isolation flags", () => {
        const r = resolveExtensions({ tools: DEFAULT_TOOLS, config: { ...CFG, inheritExtensions: true } });
        assert.equal(r.mode, "inherit");
        const { args } = extensionArgs(r, (s) => `/p/${s}`);
        assert.deepEqual(args, []);
    });

    // @covers extensions.inherit-optout
    // @level unit
    it("no spawn parameter can reach inherit mode — only config can", () => {
        // The model-callable surface is tools/model/clean/allowNested. None of
        // them produce "inherit"; capability escalation by the child is not
        // expressible.
        for (const a of [
            { tools: DEFAULT_TOOLS },
            { tools: DEFAULT_TOOLS, clean: true },
            { tools: DEFAULT_TOOLS, allowNested: true },
            { tools: DEFAULT_TOOLS, model: "xai/grok-4.5" },
        ]) {
            assert.notEqual(resolveExtensions({ ...a, config: CFG }).mode, "inherit");
        }
    });
});

// ---------------------------------------------------------------------------
// parsing helpers
// ---------------------------------------------------------------------------
describe("toolList", () => {
    // @covers extensions.derive-from-tools
    // @level unit
    it("parses spaced, comma form and dedupes", () => {
        assert.deepEqual(toolList("read, bash , read,web_fetch"), ["read", "bash", "web_fetch"]);
        assert.deepEqual(toolList(""), []);
        assert.deepEqual(toolList(undefined), []);
    });

    // @covers extensions.derive-from-tools
    // @level unit
    it("accepts a config value given as an array of specs", () => {
        const cfg = { toolExtensions: { mcp_query: ["npm:pi-mcp-adapter", "npm:other"] } };
        const r = resolveExtensions({ tools: "mcp_query", config: cfg });
        assert.deepEqual(r.specs, ["npm:pi-mcp-adapter", "npm:other"]);
    });
});
