/**
 * Regression: the foreground can resolve an `ollama-cloud` model because its
 * provider package is installed and loaded. An isolated child launches with
 * `--no-extensions`, so unless that same package is named for the child, the
 * provider is never registered and the child fails with "model not found".
 *
 * The provider mapping is therefore built in, not something every user must
 * copy into `config.json`. A user mapping (including an empty one that opts
 * out) still wins, and a mapped-but-missing package must keep surfacing the
 * existing explicit missing error instead of launching without provider auth.
 *
 * // @covers extensions.provider-auth
 * // @level integration
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionArgs, resolveExtensions } from "../extensions.mjs";
import { loadConfig, resolveExtensionPath, setConfigPathForTests } from "../config.ts";

const OLLAMA = "npm:pi-ollama-cloud";
const MODEL = "ollama-cloud/deepseek-v4.1-flash";
const BUNDLED_CONFIG = join(dirname(fileURLToPath(import.meta.url)), "..", "config.json");

/** Real config loading and path materialization, isolated to a temp agent dir. */
function openEnvironment(t, { settings, installed = true } = {}) {
    const root = mkdtempSync(join(tmpdir(), "builtin-provider-"));
    const agentDir = join(root, "agent");
    const settingsPath = join(agentDir, "settings.json");
    mkdirSync(agentDir, { recursive: true });
    if (settings) {
        writeFileSync(settingsPath, JSON.stringify({ piBetterHarness: { subagents: settings } }));
    }
    if (installed) {
        mkdirSync(join(agentDir, "npm", "node_modules", "pi-ollama-cloud"), { recursive: true });
    }
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    setConfigPathForTests(settingsPath, BUNDLED_CONFIG);
    t.after(() => {
        setConfigPathForTests(undefined);
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        rmSync(root, { recursive: true, force: true });
    });
    return { agentDir };
}

function resolveFromShippedConfig() {
    return resolveExtensions({ tools: "read,bash", model: MODEL, config: loadConfig() });
}

describe("built-in provider extensions", () => {
    it("loads the ollama-cloud provider package without a manual mapping", (t) => {
        const { agentDir } = openEnvironment(t);
        const resolution = resolveFromShippedConfig();
        assert.deepEqual(resolution.specs, [OLLAMA]);
        assert.deepEqual(resolution.reasons[OLLAMA], ["provider:ollama-cloud"]);

        const child = extensionArgs(resolution, resolveExtensionPath);
        assert.deepEqual(child.missing, []);
        assert.deepEqual(child.args, [
            "--no-extensions",
            "--extension",
            join(agentDir, "npm", "node_modules", "pi-ollama-cloud"),
        ]);
    });

    it("keeps a missing provider package an explicit missing error", (t) => {
        openEnvironment(t, { installed: false });
        const child = extensionArgs(resolveFromShippedConfig(), resolveExtensionPath);
        assert.deepEqual(child.missing, [OLLAMA]);
        assert.deepEqual(child.args, ["--no-extensions"]);
    });

    it("lets a user mapping override the built-in package", (t) => {
        openEnvironment(t, {
            settings: { providerExtensions: { "ollama-cloud": "npm:pi-ollama-alternative" } },
        });
        const resolution = resolveFromShippedConfig();
        assert.deepEqual(resolution.specs, ["npm:pi-ollama-alternative"]);
        assert.deepEqual(resolution.reasons["npm:pi-ollama-alternative"], ["provider:ollama-cloud"]);
    });

    it("lets a user entry disable the built-in package", (t) => {
        openEnvironment(t, { settings: { providerExtensions: { "ollama-cloud": [] } } });
        assert.deepEqual(resolveFromShippedConfig().specs, []);
    });
});
