import { defineConfig } from "@playwright/test";

/**
 * Browser checks that need NO credentials: builds the app with every integration unset and drives the
 * public site in a real browser. Run with `npm run test:public`.
 * Locally, if Playwright's bundled Chromium isn't installed, point PW_CHROMIUM_PATH at any Chromium binary.
 */
const port = 3200;
export default defineConfig({
  testDir: "tests/public",
  timeout: 60_000,
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${port}`,
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  webServer: {
    command: `npm run build && npx next start -p ${port}`,
    url: `http://localhost:${port}/api/health`,
    timeout: 300_000,
    reuseExistingServer: !process.env.CI,
    // Blank every integration, including the names the Vercel Supabase integration sets, so this really runs with none.
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "", NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
      SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "", SUPABASE_SECRET_KEY: "",
      DATABASE_URL: "", POSTGRES_URL: "", POSTGRES_PRISMA_URL: "", POSTGRES_URL_NON_POOLING: "",
    },
  },
});
