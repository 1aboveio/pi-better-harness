import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import requirements, { childModelRequirements } from "./child-requirements.ts";
import { resolveCandidates, type CatalogModel } from "./routing.ts";

const model = "router/deepseek-flash-auto";
const expected = {
  providers: ["deepseek", "ollama-cloud"],
  modelGroups: [
    { provider: "deepseek", ids: ["deepseek-flash", "deepseek-v4-flash"] },
    { provider: "ollama-cloud", ids: ["deepseek-v4.1-flash:cloud", "deepseek-v4.1-flash"], prefix: "deepseek-v4.1-flash:" },
  ],
};
const physical = (provider: string, id: string): CatalogModel => ({
  provider, id, api: "openai-completions", cost: { input: 0.3, output: 1.2, cacheRead: 0.006 },
});

test("child contract declares both providers and all exact and prefix alternatives", () => {
  assert.deepEqual(childModelRequirements(model), expected);
  assert.deepEqual(requirements({ model }), expected);
  for (const other of ["", "deepseek-flash-auto", "router/other", "deepseek/deepseek-flash", "ollama-cloud/deepseek-v4.1-flash:cloud"]) {
    assert.equal(childModelRequirements(other), undefined, other);
    assert.equal(requirements({ model: other }), undefined, other);
  }
});

test("each declared fallback can be selected and provider and prefix boundaries are preserved", () => {
  const declared = requirements({ model })!;
  for (const [provider, id] of [
    ["deepseek", "deepseek-flash"], ["deepseek", "deepseek-v4-flash"],
    ["ollama-cloud", "deepseek-v4.1-flash:cloud"], ["ollama-cloud", "deepseek-v4.1-flash"],
    ["ollama-cloud", "deepseek-v4.1-flash:1017-cloud"],
  ]) {
    const selected = resolveCandidates([physical(provider, id)]);
    assert.equal(selected.length, 1, `${provider}/${id}`);
    assert.equal(selected[0].model, id);
    assert.ok(declared.providers.includes(selected[0].provider));
    assert.ok(declared.modelGroups.some(group => group.provider === provider &&
      (group.ids.includes(id) || (group.prefix !== undefined && id.startsWith(group.prefix)))));
  }
  assert.deepEqual(resolveCandidates([
    physical("other", "deepseek-flash"), physical("deepseek", "deepseek-v4.1-flash:cloud"),
    physical("ollama-cloud", "deepseek-v4.1-flash-other"),
    { ...physical("deepseek", "deepseek-flash"), api: "pi-virtual" },
  ]), []);
});

test("exact ID preference and sorted prefix fallback survive catalog order changes", () => {
  const catalog = [
    physical("ollama-cloud", "deepseek-v4.1-flash:z-cloud"),
    physical("ollama-cloud", "deepseek-v4.1-flash:a-cloud"),
    physical("ollama-cloud", "deepseek-v4.1-flash"),
    physical("ollama-cloud", "deepseek-v4.1-flash:cloud"),
    physical("deepseek", "deepseek-v4-flash"), physical("deepseek", "deepseek-flash"),
  ];
  assert.deepEqual(resolveCandidates(catalog).map(c => c.model), ["deepseek-flash", "deepseek-v4.1-flash:cloud"]);
  assert.equal(resolveCandidates(catalog.slice(0, 3))[0].model, "deepseek-v4.1-flash");
  assert.equal(resolveCandidates(catalog.slice(0, 2))[0].model, "deepseek-v4.1-flash:a-cloud");
});

test("mutating returned requirements cannot change discovery or runtime selection", () => {
  const result = childModelRequirements(model)!;
  result.providers.splice(0);
  result.modelGroups[0].ids.splice(0);
  result.modelGroups[1].prefix = "unrelated:";
  result.modelGroups.splice(1);
  assert.deepEqual(childModelRequirements(model), expected);
  assert.deepEqual(resolveCandidates([
    physical("deepseek", "deepseek-flash"), physical("ollama-cloud", "deepseek-v4.1-flash:tag"),
  ]).map(c => c.model), ["deepseek-flash", "deepseek-v4.1-flash:tag"]);
});

test("contract imports and runs without loading the extension SDK or provider plugin", () => {
  // A fresh process prevents cached imports from hiding an SDK dependency.
  const loader = `export async function resolve(specifier, context, next) {
    if (specifier.startsWith('@earendil-works/') || specifier === 'pi-ollama-cloud') {
      throw new Error('Discovery attempted to load extension dependency: ' + specifier);
    }
    return next(specifier, context);
  }`;
  const script = `
    import { register } from 'node:module';
    import assert from 'node:assert/strict';
    register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)});
    const contract = await import(${JSON.stringify(new URL("./child-requirements.ts", import.meta.url).href)});
    assert.deepEqual(contract.default({ model: ${JSON.stringify(model)} }), ${JSON.stringify(expected)});
  `;
  const child = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "--eval", script], {
    encoding: "utf8", timeout: 15000,
  });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
});
