import { mkdirSync, readFileSync, writeFileSync, readdirSync, cpSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const target = join(root, "packages/pi-better-server/src/runtime/domain");
mkdirSync(target, { recursive: true });
// The launch adapter is fixed build content, never a client-selected import.
const subagents = join(target, "subagents");
mkdirSync(subagents, { recursive: true });
function copyLaunchDomain(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name), to = join(destination, entry.name);
    if ((destination.includes("background-service") || destination.includes("sandbox-policy")) && /\.test\./.test(entry.name)) continue;
    if (entry.isDirectory()) {
      if (["roles", "shared-operation-coordinator", "src", "supervisor", "shared-ssh-core", "generated"].includes(entry.name)) copyLaunchDomain(from, to);
      continue;
    }
    if (!/\.(ts|mjs|md)$/.test(entry.name) && !["config.json", "package.json"].includes(entry.name)) continue;
    cpSync(from, to);
    if (!/\.(ts|mjs)$/.test(entry.name)) continue;
    const output = ts.transpileModule(readFileSync(from, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      transformers: { before: [context => node => {
        const path = value => {
          if (!ts.isStringLiteral(value) || !value.text.startsWith(".")) return value;
          if (value.text.endsWith(".ts")) return ts.factory.createStringLiteral(value.text.replace(/\.ts$/, ".domain.mjs"));
          if (value.text.endsWith(".js") && existsSync(join(source, value.text.replace(/\.js$/, ".ts")))) return ts.factory.createStringLiteral(value.text.replace(/\.js$/, ".domain.mjs"));
          return value;
        };
        const visit = child => {
          if (ts.isImportDeclaration(child)) return ts.factory.updateImportDeclaration(child, child.modifiers, child.importClause, path(child.moduleSpecifier), child.attributes);
          if (ts.isExportDeclaration(child) && child.moduleSpecifier) return ts.factory.updateExportDeclaration(child, child.modifiers, child.isTypeOnly, child.exportClause, path(child.moduleSpecifier), child.attributes);
          if (ts.isCallExpression(child) && child.expression.kind === ts.SyntaxKind.ImportKeyword) return ts.factory.updateCallExpression(child, child.expression, child.typeArguments, child.arguments.map(path));
          return ts.visitEachChild(child, visit, context);
        };
        return ts.visitNode(node, visit);
      }] },
    }).outputText;
    writeFileSync(entry.name.endsWith(".ts") ? to.replace(/\.ts$/, ".domain.mjs") : to,
      `// Generated fixed launch domain from ${from.slice(root.length)}. Do not edit directly.\n${output}`);
  }
}
writeFileSync(join(root, "packages/pi-better-subagents/shared-work-client.mjs"), readFileSync(join(root, "packages/pi-better-server/src/runtime/work-client.mjs")));
writeFileSync(join(root, "packages/pi-better-background-tasks/src/shared-work-client.mjs"), readFileSync(join(root, "packages/pi-better-server/src/runtime/work-client.mjs")));
copyLaunchDomain(join(root, "packages/pi-better-subagents"), subagents);
copyLaunchDomain(join(root, "packages/pi-better-background-tasks/src"), join(target, "background-service"));
copyLaunchDomain(join(root, "packages/pi-better-sandbox"), join(target, "sandbox-policy"));
const catalog = join(target, "catalog");
mkdirSync(catalog, { recursive: true });
cpSync(join(root, "packages/pi-better-subagents/roles"), join(catalog, "roles"), { recursive: true });
for (const name of ["catalog-store", "catalog-schema", "catalog-preferences", "catalog-skill-edits", "catalog-overlay", "agent-session-settings", "thinking"]) {
  const source = readFileSync(join(root, "packages/pi-better-subagents", `${name}.ts`), "utf8");
  writeFileSync(join(catalog, `${name}.mjs`), `// Generated from packages/pi-better-subagents/${name}.ts. Do not edit directly.\n` + ts.transpileModule(source.replaceAll(/(from\s+["'][^"']+)\.ts(["'])/g, "$1.mjs$2"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText);
  writeFileSync(join(catalog, `${name}.d.mts`), ts.transpileDeclaration(source.replaceAll(/(from\s+["'][^"']+)\.ts(["'])/g, "$1.mjs$2"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText);
}
const background = join(target, "background");
mkdirSync(join(background, "supervisor"), { recursive: true });
for (const name of ["conditions.ts", "registry.ts", "types.ts", "process.ts", "process-identity.ts", "supervisor/store.ts", "supervisor/types.ts", "supervisor/supervisor.ts", "supervisor/identity.ts", "supervisor/invocation.ts"]) {
  const source = readFileSync(join(root, "packages/pi-better-background-tasks/src", name), "utf8");
  writeFileSync(join(background, name.replace(/\.ts$/, ".mjs")), ts.transpileModule(source.replaceAll(/(from\s+["'][^"']+)\.(ts|js)(["'])/g, "$1.mjs$3"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText);
}
mkdirSync(join(target, "coordinator/src"), { recursive: true });
for (const name of ["index.ts", ...readdirSync(join(root, "packages/operation-coordinator/src")).filter(name => name.endsWith(".ts")).map(name => `src/${name}`)]) {
  const source = readFileSync(join(root, "packages/operation-coordinator", name), "utf8");
  writeFileSync(join(target, "coordinator", name.replace(/\.ts$/, ".mjs")), "// Generated canonical coordinator. Do not edit directly.\n" + ts.transpileModule(source.replaceAll(/(from\s+["'][^"']+)\.ts(["'])/g, "$1.mjs$2"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText);
}
// Carry only the canonical passive snapshot, not supervisor management methods.
const supervisor = ts.createSourceFile("supervisor.ts", readFileSync(join(root, "packages/pi-better-background-tasks/src/supervisor/supervisor.ts"), "utf8"), ts.ScriptTarget.Latest, true);
const snapshotPrinter = ts.createPrinter();
const observed = ts.createSourceFile("observed-waits.ts", readFileSync(join(root, "packages/pi-better-background-tasks/src/observed-waits.ts"), "utf8"), ts.ScriptTarget.Latest, true);
writeFileSync(join(background, "terminal-publication.mjs"), "// Generated canonical terminal publication. Do not edit directly.\n" + ts.transpileModule(
  'import { existsSync, statSync } from "node:fs";\n' + observed.statements.filter(s => ts.isFunctionDeclaration(s) && ["terminalOutcome", "evidenceFor", "supervisorTerminalPublication"].includes(s.name?.text)).map(s => snapshotPrinter.printNode(ts.EmitHint.Unspecified, s, observed)).join("\n"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
const summary = supervisor.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === "launchSummary");
const klass = supervisor.statements.find(s => ts.isClassDeclaration(s) && s.members.some(m => m.name?.getText(supervisor) === "snapshot"));
const snapshotMethod = klass.members.find(m => m.name?.getText(supervisor) === "snapshot");
writeFileSync(join(background, "snapshot.mjs"), ts.transpileModule(
  'import { supervisorPaths, readLaunchRecord, readTerminalRecord, readLostRecord, readClaimRecord, readCommandRecord, readStopRequest, readCleanupRecord } from "./supervisor/store.mjs";\n' +
  snapshotPrinter.printNode(ts.EmitHint.Unspecified, summary, supervisor) + '\nexport function snapshot(directory, taskId) ' + snapshotMethod.body.getText(supervisor).replaceAll("this.directory", "directory"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
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
for (const name of ["parse.ts", "log-cursor.ts", "shared-log-utils.ts", "health-observation.ts", "shared-stall-detector.ts", "shared-harness-settings.ts"]) {
  const source = readFileSync(join(root, "packages/pi-better-subagents", name), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    transformers: { before: [context => node => ts.visitEachChild(node, child => {
      if (name === "health-observation.ts" && ts.isFunctionDeclaration(child) && child.name?.text === "loadHealthThresholdsFromConfig") return undefined;
      if (!ts.isImportDeclaration(child) || !ts.isStringLiteral(child.moduleSpecifier)) return child;
      if (name === "health-observation.ts" && child.moduleSpecifier.text === "./config.ts") return undefined;
      const path = child.moduleSpecifier.text === "./registry.ts" ? "./log-paths.mjs" : child.moduleSpecifier.text.replace(/\.ts$/, ".mjs");
      return ts.factory.updateImportDeclaration(child, child.modifiers, child.importClause, ts.factory.createStringLiteral(path), child.attributes);
    }, context)] } }).outputText;
  writeFileSync(join(target, name.replace(/\.ts$/, ".mjs")), `// Generated from packages/pi-better-subagents/${name}. Do not edit directly.\n${output}`);
}
for (const name of ["widget.mjs", "health-surface.mjs"]) writeFileSync(join(target, name), readFileSync(join(root, "packages/pi-better-subagents", name)));
const spawn = ts.createSourceFile("spawn.ts", readFileSync(join(root, "packages/pi-better-subagents/spawn.ts"), "utf8"), ts.ScriptTarget.Latest, true);
const processFunctions = [
  ...spawn.statements.filter(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "processExists").map(statement => printer.printNode(ts.EmitHint.Unspecified, statement, spawn)),
  ...registry.statements.filter(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "effectiveStatus").map(statement => printer.printNode(ts.EmitHint.Unspecified, statement, registry)),
];
writeFileSync(join(target, "process-status.mjs"), "// Generated canonical read-only process observation.\n" + ts.transpileModule(processFunctions.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
