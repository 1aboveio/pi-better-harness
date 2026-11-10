import assert from "node:assert/strict";
import { test } from "node:test";
import { exclusionReason } from "../src/core/exclusions.ts";

test("common unignored credential names are excluded", () => {
  for (const path of [
    "credentials",
    "config/credentials",
    "secrets.env",
    "deploy/prod.env",
    ".pgpass",
    "terraform.tfvars",
    "infra/prod.auto.tfvars",
    "service-account.json",
    "keys/id_ed25519_sk",
    "keys/id_ecdsa_sk.pub",
    ".env",
    ".env.local",
  ]) {
    assert.equal(exclusionReason(path), "credential", path);
  }
});

test("template copies of credential files are not credentials", () => {
  for (const path of [".env.example", "apps/web/.env.local.sample", "prod.env.template", "terraform.tfvars.example"]) {
    assert.equal(exclusionReason(path), undefined, path);
  }
});

test("every name the README's never-bundled list names is excluded, and its named exceptions travel", () => {
  const readme: [string, ReturnType<typeof exclusionReason>][] = [
    [".env", "credential"],
    [".env.local", "credential"],
    [".envrc", "credential"],
    [".env-prod", "credential"],
    ["prod.env", "credential"],
    [".pgpass", "credential"],
    ["credential", "credential"],
    ["credentials", "credential"],
    ["main.tfvars", "credential"],
    ["main.tfvars.json", "credential"],
    ["service-account.json", "credential"],
    ["service-accounts.json", "credential"],
    ["service-account-prod.json", "credential"],
    ["service-account_prod.json", "credential"],
    ["service-account.prod.json", "credential"],
    [".npmrc", "credential"],
    [".netrc", "credential"],
    [".pypirc", "credential"],
    [".git-credentials", "credential"],
    [".dockercfg", "credential"],
    ["auth.json", "credential"],
    ["credentials.yaml", "credential"],
    ["secrets.toml", "credential"],
    ["secrets.ini", "credential"],
    ["id_rsa", "credential"],
    ["id_dsa", "credential"],
    ["id_ecdsa", "credential"],
    ["id_ed25519", "credential"],
    ["id_ed25519_sk", "credential"],
    ["id_rsa.pub", "credential"],
    ["id_ecdsa_sk.pub", "credential"],
    ["tls.pem", "credential"],
    ["tls.key", "credential"],
    ["cert.p12", "credential"],
    ["cert.pfx", "credential"],
    ["app.keystore", "credential"],
    ["app.jks", "credential"],
    [".ssh/config", "credential"],
    [".aws/config", "credential"],
    [".gnupg/pubring.kbx", "credential"],
    [".kube/config", "credential"],
    [".docker/config.json", "credential"],
    [".gcloud/adc.json", "credential"],
    [".azure/profile.json", "credential"],
    ["node_modules/x/index.js", "generated"],
    [".env.example", undefined],
    [".env.production.template", undefined],
    ["prod.env.sample", undefined],
  ];
  for (const [path, reason] of readme) {
    assert.equal(exclusionReason(path), reason, path);
  }
});

test("ordinary files and generated dirs are classified as before", () => {
  assert.equal(exclusionReason("src/credentials.ts"), undefined);
  assert.equal(exclusionReason("node_modules/x/index.js"), "generated");
  assert.equal(exclusionReason(".ssh/config"), "credential");
});
