import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests against a LOCAL Supabase stack (Auth + Postgres + Mailpit), never a hosted project.
 * Run them with `npm run test:e2e:local` (scripts/e2e-local.sh), which starts the stack, applies the migrations and passes
 * the local URLs and keys below. Without a running local stack the specs skip themselves.
 *
 * The app is built and started with the env names the Vercel Supabase integration uses in production (POSTGRES_URL with
 * its extra query parameters, SUPABASE_SECRET_KEY, publishable key) and WITHOUT FAL_KEY, payment, Resend or Upstash keys,
 * so it runs the way the live deployment does today.
 */
const port = Number(process.env.E2E_PORT ?? 3000);
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 120_000,
  workers: 1, // one shared database and mailbox
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${port}`,
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  webServer: {
    command: `npm run build && npx next start -p ${port}`,
    url: `http://localhost:${port}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
});
