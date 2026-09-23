import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // Database-backed tests share one Atlas M0 cluster and use fixed document
    // ids. Running files in parallel had them opening a client per worker and
    // competing for server selection, which produced flaky 5s timeouts.
    fileParallelism: false,
    // Unit tests must never touch the network or Mongo. The few tests that do
    // (live classifier fixtures) skip themselves when no API key is present.
    testTimeout: 30_000,
    // The first database-backed test in a file pays for a cold Atlas connect:
    // DNS SRV lookup, TLS handshake and replica-set discovery. On a slow link
    // that exceeded the 10s default and failed the hook rather than the code.
    hookTimeout: 45_000,
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
