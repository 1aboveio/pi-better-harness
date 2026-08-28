import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bashSingleQuote, resolveDefaultShell, toMsysPath, withWindowsLogRedirect } from "./process.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn() };
});

const mockExists = vi.mocked(existsSync);
const realPlatform = process.platform;

/** Normalize for assertions so Windows and POSIX joins compare equal. */
const norm = (value: string): string => value.replace(/\\/g, "/").toLowerCase();

function fakePlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

afterEach(() => {
  fakePlatform(realPlatform);
  vi.unstubAllEnvs();
  mockExists.mockReset();
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

  it("passes UNC paths through in forward-slash form, which MSYS resolves as UNC", () => {
    expect(toMsysPath("\\\\server\\share\\log")).toBe("//server/share/log");
  });

  it("leaves relative and already-POSIX paths unchanged", () => {
    expect(toMsysPath("relative/log")).toBe("relative/log");
    expect(toMsysPath("/already/posix")).toBe("/already/posix");
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
      { shell: false, argv: ["cmd.exe", "/c", "echo", "ok"] },
      "C:\\Temp\\log.log",
    );
    expect(result.shell).toBe(true);
    expect(result.command).toBe(
      "exec >> '/c/Temp/log.log' 2>&1\nexport MSYS2_ARG_CONV_EXCL='*'\nexec 'cmd.exe' '/c' 'echo' 'ok'",
    );
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
    expect(mockExists).not.toHaveBeenCalled();
  });

  it("prefers the first existing Git for Windows candidate", () => {
    vi.stubEnv("PI_BETTER_BACKGROUND_TASKS_SHELL", "");
    fakePlatform("win32");
    mockExists.mockImplementation((p) => norm(String(p)) === norm("C:\\Program Files\\Git\\bin\\bash.exe"));
    expect(resolveDefaultShell()).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
  });

  it("falls back to a PATH bash outside System32 and WindowsApps", () => {
    vi.stubEnv("PI_BETTER_BACKGROUND_TASKS_SHELL", "");
    vi.stubEnv(
      "PATH",
      "C:\\Windows\\System32;C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Real\\Tools",
    );
    fakePlatform("win32");
    mockExists.mockImplementation((p) => norm(String(p)).endsWith("c:/real/tools/bash.exe"));
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
