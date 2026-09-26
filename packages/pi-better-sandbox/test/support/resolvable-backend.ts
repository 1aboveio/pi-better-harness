import { spawnSync } from "node:child_process";
import { describeSandboxSupport, type SandboxSeams } from "../../shared-sandbox-core.ts";

// Only in-process file guards use this seam. They never launch a child;
// SDK registrations and shell tests must use a real OS backend.
export const IN_PROCESS_BACKEND: SandboxSeams = {
    platform: () => "linux",
    lookupExecutable: (name) => name === "bwrap" ? "/test-only/bwrap" : undefined,
};

export function realBackendSkip(): false | string {
    const support = describeSandboxSupport();
    const required = process.env.PI_SANDBOX_REQUIRE_BACKEND;
    if (required && (!support.supported || support.backend !== required)) {
        throw new Error(`PI_SANDBOX_REQUIRE_BACKEND=${required} but this runner selected ${support.supported ? support.backend : support.reason}`);
    }
    if (!support.supported) return `requires a real sandbox backend: ${support.reason}`;
    const probe = support.backend === "linux-bubblewrap"
        ? spawnSync(support.executable, ["--ro-bind", "/", "/", "--", "/bin/true"], { encoding: "utf8" })
        : spawnSync(support.executable, ["-p", "(version 1) (allow default)", "/usr/bin/true"], { encoding: "utf8" });
    if (probe.status !== 0) {
        const reason = probe.error?.message ?? probe.stderr;
        if (required) throw new Error(`PI_SANDBOX_REQUIRE_BACKEND=${required} but ${support.backend} cannot start: ${reason}`);
        return `requires usable ${support.backend}: ${reason}`;
    }
    return false;
}
