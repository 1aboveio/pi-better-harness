import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { NativeClientHost } from "../src/remote-client/host.ts";
import { SessionRegistry } from "../src/registry.ts";
import { makeEnv } from "./helpers.ts";

function fixture(t: TestContext) {
  const previous = { ...process.env };
  const env = makeEnv();
  Object.assign(process.env, env.vars);
  t.after(() => {
    for (const key of Object.keys(env.vars)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  const installMetadata = (base: string, name: string, version: string) => {
    const directory = join(base, "npm", "node_modules", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name, version }));
  };
  installMetadata(env.agentDir, "global-tools", "1.0.0");
  installMetadata(join(env.cwd, ".pi"), "project-tools", "2.0.0");
  writeFileSync(join(env.agentDir, "settings.json"), JSON.stringify({ packages: ["npm:global-tools"], defaultProjectTrust: "always" }));
  writeFileSync(join(env.cwd, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:project-tools"] }));
  mkdirSync(env.serverDir, { recursive: true });
  const host = new NativeClientHost(new SessionRegistry({ serverDir: env.serverDir }));
  return { env, host };
}

test("host-level package read and installation results exclude workspace declarations and need no selected folder", async t => {
  const { env, host } = fixture(t);
  const expected = { packages: [{ source: "npm:global-tools@1.0.0" }], unsupported: [] };
  assert.deepEqual(await host.handle({ type: "client_packages", scope: "global", cwd: join(env.root, "not-created") }), expected);
  assert.deepEqual(await host.handle({ type: "client_packages_install", scope: "global", packages: [] }), expected);
  assert.deepEqual(await host.handle({ type: "client_packages", cwd: env.cwd }), {
    packages: [{ source: "npm:global-tools@1.0.0" }, { source: "npm:project-tools@2.0.0" }], unsupported: [],
  });
});

test("host-level package operations reject unknown scopes before touching configuration", async t => {
  const { host } = fixture(t);
  for (const type of ["client_packages", "client_packages_install"]) {
    await assert.rejects(host.handle({ type, scope: "arbitrary", packages: [] }), /Unknown package scope/);
  }
});
