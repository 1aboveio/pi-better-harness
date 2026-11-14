// Generated fixed launch domain from packages/pi-better-subagents/managed-worker.mjs. Do not edit directly.
/** Fixed SDK bootstrap for server-owned workers; never executes a PATH-selected launcher. */
import "./managed-launch-bootstrap.mjs";
import preflight from "./child-preflight.mjs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
if (Number(process.versions.node.split(".")[0]) < 24)
    throw new Error("Managed subagents require Node 24 or newer");
if (!process.env.PI_MANAGED_SUBAGENT)
    throw new Error("Managed worker has no admitted launch intent");
const sdk = createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent");
const { main } = await import(pathToFileURL(join(dirname(sdk), "main.js")).href);
await main(process.argv.slice(2), { extensionFactories: [{ name: "managed-subagent-preflight", factory: preflight }] });
