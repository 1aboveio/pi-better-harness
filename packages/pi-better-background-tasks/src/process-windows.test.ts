import { closeSync, existsSync, mkdtempSync, readFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bashSingleQuote,
  resolveDefaultShell,
  spawnCommand,
  stopProcessGroup,
  toMsysPath,
  withWindowsLogRedirect,
} from "./process.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    closeSync: vi.fn(actual.closeSync),
    existsSync: vi.fn(),
    writeSync: vi.fn(actual.writeSync),
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(), spawnSync: vi.fn() };
});

const mockExists = vi.mocked(existsSync);
const mockClose = vi.mocked(closeSync);
const mockSpawn = vi.mocked(spawn);
const mockSpawnSync = vi.mocked(spawnSync);
const mockWrite = vi.mocked(writeSync);
const realPlatform = process.platform;

/** Normalize for assertions so Windows and POSIX joins compare equal. */
const norm = (value: string): string => value.replace(/\\/g, "/").toLowerCase();

function fakePlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

afterEach(() => {
  fakePlatform(realPlatform);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("toMsysPath", () => {
  it("converts Windows drive paths with backslashes to /drive/... form", () => {
    expect(toMsysPath("C:\\Users\\foo bar\\log.log")).toBe("/c/Users/foo bar/log.log");
    expect(toMsysPath("D:\\Data\\log")).toBe("/d/Data/log");
  });

  it("converts Windows drive paths that already use forward slashes", () => {
    expect(toMsysPath("C:/x/y.log")).toBe("/c/x/y.log");
  });

  it("lowercases the drive letter", () => {
    expect(toMsysPath("E:/Mixed/Case.log")).toBe("/e/Mixed/Case.log");
  });

  it("passes UNC paths through in forward-slash form", () => {
    expect(toMsysPath("\\\\server\\share\\log")).toBe("//server/share/log");
  });

  it("leaves relative and already-POSIX paths unchanged", () => {
    expect(toMsysPath("relative/log")).toBe("relative/log");
    expect(toMsysPath("/already/posix")).toBe("/already/posix");
  });

  it("passes drive-only paths through unchanged", () => {
    expect(toMsysPath("C:")).toBe("C:");
    expect(toMsysPath("C:\\")).toBe("C:/");
  });
});

describe("bashSingleQuote", () => {
  it("quotes plain values", () => {
    expect(bashSingleQuote("plain")).toBe("'plain'");
    expect(bashSingleQuote("")).toBe("''");
  });

  it("escapes embedded single quotes", () => {
    expect(bashSingleQuote("O'Brien")).toBe("'O'\\''Brien'");
    expect(bashSingleQuote("a'b'c")).toBe("'a'\\''b'\\''c'");
  });

  it("keeps spaces, newlines, and expansion characters literal", () => {
    expect(bashSingleQuote("a b$c`d`")).toBe("'a b$c`d`'");
    expect(bashSingleQuote("multi\nline")).toBe("'multi\nline'");
  });
});

describe("withWindowsLogRedirect", () => {
  it("prepends the log redirect to shell commands and keeps the rest of the spec", () => {
    const result = withWindowsLogRedirect(
      { shell: true, command: "echo hi", cwd: "C:\\work", env: { A: "1" } },
      "C:\\Temp\\Out Dir\\log.log",
    );
    expect(result.shell).toBe(true);
    expect(result.command).toBe("exec >> '/c/Temp/Out Dir/log.log' 2>&1\necho hi");
    expect(result.cwd).toBe("C:\\work");
    expect(result.env).toEqual({ A: "1" });
  });

  it("pins the argv trampoline shape: redirect, MSYS2 exclusion, verbatim exec", () => {
    const result = withWindowsLogRedirect(
      { shell: false, argv: ["cmd.exe", "/c", "echo", "ok"], cwd: "C:\\work", env: { A: "1" } },
      "C:\\Temp\\log.log",
    );
    expect(result.shell).toBe(true);
    expect(result.cwd).toBe("C:\\work");
    expect(result.env).toEqual({ A: "1" });
    expect(result.command).toBe(
      "exec >> '/c/Temp/log.log' 2>&1\nexport MSYS2_ARG_CONV_EXCL='*'\nexec 'cmd.exe' '/c' 'echo' 'ok'",
    );
  });

  it("overrides inherited MSYS2 conversion settings for raw argv", () => {
    vi.stubEnv("MSYS2_ARG_CONV_EXCL", "/existing");
    const result = withWindowsLogRedirect(
      { shell: false, argv: ["cmd.exe", "/c", "/opt/x.sh"] },
      "C:\\Temp\\log.log",
    );

    expect(result.command).toContain("export MSYS2_ARG_CONV_EXCL='*'");
  });

  it("single-quotes argv values with spaces and embedded quotes", () => {
    const result = withWindowsLogRedirect(
      { shell: false, argv: ["node", "hello world", "O'Brien"] },
      "C:\\Temp\\log.log",
    );
    expect(result.command).toContain("exec 'node' 'hello world' 'O'\\''Brien'");
  });

  it("escapes single quotes in the log path itself", () => {
    const result = withWindowsLogRedirect({ shell: true, command: "echo hi" }, "C:\\Temp\\it's\\log");
    expect(result.command?.startsWith("exec >> '/c/Temp/it'\\''s/log' 2>&1")).toBe(true);
  });
});

describe("resolveDefaultShell", () => {
  it("prefers the PI_BETTER_BACKGROUND_TASKS_SHELL override on any platform", () => {
    vi.stubEnv("PI_BETTER_BACKGROUND_TASKS_SHELL", "D:\\custom\\bash.exe");
    fakePlatform("win32");
    expect(resolveDefaultShell()).toBe("D:\\custom\\bash.exe");
    fakePlatform("linux");
    expect(resolveDefaultShell()).toBe("D:\\custom\\bash.exe");
  });

  it("short-circuits to /bin/bash on POSIX without consulting the filesystem", () => {
    vi.stubEnv("PI_BETTER_BACKGROUND_TASKS_SHELL", "");
    fakePlatform("linux");
    expect(resolveDefaultShell()).toBe("/bin/bash");
    // Pins the spawn-time cost contract: resolution is lazy per spawn, so the
    // POSIX fast path must not probe the filesystem at all.
    expect(mockExists).not.toHaveBeenCalled();
  });

  it("prefers the first existing Git for Windows candidate", () => {
    vi.stubEnv("PI_BETTER_BACKGROUND_TASKS_SHELL", "");
    fakePlatform("win32");
    mockExists.mockImplementation((p) => norm(String(p)) === norm("C:\\Program Files\\Git\\bin\\bash.exe"));
    expect(resolveDefaultShell()).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
  });

  it("prefers an earlier Git candidate over a later one", () => {
    vi.stubEnv("PI_BETTER_BACKGROUND_TASKS_SHELL", "");
    fakePlatform("win32");
    mockExists.mockImplementation(
      (p) => norm(String(p)) === norm("C:\\Program Files (x86)\\Git\\bin\\bash.exe"),
    );
    expect(resolveDefaultShell()).toBe("C:\\Program Files (x86)\\Git\\bin\\bash.exe");
  });

  it("prefers Git for Windows candidates over any PATH bash", () => {
    vi.stubEnv("PI_BETTER_BACKGROUND_TASKS_SHELL", "");
    vi.stubEnv("PATH", "C:\\Other\\bin");
    fakePlatform("win32");
    mockExists.mockReturnValue(true);
    expect(resolveDefaultShell()).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
  });

  it("skips System32 and WindowsApps launchers even when they exist on PATH", () => {
    vi.stubEnv("PI_BETTER_BACKGROUND_TASKS_SHELL", "");
    vi.stubEnv(
      "PATH",
      "C:\\Windows\\System32;C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Real\\Tools",
    );
    fakePlatform("win32");
    // Git for Windows is absent in this scenario; System32/WindowsApps/Real
    // Tools all contain a bash.exe, so the System32/WindowsApps skip in
    // resolveDefaultShell — not absence — is what steers resolution to Real\Tools.
    mockExists.mockImplementation(
      (p) => /bash\.exe$/i.test(String(p)) && !norm(String(p)).includes("/git/"),
    );
    expect(norm(resolveDefaultShell())).toBe(norm("C:\\Real\\Tools\\bash.exe"));
  });

  it("does not skip directories that merely contain system32 as a substring", () => {
    vi.stubEnv("PI_BETTER_BACKGROUND_TASKS_SHELL", "");
    vi.stubEnv("PATH", "C:\\Program Files\\system32-tools\\bin");
    fakePlatform("win32");
    mockExists.mockImplementation((p) =>
      norm(String(p)).endsWith("c:/program files/system32-tools/bin/bash.exe"));
    expect(norm(resolveDefaultShell())).toBe(norm("C:\\Program Files\\system32-tools\\bin\\bash.exe"));
  });

  it("falls back to /bin/bash when nothing usable exists, so the failure is a logged spawn error", () => {
    vi.stubEnv("PI_BETTER_BACKGROUND_TASKS_SHELL", "");
    vi.stubEnv("PATH", "C:\\nowhere");
    fakePlatform("win32");
    mockExists.mockReturnValue(false);
    expect(resolveDefaultShell()).toBe("/bin/bash");
  });
});

describe("stopProcessGroup", () => {
  it("terminates the whole task tree via taskkill on Windows", () => {
    fakePlatform("win32");
    mockSpawnSync.mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);
    stopProcessGroup(4242);
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "taskkill",
      ["/T", "/F", "/PID", "4242"],
      expect.objectContaining({ encoding: "utf8", windowsHide: true }),
    );
  });

  it("throws when taskkill cannot be started", () => {
    fakePlatform("win32");
    mockSpawnSync.mockReturnValue({
      error: Object.assign(new Error("spawn taskkill ENOENT"), { code: "ENOENT" }),
    } as unknown as ReturnType<typeof spawnSync>);

    expect(() => stopProcessGroup(4242)).toThrow(/taskkill.*ENOENT/i);
  });

  it("throws when taskkill fails and the process is still alive", () => {
    fakePlatform("win32");
    mockSpawnSync.mockReturnValue({ status: 5, stderr: "Access is denied." } as ReturnType<typeof spawnSync>);
    vi.spyOn(process, "kill").mockReturnValue(true);

    expect(() => stopProcessGroup(4242)).toThrow(/taskkill.*exit 5.*Access is denied/i);
  });

  it("accepts a taskkill race when the process has already exited", () => {
    fakePlatform("win32");
    mockSpawnSync.mockReturnValue({ status: 128, stderr: "not found" } as ReturnType<typeof spawnSync>);
    vi.spyOn(process, "kill").mockImplementation(() => { throw new Error("process gone"); });

    expect(() => stopProcessGroup(4242)).not.toThrow();
  });

  it("signals the process group on POSIX and falls back to the direct pid", () => {
    fakePlatform("linux");
    const killSpy = vi.spyOn(process, "kill").mockImplementation((p) => {
      if (typeof p === "number" && p < 0) throw new Error("group gone");
      return true;
    });
    stopProcessGroup(500, 500, "SIGKILL");
    expect(killSpy).toHaveBeenNthCalledWith(1, -500, "SIGKILL");
    stopProcessGroup(500, 500, "SIGKILL");
    expect(killSpy).toHaveBeenLastCalledWith(500, "SIGKILL");
  });
});

