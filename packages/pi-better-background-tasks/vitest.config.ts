import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Private TMPDIR (and so task registry) per test file (#324).
    globalSetup: ["./src/test-support/isolate-registry-root.ts"],
    setupFiles: ["./src/test-support/isolate-registry.ts"],
  },
});
