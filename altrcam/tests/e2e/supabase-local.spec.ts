/**
 * The whole signed-in app against a LOCAL Supabase stack (real Supabase Auth, real Postgres with the repo's migrations,
 * Mailpit catching the emails). Run with `npm run test:e2e:local`. Skipped when no local stack is running.
 *
 * Covers: sign-up → confirmation email → confirm → dashboard with the ledger balance; every signed-in route renders real
 * data (no error boundary); sign-out; a second user can't see or touch the first user's history and sessions; non-admins
 * are kept out of /admin and an admin (app_metadata.role) gets in; password reset through the emailed link; account
 * deletion removes the rows and the Supabase login; the
 * auth callback refuses off-site redirects. The app runs without FAL_KEY, payment, Resend or Upstash keys, like production.
 */
import { expect, test, type Page } from "@playwright/test";
import { authAdmin, linkFromEmail, localSupabaseRunning, sql } from "./helpers";

const stamp = Date.now();
const A = { email: `alice.${stamp}@example.com`, password: `Alice-${stamp}-pw`, newPassword: `Alice-${stamp}-new`, id: "" };
const B = { email: `bob.${stamp}@example.com`, password: `Bob-${stamp}-pw`, id: "" };
const ERROR_BOUNDARY = "Something went sideways";

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  test.skip(!(await localSupabaseRunning()), "local Supabase is not running (start it with scripts/e2e-local.sh)");
});

async function signUpAndConfirm(page: Page, who: { email: string; password: string }) {
  const started = Date.now();
  await page.goto("/sign-up");
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Create account" }).click();
  // Confirmations are on: no session yet, so the app offers the resend page.
  await expect(page).toHaveURL(/\/verify-email\?email=/);
  await expect(page.getByRole("heading", { name: "Confirm your email" })).toBeVisible();

  const link = await linkFromEmail(who.email, /confirm/i, started);
  await page.goto(link); // Supabase verifies, then redirects to /auth/callback?code=… which signs in and goes on to /dashboard
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { name: /Welcome back/ })).toBeVisible();
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function expectRenders(page: Page, path: string, text: string | RegExp) {
  const res = await page.goto(path);
  expect(res?.status(), path).toBe(200);
  await expect(page.locator("main")).toContainText(text);
  await expect(page.getByText(ERROR_BOUNDARY)).toHaveCount(0);
}

test("sign-up needs the emailed confirmation (even opened in another browser), then the dashboard shows the ledger balance", async ({ page, browser }) => {
  // Before confirming, password sign-in is refused and the person is sent to the resend page, not a dead end.
  const started = Date.now();
  await page.goto("/sign-up");
  await page.getByLabel("Email").fill(A.email);
  await page.getByLabel("Password").fill(A.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/verify-email/);
  await signIn(page, A.email, A.password);
  await expect(page).toHaveURL(/\/verify-email\?email=/);
  await page.getByRole("button", { name: "Resend confirmation email" }).click();
  await expect(page.locator("main").getByRole("status")).toContainText(/Sent\.|wait a minute/); // either is an honest answer
  expect((await page.goto("/dashboard"))?.url()).toMatch(/\/sign-in$/); // no session yet

  // The link is opened somewhere else (say, on a phone): it confirms the address but can't sign that browser in, and says so.
  const link = await linkFromEmail(A.email, /confirm/i, started);
  const phone = await browser.newContext();
  const other = await phone.newPage();
  await other.goto(link);
  await expect(other).toHaveURL(/\/sign-in\?error=other_browser$/);
  await expect(other.locator("main").getByRole("alert")).toContainText("it is confirmed: sign in below");
  await phone.close();

  await signIn(page, A.email, A.password);
  await expect(page).toHaveURL(/\/dashboard$/);

  const db = sql();
  try {
    const [u] = await db`select id from users where email = ${A.email}`;
    expect(u, "the first app page provisioned the user row").toBeTruthy();
    A.id = u.id;
    const [{ total }] = await db`select coalesce(sum(delta), 0)::int as total from credit_ledger where user_id = ${A.id}`;
    expect(total).toBeGreaterThan(0); // the Free signup grant
    const credits = page.locator("div", { has: page.getByText("AI Credits remaining", { exact: true }) }).last();
    await expect(credits).toContainText(total.toLocaleString("en-US"));
  } finally { await db.end(); }
});

