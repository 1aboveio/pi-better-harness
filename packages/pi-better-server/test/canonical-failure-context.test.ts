import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import * as fs from "node:fs";
import { join, basename, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import ts from "typescript";

test("mixed history metadata recorder retains bounded identities without another source read", async () => {
  const path = new URL("./support/history-metadata-evidence-worker.mjs", import.meta.url);
  const tree = ts.createSourceFile(path.pathname, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const statements = tree.statements.filter(node => !ts.isImportDeclaration(node) &&
    !(ts.isExpressionStatement(node) && ts.isAwaitExpression(node.expression)));
  const source = statements.map(node => node.getText(tree)).join("\n") + "\nreturn WorkReadModel;";
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    transformers: { before: [context => node => {
      const visit = (child: ts.Node): ts.VisitResult<ts.Node> => {
        if (ts.isCallExpression(child) && child.expression.kind === ts.SyntaxKind.ImportKeyword)
          return ts.factory.updateCallExpression(child, ts.factory.createIdentifier("load"), child.typeArguments, child.arguments);
        if (ts.isPropertyAccessExpression(child) && ts.isMetaProperty(child.expression) && child.name.text === "url")
          return ts.factory.createStringLiteral(path.href);
        return ts.visitEachChild(child, visit, context);
      };
      return ts.visitNode(node, visit) as ts.SourceFile;
    }], after: [context => node => context.factory.updateSourceFile(node,
      node.statements.filter(statement => !ts.isExportDeclaration(statement)))] },
  }).outputText;
  const descriptorOwner = class { get metrics() { return { existing: true }; } };
  let reads = 0, syncs = 0;
  const boundary = { ...fs, readFileSync(...args: Parameters<typeof readFileSync>) {
    reads++; return readFileSync(...args);
  } };
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
  const run = new AsyncFunction("createRequire", "syncBuiltinESMExports", "createHash", "basename", "dirname", "load", output);
  const Model = await run(() => () => boundary, () => { syncs++; }, createHash, basename, dirname,
    async () => ({ WorkReadModel: descriptorOwner }));
  const root = mkdtempSync(join(tmpdir(), "history-evidence-"));
  const metadata = join(root, "meta.json");
  const payload = '{"private":"never print source contents"}';
  writeFileSync(metadata, payload);
  class BackgroundHistory {
    refresh(path = metadata) { return boundary.readFileSync(path, "utf8"); }
  }
  try {
    boundary.readFileSync(metadata, "utf8");
    const history = new BackgroundHistory();
    for (let i = 0; i < 20; i++) assert.equal(history.refresh(), payload);
    const metrics = new Model().metrics;
    const evidence = metrics.historyMetadataEvidence;
    assert.equal(reads, 21, "capture must not inspect or reread source data");
    assert.equal(syncs, 1);
    assert.equal(metrics.existing, true);
    assert.equal(evidence.total, 20);
    assert.equal(evidence.reads.length, 16);
    assert.equal(evidence.dropped, 4);
    assert.equal(evidence.reads[0].id, basename(root));
    assert.equal(evidence.reads[0].bytes, Buffer.byteLength(payload));
    assert.equal(evidence.reads[0].sha256, createHash("sha256").update(payload).digest("hex"));
    assert.equal(evidence.reads[15].sequence, 16);
    assert.doesNotMatch(JSON.stringify(evidence), /private|never print source contents/);
    rmSync(metadata);
    assert.throws(() => history.refresh(), { code: "ENOENT" });
    assert.equal(new Model().metrics.historyMetadataEvidence.total, 21, "the existing history counter includes attempted reads, including a removed record");
    assert.equal(new Model().metrics.historyMetadataEvidence.dropped, 5);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
