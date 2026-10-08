import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  use: { baseURL: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000" },
  projects: [
    { name: "setup", testMatch: /global\.setup\.ts/ },
    { name: "flow", testMatch: /.*\.spec\.ts/, dependencies: ["setup"] },
  ],
  webServer: {
    command: "npm run build && npm run start",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 300_000,
    env: { PAYSTACK_API_URL: "http://127.0.0.1:4010" },
  },
});