test("every signed-in route renders real data for the signed-in user", async ({ page }) => {
  await signIn(page, A.email, A.password);
  await expect(page).toHaveURL(/\/dashboard$/);
  const db = sql();
  try {
    const [{ code }] = await db`select referral_code as code from users where id = ${A.id}`;
    await expectRenders(page, "/dashboard", "AI Credits remaining");
    await expectRenders(page, "/studio", "Live video isn't configured on this deployment yet");
    await expectRenders(page, "/history", "Nothing saved yet.");
    await expectRenders(page, "/presets", "Save preset");
    await expectRenders(page, "/settings", A.email);
    await expectRenders(page, "/settings/password", "Update password");
    await expectRenders(page, "/billing", "Payments aren't available on this deployment yet");
    await expectRenders(page, "/billing/success?ref=alt_missing", /payment|Payment/);
    await expectRenders(page, "/support", "No tickets yet.");
    await expectRenders(page, "/referrals", "Invite friends");
    await expect(page.getByLabel("Your referral link")).toHaveValue(new RegExp(`\\?ref=${code}$`));

    // Writes work too: a support ticket is stored (no email provider needed) and listed.
    await page.goto("/support");
    await page.getByLabel("Subject").fill("E2E ticket");
    await page.getByLabel("How can we help?").fill("This ticket was sent by the local end-to-end test.");
    await page.getByRole("button", { name: "Send ticket" }).click();
    await expect(page.locator("main").getByRole("status")).toContainText("Sent.");
    await page.reload(); // the form also calls router.refresh(); a reload makes the check independent of its timing
    await expect(page.locator("main")).toContainText("E2E ticket");
    const [{ n }] = await db`select count(*)::int as n from support_tickets where user_id = ${A.id}`;
    expect(n).toBe(1);

    // A preset is saved and listed.
    await page.goto("/presets");
    await page.getByLabel("Name").fill("E2E preset");
    await page.getByRole("textbox", { name: "Prompt" }).fill("a watercolor portrait");
    await page.getByRole("button", { name: "Save preset" }).click();
    await expect(page.locator("main")).toContainText("E2E preset");

    // Going live without FAL_KEY is refused honestly (503) before any session is opened or billed.
    const start = await page.request.post("/api/studio/session/start", { data: {} });
    expect(start.status()).toBe(503);
    const [{ s }] = await db`select count(*)::int as s from studio_sessions where user_id = ${A.id}`;
    expect(s).toBe(0);

    // Checkout without payment keys is refused honestly, nothing pending is created.
    const checkout = await page.request.post("/api/payments/checkout", { data: { product: "TOPUP_1K", provider: "paystack" } });
    expect(checkout.status()).toBe(503);

    // A non-admin sees no Admin link and is sent away from /admin; the admin API refuses.
    await expect(page.getByRole("link", { name: "Admin" })).toHaveCount(0);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/dashboard$/);
    expect((await page.request.get("/api/admin/users?q=a")).status()).toBe(403);
  } finally { await db.end(); }

  await signOut(page);
  expect((await page.goto("/dashboard"))?.url()).toMatch(/\/sign-in$/);
  expect((await page.request.get("/api/notifications")).status()).toBe(401);
});

test("a second user can't see or touch the first user's history or sessions", async ({ page }) => {
  const db = sql();
  let tid = 0, sid = "";
  try {
    const [t] = await db`insert into transformations (user_id, title, prompt, type) values (${A.id}, 'ALICE-PRIVATE-STILL', 'alice prompt', 'custom') returning id`;
    tid = t.id;
    const [s] = await db`insert into studio_sessions (id, user_id, max_seconds) values (gen_random_uuid(), ${A.id}, 600) returning id`;
    sid = s.id;
  } finally { await db.end(); }

  await signUpAndConfirm(page, B);
  for (const path of ["/dashboard", "/history"]) {
    await page.goto(path);
    await expect(page.locator("main")).not.toContainText("ALICE-PRIVATE-STILL");
  }
  expect((await page.request.delete(`/api/history/${tid}`)).status()).toBe(404);
  expect((await page.request.post("/api/studio/session/end", { data: { sessionId: sid, reason: "user" } })).status()).toBe(404);
  await page.goto(`/studio?reuse=${tid}`);
  await expect(page.locator("main")).not.toContainText("alice prompt");

  const db2 = sql();
  try {
    const [t] = await db2`select id from transformations where id = ${tid}`;
    expect(t, "Alice's still survived Bob's delete attempt").toBeTruthy();
    const [s] = await db2`select ended_at from studio_sessions where id = ${sid}`;
    expect(s.ended_at).toBeNull();
    const [b] = await db2`select id from users where email = ${B.email}`;
    B.id = b.id;
  } finally { await db2.end(); }
  await signOut(page);
});

