import { defineConfig } from "vitest/config";
import path from "node:path";
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname) } },
  // Next compiles JSX with the automatic runtime (no `import React`); do the same so page components can be rendered in tests.
  esbuild: { jsx: "automatic" },
  test: { include: ["tests/unit/**/*.test.ts"], environment: "node" },
});
