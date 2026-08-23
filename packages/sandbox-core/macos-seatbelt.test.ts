/**
 * Integration: the macOS backend's generated profile is enforced by the real
 * kernel — writes land inside the writable root, and compiled deny paths stay
 * unwritable even though they sit inside it.
 * @covers sandbox.command-wrapper
 * @covers sandbox.write-containment
 * @level integration
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { buildSandboxCommand } from "./index.ts";

const unsupported = process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")
    ? "requires macOS /usr/bin/sandbox-exec"
    : false;

// The macOS confinement lane sets PI_SANDBOX_REQUIRE_BACKEND=macos-seatbelt, so
// a runner that lost /usr/bin/sandbox-exec fails here instead of reporting a
// skipped suite as a green lane. Other values leave the skip alone: this file is
// macOS-only by construction and legitimately skips on a Linux lane.
if (process.env.PI_SANDBOX_REQUIRE_BACKEND === "macos-seatbelt" && unsupported !== false) {
    throw new Error(`PI_SANDBOX_REQUIRE_BACKEND=macos-seatbelt but this runner ${unsupported}.`);
}

describe("macOS seatbelt confinement (real kernel)", { skip: unsupported }, () => {
    function runConfined(base: string, root: string, denyWrite: string[], script: string) {
        const command = buildSandboxCommand({
            profilePath: join(base, "profile.sb"),
            policy: { writableRoot: root, home: homedir(), denyWrite },
            execPath: "/bin/sh",
            execArgs: ["-c", script],
        });
        assert.equal(command.file, "/usr/bin/sandbox-exec");
        return spawnSync(command.file, command.fileArgs, { cwd: root, encoding: "utf8" });
    }

    // @covers sandbox.command-wrapper
    // @level integration
    it("allows writes inside the writable root", () => {
        const base = realpathSync(mkdtempSync(join(tmpdir(), "sbxcore-seatbelt-allow-")));
        const root = join(base, "project");
        mkdirSync(root, { recursive: true });
        try {
            const result = runConfined(base, root, [], 'printf inside-ok > "$PWD/allowed.txt"');
            assert.equal(result.status, 0, `${result.stdout ?? ""}${result.stderr ?? ""}`);
            assert.equal(readFileSync(join(root, "allowed.txt"), "utf8"), "inside-ok");
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @fails-without-fix sandbox.write-containment
    // @covers sandbox.write-containment
    // @level integration
    it("denies a compiled deny-path file and subtree inside the writable root", () => {
        const base = realpathSync(mkdtempSync(join(tmpdir(), "sbxcore-seatbelt-deny-")));
        const root = join(base, "project");
        const hooks = join(root, ".git", "hooks");
        mkdirSync(hooks, { recursive: true });
        const denyWrite = [join(root, ".env"), hooks];
        try {
            const envWrite = runConfined(base, root, denyWrite, `printf leak > "${join(root, ".env")}"`);
            assert.notEqual(envWrite.status, 0, "a denied file must fail at the OS boundary");
            assert.equal(existsSync(join(root, ".env")), false, "a denied write must create no host file");

            const hookWrite = runConfined(base, root, denyWrite, `printf leak > "${join(hooks, "pre-commit")}"`);
            assert.notEqual(hookWrite.status, 0, "a denied subtree must fail at the OS boundary");
            assert.equal(existsSync(join(hooks, "pre-commit")), false, "a denied write must create no host file");

            // Positive control: the root is not accidentally deny-all.
            const allowed = runConfined(base, root, denyWrite, 'printf still-ok > "$PWD/still-allowed.txt"');
            assert.equal(allowed.status, 0, `${allowed.stdout ?? ""}${allowed.stderr ?? ""}`);
            assert.equal(readFileSync(join(root, "still-allowed.txt"), "utf8"), "still-ok");
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @covers sandbox.command-wrapper
    // @level integration
    it("leaves reads unrestricted and inherits the caller environment", () => {
        const base = realpathSync(mkdtempSync(join(tmpdir(), "sbxcore-seatbelt-read-")));
        const root = join(base, "project");
        mkdirSync(root, { recursive: true });
        try {
            const command = buildSandboxCommand({
                profilePath: join(base, "profile.sb"),
                policy: { writableRoot: root, home: homedir() },
                execPath: "/bin/sh",
                execArgs: ["-c", 'head -c 4 /etc/hosts > /dev/null && printf "%s" "$PI_SANDBOX_CORE_PROBE"'],
            });
            const result = spawnSync(command.file, command.fileArgs, {
                cwd: root,
                encoding: "utf8",
                env: { ...process.env, PI_SANDBOX_CORE_PROBE: "inherited-env-ok" },
            });
            assert.equal(result.status, 0, `${result.stdout ?? ""}${result.stderr ?? ""}`);
            assert.equal(result.stdout, "inherited-env-ok");
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @covers sandbox.command-wrapper
    // @level integration
    it("keeps the network shared with the host", async () => {
        const base = realpathSync(mkdtempSync(join(tmpdir(), "sbxcore-seatbelt-net-")));
        const root = join(base, "project");
        mkdirSync(root, { recursive: true });
        const server = createServer((_request, response) => {
            response.writeHead(200, { "content-type": "text/plain" });
            response.end("host-local-http-ok");
        });
        try {
            await new Promise<void>((done, fail) => {
                server.once("error", fail);
                server.listen(0, "127.0.0.1", done);
            });
            const address = server.address();
            assert.ok(address && typeof address === "object", "server must listen on a concrete local port");

            const command = buildSandboxCommand({
                profilePath: join(base, "profile.sb"),
                policy: { writableRoot: root, home: homedir() },
                execPath: process.execPath,
                execArgs: [
                    "-e",
                    "require('node:http').get(process.argv[1], (r) => { let b = ''; r.setEncoding('utf8'); r.on('data', (c) => b += c); r.on('end', () => process.stdout.write(b)); }).on('error', (e) => { console.error(e); process.exit(1); });",
                    `http://127.0.0.1:${address.port}/proof`,
                ],
            });
            // Async spawn, not spawnSync: the server answering this request runs
            // on this process's event loop, which spawnSync would block.
            const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
                const child = spawn(command.file, command.fileArgs, { cwd: root });
                let stdout = "";
                let stderr = "";
                child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
                child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
                child.on("error", fail);
                child.on("close", (code) => done({ code, stdout, stderr }));
            });
            assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
            assert.equal(result.stdout, "host-local-http-ok");
        } finally {
            await new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done())));
            rmSync(base, { recursive: true, force: true });
        }
    });
});