describe("spawnCommand platform gating", () => {
  const fakeChild = { pid: 777, on: () => {}, unref: () => {} } as unknown as ChildProcess;

  it("uses ignore/ignore/ignore stdio, windowsHide, and the redirect on Windows", () => {
    vi.stubEnv("PI_BETTER_BACKGROUND_TASKS_SHELL", "D:\\shell\\bash.exe");
    fakePlatform("win32");
    const log = join(mkdtempSync(join(tmpdir(), "bbt-gate-")), "gate.log");
    mockSpawn.mockImplementation(() => fakeChild);

    const spawned = spawnCommand({ shell: true, command: "echo hi" }, log, true);

    const call = mockSpawn.mock.calls[0]!;
    expect(call[0]).toBe("D:\\shell\\bash.exe");
    const args = call[1] as string[];
    const options = call[2] as { windowsHide: boolean; detached: boolean; stdio: unknown[] };
    expect(args[0]).toBe("-lc");
    expect(args[1]).toContain("exec >> '");
    expect(options).toMatchObject({
      windowsHide: true,
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    expect(readFileSync(log, "utf8")).toContain("--- spawn");
    expect(spawned.pgid).toBe(777);
  });

  it("keeps fd stdio, no windowsHide, and a verbatim command on POSIX", () => {
    vi.stubEnv("PI_BETTER_BACKGROUND_TASKS_SHELL", "");
    fakePlatform("linux");
    const log = join(mkdtempSync(join(tmpdir(), "bbt-gate-")), "gate.log");
    mockSpawn.mockImplementation(() => fakeChild);

    spawnCommand({ shell: true, command: "echo hi" }, log, true);

    const call = mockSpawn.mock.calls[0]!;
    expect(call[0]).toBe("/bin/bash");
    const args = call[1] as string[];
    const options = call[2] as { windowsHide: boolean; detached: boolean; stdio: unknown[] };
    expect(args).toEqual(["-lc", "echo hi"]);
    expect(options).toMatchObject({ windowsHide: false, detached: true });
    expect(options.stdio[0]).toBe("ignore");
    expect(typeof options.stdio[1]).toBe("number");
    expect(typeof options.stdio[2]).toBe("number");
  });

  it("closes the POSIX log fd when writing the spawn marker fails", () => {
    fakePlatform("linux");
    const log = join(mkdtempSync(join(tmpdir(), "bbt-gate-")), "gate.log");
    mockSpawn.mockImplementation(() => fakeChild);
    mockWrite.mockImplementationOnce(() => { throw new Error("marker write failed"); });

    spawnCommand({ shell: true, command: "echo hi" }, log, true);

    const fd = (mockSpawn.mock.calls.at(-1)?.[2] as { stdio: unknown[] }).stdio[1];
    expect(mockClose).toHaveBeenCalledWith(fd);
  });
});
