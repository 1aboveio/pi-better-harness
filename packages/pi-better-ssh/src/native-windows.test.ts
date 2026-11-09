import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProcessRemoteRunner } from "./process-runner.js";
import { executeRemoteBash } from "./remote-bash.js";
import type { RemoteRunner } from "./shared-ssh-core/index.js";

// -G resolves the real client's configuration without making a network connection.
describe.skipIf(process.platform !== "win32")("native Windows OpenSSH", () => {
  it("overrides caller and config mux options while retaining noninteractive safety", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pi ssh config-"));
    const configPath = join(directory, "ssh config");
    writeFileSync(configPath, [
      "Host windows-test",
      "  HostName 127.0.0.1",
      "  ControlMaster auto",
      "  ControlPersist 600",
      "  ControlPath unwanted-control-socket",
      "  BatchMode no",
      "  RequestTTY force",
      "  ConnectTimeout 120",
    ].join("\n"));
    const processRunner = createProcessRemoteRunner();
    let connections = 0;
    const runner: RemoteRunner = {
      spawn: processRunner.spawn,
      runOnce(spec, maxBytes, timeoutMs, signal) {
        connections += 1;
        return processRunner.runOnce({
          ...spec,
          argv: [
            join(process.env.WINDIR!, "System32", "OpenSSH", "ssh.exe"),
            "-G", "-F", configPath, ...spec.argv!.slice(1),
          ],
        }, maxBytes, timeoutMs, signal);
      },
    };
    try {
      const result = await executeRemoteBash({
        host: "windows-test", command: "hostname", timeout: 10,
        options: { ControlMaster: "yes", ControlPersist: "900", ControlPath: "caller-socket" },
      }, { runner, sessionScope: "native-windows-config" });
      expect(result.exitCode).toBe(0);
      expect(result.mux).toEqual({ state: "down", reused: false });
      expect(connections).toBe(1);
      expect(result.output).toMatch(/^controlmaster false\r?$/m);
      expect(result.output).toMatch(/^controlpersist no\r?$/m);
      expect(result.output).not.toMatch(/^controlpath (?:unwanted-control-socket|caller-socket)\r?$/m);
      expect(result.output).toMatch(/^batchmode yes\r?$/m);
      expect(result.output).toMatch(/^requesttty false\r?$/m);
      expect(result.output).toMatch(/^connecttimeout 10\r?$/m);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
