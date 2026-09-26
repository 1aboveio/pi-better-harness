/** Kernel-confined operations for Pi's built-in file tools. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import type { ReadOperations, WriteOperations, EditOperations } from "@earendil-works/pi-coding-agent";
import {
    compileWritePolicy, evaluateReadAccess, evaluateWriteAccess, maybeBuildSandboxCommand,
    type SandboxWritePolicy,
} from "../sandbox-core/index.ts";

export interface TaskFileController {
    requireLaunchPlan(): { confined: false } | { confined: true; policy: SandboxWritePolicy; profilePath: string };
}

// The SDK truncates display output after reading. This separate operation cap
// bounds worker memory and pipe traffic, and rejects rather than truncates files.
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;

// Fixed program: tool-supplied path/content are JSON on stdin, never argv/code.
const FILE_WORKER = String.raw`
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const MAX = 8 * 1024 * 1024;
let input = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  if (input.length + chunk.length > 12 * 1024 * 1024) {
    process.stdout.write(JSON.stringify({error:'File operation request exceeds 12 MiB',code:'EFBIG'}));
    process.exit(1);
  }
  input = Buffer.concat([input, chunk]);
});
process.stdin.on('end', async () => {
  try {
    const { operation, path, content } = JSON.parse(input.toString('utf8'));
    if (typeof path !== 'string') throw new Error('Invalid file path');
    let data;
    switch (operation) {
      case 'read':
      case 'mime': {
        const handle = await fs.open(path, 'r');
        try {
          if (operation === 'mime') {
            const sample = Buffer.alloc(4100);
            const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
            data = sample.subarray(0, bytesRead).toString('base64');
          } else {
            const chunks = [];
            let size = 0;
            for (;;) {
              const chunk = Buffer.alloc(Math.min(65536, MAX + 1 - size));
              const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
              if (!bytesRead) break;
              size += bytesRead;
              if (size > MAX) throw Object.assign(new Error('File exceeds 8 MiB operation limit'), {code:'EFBIG'});
              chunks.push(chunk.subarray(0, bytesRead));
            }
            data = Buffer.concat(chunks, size).toString('base64');
          }
        } finally { await handle.close(); }
        break;
      }
      case 'access-read': await fs.access(path, constants.R_OK); break;
      case 'access-edit': await fs.access(path, constants.R_OK | constants.W_OK); break;
      case 'existing-directory':
        if (!(await fs.stat(path)).isDirectory()) throw new Error('Not an existing directory');
        break;
      case 'mkdir': await fs.mkdir(path, {recursive:true}); break;
      case 'write':
        if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX)
          throw Object.assign(new Error('File exceeds 8 MiB operation limit'), {code:'EFBIG'});
        await fs.writeFile(path, content, 'utf8'); break;
      default: throw new Error('Unknown file operation');
    }
    process.stdout.write(JSON.stringify({ok:true, data}));
  } catch (error) {
    process.stdout.write(JSON.stringify({error: String(error.message || error), code: error.code}));
    process.exitCode = 1;
  }
});`;

type Operation = "read" | "mime" | "access-read" | "access-edit" | "mkdir" | "existing-directory" | "write";

function mimeType(data: Buffer): string | null {
    const ascii = (at: number, text: string) => data.toString("ascii", at, at + text.length) === text;
    if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
        return data[3] === 0xf7 ? null : "image/jpeg";
    }
    if (data.length >= 16 && data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) &&
        data.readUInt32BE(8) === 13 && ascii(12, "IHDR")) {
        for (let offset = 8; offset + 8 <= data.length;) {
            if (ascii(offset + 4, "acTL")) return null;
            if (ascii(offset + 4, "IDAT")) break;
            const next = offset + 12 + data.readUInt32BE(offset);
            if (next <= offset || next > data.length) break;
            offset = next;
        }
        return "image/png";
    }
    if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
    if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
    if (ascii(0, "BM") && data.length >= 30) {
        const size = data.readUInt32LE(2);
        const offset = data.readUInt32LE(10);
        const dib = data.readUInt32LE(14);
        const planes = dib === 12 ? data.readUInt16LE(22) : data.readUInt16LE(26);
        const bits = dib === 12 ? data.readUInt16LE(24) : data.readUInt16LE(28);
        if ((size === 0 || size >= 26) && offset >= 14 + dib && (size === 0 || offset < size) &&
            (dib === 12 || (dib >= 40 && dib <= 124)) && planes === 1 && [1, 4, 8, 16, 24, 32].includes(bits)) {
            return "image/bmp";
        }
    }
    return null;
}

export function createTaskFileOperations(controller: TaskFileController): {
    read: ReadOperations; write: WriteOperations; edit: EditOperations;
} {
    async function run(operation: Operation, path: string, content?: string): Promise<Buffer | void> {
        const plan = controller.requireLaunchPlan();
        if (!plan.confined) {
            switch (operation) {
                case "read": return readFile(path);
                case "mime": {
                    const handle = await open(path, "r");
                    try {
                        const sample = Buffer.alloc(4100);
                        const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
                        return sample.subarray(0, bytesRead);
                    } finally { await handle.close(); }
                }
                case "access-read": return access(path, constants.R_OK);
                case "access-edit": return access(path, constants.R_OK | constants.W_OK);
                case "existing-directory":
                    if (!(await stat(path)).isDirectory()) throw new Error("Not an existing directory");
                    return;
                case "mkdir": await mkdir(path, { recursive: true }); return;
                case "write": return writeFile(path, content!, "utf8");
            }
        }

        const policy = compileWritePolicy(plan.policy);
        const writing = operation === "write" || operation === "mkdir" || operation === "access-edit";
        const decision = writing ? evaluateWriteAccess(path, policy) : evaluateReadAccess(path, policy);
        if (!decision.allowed && operation !== "existing-directory") {
            if (operation === "mkdir") {
                // SDK write prepares the parent even when it already exists.
                // Confirm that no-op inside confinement; never grant mkdir.
                try { await run("existing-directory", path); return; } catch { /* Preserve the original refusal. */ }
            }
            const detail = "deniedBy" in decision ? ` (protected by ${decision.deniedBy})` : "";
            throw new Error(`Task sandbox refused to ${writing ? "write" : "read"} ${decision.path}: ${decision.reason}${detail}.`);
        }
        if (operation === "access-edit") {
            const readable = evaluateReadAccess(path, policy);
            if (!readable.allowed) throw new Error(`Task sandbox refused to read ${readable.path}: ${readable.reason}.`);
        }
        if (content !== undefined && Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
            throw new Error("File exceeds 8 MiB operation limit");
        }
        const payload = Buffer.from(JSON.stringify({ operation, path, content }), "utf8");
        if (payload.length > MAX_REQUEST_BYTES) throw new Error("File operation request exceeds 12 MiB");

        // Internal helper privilege only: never alter file/credential rules.
        const helperPolicy: SandboxWritePolicy = {
            ...plan.policy,
            permissions: {
                projectFiles: "read-write", outsideProject: "read", storedCredentials: "read",
                ...plan.policy.permissions,
                commands: true, network: false,
            },
        };
        const profilePath = `${plan.profilePath}.${randomUUID()}.files.sb`;
        let command;
        try {
            command = maybeBuildSandboxCommand({
                execPath: process.execPath, execArgs: ["-e", FILE_WORKER],
                profilePath, policy: helperPolicy,
            }, { sandboxEnabled: true, explicitSandbox: true });
        } catch (error) {
            void unlink(profilePath).catch(() => {});
            throw error;
        }
        if (!command) throw new Error("Task file sandbox backend unavailable");

        return new Promise<Buffer | void>((resolve, reject) => {
            const child = spawn(command.file, command.fileArgs, {
                stdio: ["pipe", "pipe", "pipe"],
                env: { PATH: process.env.PATH ?? "", HOME: plan.policy.home },
            });
            const chunks: Buffer[] = [];
            let size = 0;
            let stderr = "";
            let finished = false;
            const timer = setTimeout(() => child.kill(), 30_000);
            child.stdout.on("data", (chunk: Buffer) => {
                size += chunk.length;
                if (size > MAX_RESPONSE_BYTES) child.kill();
                else chunks.push(chunk);
            });
            child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2048); });
            child.stdin.on("error", () => {}); // An early sandbox failure may close stdin.
            child.on("error", (error) => {
                if (!finished) { finished = true; clearTimeout(timer); void unlink(profilePath).catch(() => {}); reject(error); }
            });
            child.on("close", (code) => {
                void unlink(profilePath).catch(() => {});
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                if (size > MAX_RESPONSE_BYTES) return reject(new Error("File operation response exceeds 12 MiB"));
                let result: { ok?: boolean; data?: string; error?: string; code?: string };
                try { result = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
                catch { return reject(new Error(`Task file sandbox failed (${code}): ${stderr || "no worker response"}`)); }
                if (!result.ok) {
                    const error = new Error(result.error ?? `Task file sandbox failed (${code})`) as NodeJS.ErrnoException;
                    error.code = result.code;
                    return reject(error);
                }
                if (code !== 0) return reject(new Error(`Task file sandbox exited ${code}: ${stderr}`));
                resolve(result.data === undefined ? undefined : Buffer.from(result.data, "base64"));
            });
            child.stdin.end(payload);
        });
    }

    return {
        read: {
            readFile: (path) => run("read", path) as Promise<Buffer>,
            access: (path) => run("access-read", path) as Promise<void>,
            detectImageMimeType: async (path) => mimeType(await run("mime", path) as Buffer),
        },
        write: {
            mkdir: (path) => run("mkdir", path) as Promise<void>,
            writeFile: (path, content) => run("write", path, content) as Promise<void>,
        },
        edit: {
            readFile: (path) => run("read", path) as Promise<Buffer>,
            access: (path) => run("access-edit", path) as Promise<void>,
            writeFile: (path, content) => run("write", path, content) as Promise<void>,
        },
    };
}
