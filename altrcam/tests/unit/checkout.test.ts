/**
 * The real checkout route (POST /api/payments/checkout) on an in-memory Postgres. Only Clerk's session and the providers' HTTP
 * APIs are faked (fetch is stubbed), so what is pinned in the pending payment row and what is sent to the provider are the real thing.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const h = vi.hoisted(() => ({ db: null as unknown, me: "A" as string | null }));
vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: h.me }), clerkClient: async () => ({}) }));
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), db: () => h.db }));

import { testDb } from "./helpers";
import type { DB } from "@/lib/db";
import { payments, subscriptions, users } from "@/db/schema";
import * as checkout from "@/app/api/payments/checkout/route";
import { appUrlUsable } from "@/lib/config";

let d: DB;
beforeAll(async () => { d = await testDb(); h.db = d; }, 60_000);

/** Test prices only (minor units), not proposals. */
const PRICES = {
  PRICE_PRO_MONTHLY_NGN: "1500000", PRICE_PRO_YEARLY_NGN: "15000000", PRICE_LIFETIME_NGN: "9900000", PRICE_LIFETIME_USD: "9900",
  PRICE_TOPUP_1K_NGN: "300000", PRICE_TOPUP_1K_USD: "300", PRICE_TOPUP_5K_NGN: "1200000", PRICE_TOPUP_15K_NGN: "3000000",
  // Margin-guard inputs that make every fixture price pass (test values, not fal's real cost or today's rate).
  FAL_COST_PER_SECOND_USD: "0.00001", FX_NGN_PER_USD: "1500",
};
const ENV = { ...process.env };
type Call = { url: string; body: Record<string, unknown> };
let calls: Call[] = [];
let providerFails = false;

beforeEach(async () => {
  h.me = "A"; calls = []; providerFails = false;
  delete process.env.DATABASE_URL; // getPlans() uses the code defaults
  Object.assign(process.env, PRICES, {
    PAYSTACK_SECRET_KEY: "sk_test_x", NOWPAYMENTS_API_KEY: "np_x", NOWPAYMENTS_IPN_SECRET: "ipn_x", NEXT_PUBLIC_APP_URL: "https://altrcam.test",
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : {} });
    if (providerFails) return new Response(JSON.stringify({ status: false, message: "upstream down" }), { status: 502 });
    if (String(url).endsWith("/transaction/initialize")) return Response.json({ status: true, data: { authorization_url: "https://checkout.paystack.test/x", reference: "ignored" } });
    if (String(url).endsWith("/invoice")) return Response.json({ invoice_url: "https://nowpayments.test/inv" });
    return new Response("not found", { status: 404 });
  }));
  await d.execute(sql`truncate users, subscriptions, payments, webhook_events, credit_ledger, audit_log, notifications restart identity cascade`);
  await d.insert(users).values([{ id: "A", email: "a@x.co", name: "A" }]);
});
afterEach(() => { vi.unstubAllGlobals(); process.env = { ...ENV }; });

const buy = async (product: string, provider = "paystack") => {
  const r = await checkout.POST(new Request("http://x/api/payments/checkout", { method: "POST", body: JSON.stringify({ product, provider }) }));
  return { status: r.status, body: (await r.json()) as { url?: string; reference?: string; error?: string; code?: string } };
};
const rows = () => d.select().from(payments);

describe("checkout pins the exact price and currency in the pending row", () => {
  it("card (Paystack) charges the NGN price; the amount sent equals the amount pinned", async () => {
    const r = await buy("PRO_MONTHLY");
    expect(r.status).toBe(200);
    const [p] = await rows();
    expect(p).toMatchObject({ userId: "A", provider: "paystack", product: "PRO_MONTHLY", kind: "subscription", amountMinor: 1500000, currency: "NGN", status: "pending", reference: r.body.reference });
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ amount: 1500000, currency: "NGN", reference: r.body.reference, metadata: { userId: "A", product: "PRO_MONTHLY" } });
  });
  it("crypto (NOWPayments) is priced in USD from the USD variable", async () => {
    const r = await buy("LIFETIME", "nowpayments");
    expect(r.status).toBe(200);
    const [p] = await rows();
    expect(p).toMatchObject({ provider: "nowpayments", amountMinor: 9900, currency: "USD" });
    expect(calls[0].body).toMatchObject({ price_amount: 99, price_currency: "usd", order_id: r.body.reference });
  });
});

