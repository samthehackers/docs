import { defineConfig } from "vitest/config";
import path from "node:path";

/** Runs against a REAL PostgreSQL (TEST_DATABASE_URL) through the production driver. See tests/integration. */
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname) } },
  test: { include: ["tests/integration/**/*.test.ts"], environment: "node", testTimeout: 30_000, hookTimeout: 60_000, fileParallelism: false },
});
