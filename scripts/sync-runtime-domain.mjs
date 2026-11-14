import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const target = join(root, "packages/pi-better-server/src/runtime/domain");
mkdirSync(target, { recursive: true });
writeFileSync(join(root, "packages/pi-better-subagents/shared-work-client.mjs"), readFileSync(join(root, "packages/pi-better-server/src/runtime/work-client.mjs")));
for (const [name, source] of [
  ["assignment-projection.mjs", "packages/pi-better-subagents/assignment-projection.mjs"],
  ["assignment-observation.mjs", "packages/operation-coordinator/assignment-observation.mjs"],
]) {
  const text = readFileSync(join(root, source), "utf8").replace("./shared-operation-coordinator/assignment-observation.mjs", "./assignment-observation.mjs");
  writeFileSync(join(target, name), `// Generated from ${source}. Do not edit directly.\n${text}`);
}
writeFileSync(join(target, "session-store.mjs"), "// Generated from packages/pi-better-subagents/session-store.ts. Do not edit directly.\n" +
  ts.transpileModule(readFileSync(join(root, "packages/pi-better-subagents/session-store.ts"), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText);

const registry = ts.createSourceFile("registry.ts", readFileSync(join(root, "packages/pi-better-subagents/registry.ts"), "utf8"), ts.ScriptTarget.Latest, true);
const printer = ts.createPrinter();
const paths = registry.statements.filter(statement => ts.isFunctionDeclaration(statement) && ["baseDir", "runDir", "logPathFor"].includes(statement.name?.text));
writeFileSync(join(target, "log-paths.mjs"), ts.transpileModule(
  'import { realpathSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";\n' +
  paths.map(statement => printer.printNode(ts.EmitHint.Unspecified, statement, registry)).join("\n"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
for (const name of ["parse.ts", "log-cursor.ts", "shared-log-utils.ts"]) {
  const source = readFileSync(join(root, "packages/pi-better-subagents", name), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    transformers: { before: [context => node => ts.visitEachChild(node, child => {
      if (!ts.isImportDeclaration(child) || !ts.isStringLiteral(child.moduleSpecifier)) return child;
      const path = child.moduleSpecifier.text === "./registry.ts" ? "./log-paths.mjs" : child.moduleSpecifier.text.replace(/\.ts$/, ".mjs");
      return ts.factory.updateImportDeclaration(child, child.modifiers, child.importClause, ts.factory.createStringLiteral(path), child.attributes);
    }, context)] } }).outputText;
  writeFileSync(join(target, name.replace(/\.ts$/, ".mjs")), `// Generated from packages/pi-better-subagents/${name}. Do not edit directly.\n${output}`);
}
for (const name of ["widget.mjs", "health-surface.mjs"]) writeFileSync(join(target, name), readFileSync(join(root, "packages/pi-better-subagents", name)));
