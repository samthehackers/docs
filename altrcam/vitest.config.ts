import { defineConfig } from "vitest/config";
import path from "node:path";
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname) } },
  esbuild: { jsx: "automatic" }, // tsconfig says "preserve" (Next compiles JSX); unit tests that import a component need it transformed
  test: { include: ["tests/unit/**/*.test.ts"], environment: "node" },
});