describe("the Lifetime top-up discount at checkout", () => {
  it("a Lifetime member is charged 80% of the list price, pinned in the pending row and sent to the provider", async () => {
    await d.update(users).set({ plan: "LIFETIME" }).where(eq(users.id, "A"));
    expect((await buy("TOPUP_1K")).status).toBe(200);
    expect((await buy("TOPUP_1K", "nowpayments")).status).toBe(200);
    const [card, crypto] = await d.select().from(payments).orderBy(payments.id);
    expect(card).toMatchObject({ amountMinor: 240000, currency: "NGN" });
    expect(crypto).toMatchObject({ amountMinor: 240, currency: "USD" });
    expect(calls[0].body).toMatchObject({ amount: 240000 });
    expect(calls[1].body).toMatchObject({ price_amount: 2.4 });
  });
  it("everyone else pays the list price", async () => {
    await d.update(users).set({ plan: "PRO" }).where(eq(users.id, "A"));
    await buy("TOPUP_1K");
    expect((await rows())[0].amountMinor).toBe(300000);
  });
  it("a Lifetime member cannot buy Lifetime or Pro again", async () => {
    await d.update(users).set({ plan: "LIFETIME" }).where(eq(users.id, "A"));
    expect(await buy("LIFETIME")).toMatchObject({ status: 409, body: { code: "already_lifetime" } });
    expect(await buy("PRO_MONTHLY")).toMatchObject({ status: 409, body: { code: "already_lifetime" } });
    expect(calls).toHaveLength(0);
  });
});

describe("a product that is not on sale cannot be bought", () => {
  it("no price in that currency: refused, no pending row, the provider is never called", async () => {
    const r = await buy("TOPUP_5K", "nowpayments"); // only PRICE_TOPUP_5K_NGN is set
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "no_price" });
    expect(r.body.error).toMatch(/Nothing was charged/);
    expect(await rows()).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
  it("an unset or malformed price hides the product for card too", async () => {
    delete process.env.PRICE_PRO_YEARLY_NGN;
    expect((await buy("PRO_YEARLY")).status).toBe(409);
    process.env.PRICE_PRO_YEARLY_NGN = "150000.50";
    expect((await buy("PRO_YEARLY")).status).toBe(409);
    expect(calls).toHaveLength(0);
  });
  it("a price the margin guard can't prove, or that fails it, is refused the same way", async () => {
    delete process.env.FAL_COST_PER_SECOND_USD;
    expect(await buy("TOPUP_1K")).toMatchObject({ status: 409, body: { code: "margin_unproven" } });
    process.env.FAL_COST_PER_SECOND_USD = "0.04"; // 1,000 credits = $40 of model time against ₦3,000 (= $2)
    expect(await buy("TOPUP_1K")).toMatchObject({ status: 409, body: { code: "margin_fails" } });
    expect(await rows()).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
  it("crypto never sells a subscription", async () => {
    process.env.PRICE_PRO_MONTHLY_USD = "1000";
    const r = await buy("PRO_MONTHLY", "nowpayments");
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("crypto_subscription");
    expect(calls).toHaveLength(0);
  });
  it("an unknown product id is rejected as invalid input", async () => {
    expect((await buy("FREE_MONEY")).status).toBe(400);
  });
});

describe("billing defects from the audit", () => {
  it("BLOCKER: a Pro subscriber cannot start a second subscription (409, nothing created, provider not called)", async () => {
    await d.update(users).set({ plan: "PRO", planRenewsAt: new Date(Date.now() + 20 * 86_400_000) }).where(eq(users.id, "A"));
    await d.insert(subscriptions).values({ userId: "A", provider: "paystack", providerSubId: "SUB_1", plan: "PRO", status: "active" });
    for (const product of ["PRO_MONTHLY", "PRO_YEARLY"]) {
      const r = await buy(product);
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ code: "already_subscribed" });
      expect(r.body.error).toMatch(/already have an active Pro subscription/);
    }
    expect(await rows()).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect((await buy("TOPUP_1K")).status).toBe(200); // top-ups are still fine
  });
  it("a cancelled Pro whose paid period is still running is refused too, with the end date", async () => {
    await d.update(users).set({ plan: "PRO", planStatus: "cancelling", planRenewsAt: new Date("2099-03-04T00:00:00Z") }).where(eq(users.id, "A"));
    const r = await buy("PRO_MONTHLY");
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/paid until Mar 4, 2099/);
  });
  it("a failed checkout start marks the row failed and answers 502 'nothing was charged', not 'Internal error'", async () => {
    providerFails = true;
    const r = await buy("TOPUP_1K");
    expect(r.status).toBe(502);
    expect(r.body.error).toBe("Couldn't reach the payment provider. Nothing was charged.");
    const [p] = await rows();
    expect(p.status).toBe("failed");
  });
  it("refuses with 503 before creating anything when NEXT_PUBLIC_APP_URL is unset, or not https in production", async () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(await buy("TOPUP_1K")).toMatchObject({ status: 503, body: { code: "app_url" } });
    process.env.NEXT_PUBLIC_APP_URL = "not a url";
    expect(await buy("TOPUP_1K")).toMatchObject({ status: 503, body: { code: "app_url" } });
    expect(await rows()).toHaveLength(0);
    // the rule itself (the route can't run as production here: the rate limiter insists on Upstash there)
    expect(appUrlUsable("http://altrcam.test", true)).toBe(false);
    expect(appUrlUsable("https://altrcam.com", true)).toBe(true);
    expect(appUrlUsable("http://localhost:3000", false)).toBe(true);
    expect(appUrlUsable(undefined, false)).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