test("an admin set through app_metadata gets into /admin; the role can't be set from the browser", async ({ page }) => {
  // Nothing the browser sends can make someone admin: only app_metadata, which needs the secret key.
  await signIn(page, B.email, B.password);
  await expect(page).toHaveURL(/\/dashboard$/);
  const r = await page.evaluate(async () => (await fetch("/api/admin/users?q=x")).status);
  expect(r).toBe(403);
  await signOut(page);

  await authAdmin(`users/${A.id}`, { method: "PUT", body: JSON.stringify({ app_metadata: { role: "admin" } }) });
  await signIn(page, A.email, A.password);
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("link", { name: "Admin" }).first()).toBeVisible();
  await expectRenders(page, "/admin", /overview/i);
  await expectRenders(page, `/admin?tab=users&q=${encodeURIComponent(B.email)}`, B.email);
  expect((await page.request.get(`/api/admin/users?q=${encodeURIComponent("bob.")}`)).status()).toBe(200);
  await page.getByRole("link", { name: "Back to app" }).click(); // the admin header has no account menu
  await expect(page).toHaveURL(/\/dashboard$/);
  await signOut(page);
});

test("password reset through the emailed link, then sign in with the new password", async ({ page }) => {
  const started = Date.now();
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(A.email);
  await page.getByRole("button", { name: "Forgot password?" }).click();
  await expect(page.locator("main").getByRole("status")).toContainText("Check your email for a password reset link.");

  const link = await linkFromEmail(A.email, /reset/i, started);
  await page.goto(link);
  await expect(page).toHaveURL(/\/settings\/password$/);
  await page.getByLabel("New password", { exact: true }).fill(A.newPassword);
  await page.getByLabel("Confirm new password").fill(A.newPassword);
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page.locator("main").getByRole("status")).toContainText("Your password has been updated.");
  await page.goto("/dashboard");
  await signOut(page);

  await signIn(page, A.email, A.password);
  await expect(page.locator("main").getByRole("status")).toContainText("Invalid email or password.");
  await signIn(page, A.email, A.newPassword);
  await expect(page).toHaveURL(/\/dashboard$/);
  await signOut(page);
});

test("auth links never redirect off-site, and a bad link explains itself", async ({ page, request }) => {
  for (const next of ["//evil.example", "/\\evil.example", "https://evil.example"]) {
    const res = await request.get(`/auth/callback?code=not-a-real-code&next=${encodeURIComponent(next)}`, { maxRedirects: 0 });
    expect(res.status()).toBeGreaterThanOrEqual(300);
    const to = new URL(res.headers()["location"], "http://localhost");
    expect(to.host).toMatch(/^localhost(:\d+)?$/);
    expect(to.pathname).toBe("/sign-in");
  }
  await page.goto("/auth/callback?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired");
  await expect(page).toHaveURL(/\/sign-in\?error=link_expired$/);
  await expect(page.locator("main").getByRole("alert")).toContainText("That link has expired.");
});

test("deleting an account removes its rows and its Supabase login", async ({ page }) => {
  await signIn(page, B.email, B.password);
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto("/settings");
  await page.getByLabel("Type DELETE to confirm").fill("DELETE");
  await page.getByRole("button", { name: "Delete my account" }).click();
  await expect(page).toHaveURL(/\/$/);

  const db = sql();
  try {
    expect(await db`select id from users where id = ${B.id}`).toHaveLength(0);
    expect(await db`select id from credit_ledger where user_id = ${B.id}`).toHaveLength(0);
  } finally { await db.end(); }
  await expect(authAdmin(`users/${B.id}`)).rejects.toThrow(/404/);
  await signIn(page, B.email, B.password);
  await expect(page.locator("main").getByRole("status")).toContainText("Invalid email or password.");
});
