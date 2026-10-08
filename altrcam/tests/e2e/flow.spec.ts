/**
 * Sign-up → dashboard → studio blocked at 0 credits → simulated paid webhook → studio unlocked.
 * Needs: Clerk development instance (test mode), a migrated Postgres (DATABASE_URL), and the app started with
 * PAYSTACK_API_URL=http://127.0.0.1:4010 so server-side verification hits the local mock.
 */
import { expect, test } from "@playwright/test";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { signPaystack, sql, startPaystackMock } from "./helpers";

const stamp = Date.now();
const email = `altrcam+clerk_test${stamp}@example.com`; // Clerk test-mode address: OTP is always 424242
const password = `Alt!${stamp}xYz`;

test("new user is blocked at zero credits and unlocked by a verified payment webhook", async ({ page, request }) => {
  await setupClerkTestingToken({ page });

  // 1. Sign up
  await page.goto("/sign-up");
  await page.getByLabel(/email address/i).fill(email);
  await page.getByLabel(/^password/i).fill(password);
  await page.getByRole("button", { name: /continue/i }).click();
  await page.getByLabel(/code|verification/i).first().fill("424242");

  // 2. Dashboard with signup credits from the Clerk webhook / self-heal path
  await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/AI Credits remaining/i)).toBeVisible();

  const db = sql();
  const [u] = await db`select id from users where email = ${email}`;
  expect(u, "user row exists").toBeTruthy();

  // 3. Drain credits → studio is gated
  await db`insert into credit_ledger (user_id, delta, bucket, reason) select ${u.id}, -coalesce(sum(delta),0), 'monthly', 'e2e_drain' from credit_ledger where user_id = ${u.id}`;
  await page.goto("/studio");
  await expect(page.getByRole("heading", { name: /out of credits/i })).toBeVisible();

  // 4. Pending payment + signed charge.success webhook, verified against the mock
  const ref = `alt_e2e_${stamp}`;
  await db`insert into payments (user_id, provider, reference, kind, product, amount_minor, currency, status) values (${u.id}, 'paystack', ${ref}, 'topup', 'TOPUP_1K', 300000, 'NGN', 'pending')`;
  const mock = await startPaystackMock(4010, { amount: 300000, currency: "NGN", userId: u.id, product: "TOPUP_1K" });
  try {
    const body = JSON.stringify({ event: "charge.success", data: { reference: ref, id: stamp } });
    const bad = await request.post("/api/webhooks/paystack", { data: body, headers: { "x-paystack-signature": "nope", "content-type": "application/json" } });
    expect(bad.status()).toBe(401);
    const ok = await request.post("/api/webhooks/paystack", { data: body, headers: { "x-paystack-signature": signPaystack(body), "content-type": "application/json" } });
    expect(ok.status()).toBe(200);
    // Replay must not double-grant
    await request.post("/api/webhooks/paystack", { data: body, headers: { "x-paystack-signature": signPaystack(body), "content-type": "application/json" } });
  } finally { mock.close(); }

  const [{ total }] = await db`select coalesce(sum(delta),0)::int as total from credit_ledger where user_id = ${u.id}`;
  expect(total).toBe(1000);
  await db.end();

  // 5. Studio unlocked
  await page.goto("/studio");
  await expect(page.getByRole("button", { name: /go live/i })).toBeVisible();
});
