#!/usr/bin/env node
// Recover a separate checkout, including failed runs that cannot start another writer.
import { tsImport } from "tsx/esm/api";
const { readMeta } = await tsImport("../registry.ts", import.meta.url);
const { readRetainedResult } = await tsImport("../retained-result.ts", import.meta.url);
const { exportWorkspace } = await tsImport("../isolated-workspace.ts", import.meta.url);
try {
    const [, , id, destination] = process.argv;
    if (!/^sa_[a-z0-9]+_[a-z0-9]+$/i.test(id ?? "") || !destination || process.argv.length !== 4) {
        throw new Error("Usage: pi-subagents-recover <run-id> <new-directory>");
    }
    const meta = readRetainedResult(id) ?? readMeta(id);
    if (!meta?.recipe?.workspace) throw new Error("No saved Git workspace for " + id);
    exportWorkspace(meta.recipe.workspace, id, destination);
    console.log("Recovered " + id + " to " + destination);
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
