import assert from "node:assert/strict";
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { describeSandboxSupport } from "../sandbox-core/index.ts";
import { createTaskExecutor } from "./exec.ts";
import { createRunApplicationToolDefinition } from "./application.ts";

const support = describeSandboxSupport();
// Skip is right on a developer machine without a backend, but the lane whose
// whole job is that backend must not report green for a skipped security test.
const requiredBackend = process.env.PI_SANDBOX_REQUIRE_BACKEND;
if (requiredBackend && (!support.supported || support.backend !== requiredBackend)) {
    throw new Error(support.supported
        ? `Real ${requiredBackend} backend required but this runner selected ${support.backend}`
        : `Real ${requiredBackend} backend required but ${support.reason}`);
}

test("direct executable tokens cannot become env assignments that launch an unchecked shell", {
    skip: support.supported ? false : support.reason,
}, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "application-env-target-")));
    const run = createTaskExecutor({ requireLaunchPlan: () => ({ confined: true as const,
        profilePath: join(root, "task.sb"), policy: { writableRoot: root, home: homedir(),
            permissions: { projectFiles: "read-write" as const, outsideProject: "read" as const,
                storedCredentials: "read" as const, commands: true, shell: false, network: false,
                commandTimeoutSeconds: 15 } } }) });
    try {
        let output = "";
        await assert.rejects(run({ kind: "argv", execPath: "APP_ENV_PROBE=1",
            execArgs: ["/bin/sh", "-c", "printf unchecked-shell"] }, root, { onData: (chunk) => { output += chunk; } }),
        /ENOENT|not found|executable/i);
        assert.equal(output.includes("unchecked-shell"), false);
        const alias = join(root, "literal=name");
        symlinkSync("/usr/bin/printf", alias);
        let literalOutput = "";
        const result = await run({ kind: "argv", execPath: alias, execArgs: ["%s", "literal; argument"] }, root,
            { onData: (chunk) => { literalOutput += chunk; } });
        assert.equal(result.exitCode, 0);
        assert.equal(literalOutput, "literal; argument");
        const trueAlias = join(root, "runner=1");
        symlinkSync("/usr/bin/true", trueAlias);
        let aliasOutput = "";
        const aliasResult = await run({ kind: "argv", execPath: trueAlias,
            execArgs: ["/bin/sh", "-c", "printf unchecked-alias-shell"] }, root,
        { onData: (chunk) => { aliasOutput += chunk; } });
        assert.equal(aliasResult.exitCode, 0);
        assert.equal(aliasOutput, "");
        for (const [name, source, error] of [
            ["plain-text", 'printf "implicit-shell-%s" "$((6 * 7))"', /shell fallback is disabled/],
            ["shell-script", '#!/bin/sh\nprintf explicit-shell', /Shell scripts are Off/],
        ] as const) {
            const script = join(root, name);
            writeFileSync(script, source, { mode: 0o700 });
            let scriptOutput = "";
            const rejected = await run({ kind: "argv", execPath: script, execArgs: [] }, root,
                { onData: (chunk) => { scriptOutput += chunk; } });
            assert.equal(rejected.exitCode, 126);
            assert.match(scriptOutput, error);
            assert.equal(scriptOutput.includes("shell-42"), false);
        }
        const interpreter = join(root, "interpreter");
        symlinkSync("/bin/sh", interpreter);
        const aliasedScript = join(root, "aliased-shell-script");
        writeFileSync(aliasedScript, `#!${interpreter}\nprintf SHEBANG_ALIAS_EXECUTED`, { mode: 0o700 });
        let shebangOutput = "";
        const shebangResult = await run({ kind: "argv", execPath: aliasedScript, execArgs: [] }, root,
            { onData: (chunk) => { shebangOutput += chunk; } });
        assert.equal(shebangResult.exitCode, 126);
        assert.match(shebangOutput, /Shell scripts are Off/);
        assert.equal(shebangOutput.includes("SHEBANG_ALIAS_EXECUTED"), false);
        const shellDirectory = join(root, "shell-bin");
        mkdirSync(shellDirectory);
        copyFileSync(realpathSync("/bin/sh"), join(shellDirectory, "sh"));
        const hardlinkedInterpreter = join(root, "hardlinked-interpreter");
        linkSync(join(shellDirectory, "sh"), hardlinkedInterpreter);
        const hardlinkedScript = join(root, "hardlinked-shell-script");
        writeFileSync(hardlinkedScript, `#!${hardlinkedInterpreter}\nprintf HARDLINK_SHELL_EXECUTED`, { mode: 0o700 });
        let hardlinkOutput = "";
        const hardlinkResult = await run({ kind: "argv", execPath: hardlinkedScript, execArgs: [] }, root,
            { env: { PATH: shellDirectory + delimiter + process.env.PATH }, onData: (chunk) => { hardlinkOutput += chunk; } });
        assert.equal(hardlinkResult.exitCode, 126);
        assert.match(hardlinkOutput, /Shell scripts are Off/);
        assert.equal(hardlinkOutput.includes("HARDLINK_SHELL_EXECUTED"), false);
        const nodeScript = join(root, "node-application");
        writeFileSync(nodeScript, `#!${process.execPath}\nconsole.log(process.argv[2]);`, { mode: 0o700 });
        let nodeOutput = "";
        const nodeResult = await run({ kind: "argv", execPath: nodeScript, execArgs: ["literal; $HOME"] }, root,
            { onData: (chunk) => { nodeOutput += chunk; } });
        assert.equal(nodeResult.exitCode, 0, nodeOutput);
        assert.equal(nodeOutput, "literal; $HOME\n");
        const tool = createRunApplicationToolDefinition(root, run);
        await assert.rejects(tool.execute("signal", { executable: process.execPath,
            args: ["-e", 'process.kill(process.pid, "SIGTERM")'] }),
        /terminated by signal SIGTERM|Command exited with code 143/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});