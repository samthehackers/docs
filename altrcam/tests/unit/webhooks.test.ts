/**
 * The real webhook routes (Paystack and NOWPayments) end to end on an in-memory Postgres: signature check on the raw body,
 * server-to-server re-verification, comparison against the pending row, idempotent fulfilment. Only the providers' HTTP APIs
 * are faked (fetch is stubbed); what each fake answers is set per test.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), db: () => h.db }));

import { testDb } from "./helpers";
import type { DB } from "@/lib/db";
import { auditLog, notifications, payments, subscriptions, users, webhookEvents } from "@/db/schema";
import { ledgerBalance } from "@/lib/credits";
import { hmacSha512Hex } from "@/lib/payments/paystack";
import { sortKeysDeep } from "@/lib/payments/nowpayments";
import { POST as paystackHook } from "@/app/api/webhooks/paystack/route";
import { POST as nowHook } from "@/app/api/webhooks/nowpayments/route";

let d: DB;
beforeAll(async () => { d = await testDb(); h.db = d; }, 60_000);

const SK = "sk_test_webhooks", IPN = "ipn_test_webhooks";
const ENV = { ...process.env };
/** What the fake Paystack /transaction/verify answers, per reference. */
let paystackTx: Record<string, Record<string, unknown>> = {};
/** What the fake NOWPayments /payment/:id answers, per payment id. */
let nowTx: Record<string, Record<string, unknown>> = {};
let verifyCalls = 0;

beforeEach(async () => {
  paystackTx = {}; nowTx = {}; verifyCalls = 0;
  Object.assign(process.env, { PAYSTACK_SECRET_KEY: SK, NOWPAYMENTS_API_KEY: "np", NOWPAYMENTS_IPN_SECRET: IPN, PAYSTACK_PLAN_PRO_MONTHLY: "PLN_month", PAYSTACK_PLAN_PRO_YEARLY: "PLN_year", PRICE_PRO_MONTHLY_NGN: "1500000" });
  delete process.env.DATABASE_URL;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    verifyCalls++;
    const u = String(url);
    if (u.includes("/transaction/verify/")) {
      const ref = decodeURIComponent(u.split("/").pop()!);
      return paystackTx[ref] ? Response.json({ status: true, data: paystackTx[ref] }) : Response.json({ status: false, message: "not found" }, { status: 404 });
    }
    if (u.includes("/payment/")) {
      const id = decodeURIComponent(u.split("/").pop()!);
      return nowTx[id] ? Response.json(nowTx[id]) : Response.json({ message: "not found" }, { status: 404 });
    }
    return new Response("unexpected", { status: 500 });
  }));
  await d.execute(sql`truncate users, subscriptions, payments, webhook_events, credit_ledger, audit_log, notifications, referrals restart identity cascade`);
  await d.insert(users).values([{ id: "A", email: "a@x.co", name: "A" }, { id: "B", email: "b@x.co", name: "B" }]);
});
afterEach(() => { vi.unstubAllGlobals(); process.env = { ...ENV }; });

const paystack = async (body: object, sig?: string) => {
  const raw = JSON.stringify(body);
  return paystackHook(new Request("http://x/api/webhooks/paystack", { method: "POST", body: raw, headers: { "x-paystack-signature": sig ?? hmacSha512Hex(raw, SK) } }));
};
const nowpay = async (body: Record<string, unknown>, sig?: string) =>
  nowHook(new Request("http://x/api/webhooks/nowpayments", { method: "POST", body: JSON.stringify(body), headers: { "x-nowpayments-sig": sig ?? hmacSha512Hex(JSON.stringify(sortKeysDeep(body)), IPN) } }));

const pending = (over: Partial<typeof payments.$inferInsert> = {}) => d.insert(payments).values({
  userId: "A", provider: "paystack", reference: "alt_ref1", kind: "topup", product: "TOPUP_1K", amountMinor: 300000, currency: "NGN", status: "pending", ...over,
});
/** Paystack's verify answer for a successful charge. */
const tx = (over: Record<string, unknown> = {}) => ({
  reference: "alt_ref1", status: "success", amount: 300000, currency: "NGN", metadata: { userId: "A", product: "TOPUP_1K" },
  customer: { email: "a@x.co", customer_code: "CUS_a" }, ...over,
});
const charge = (reference = "alt_ref1", extra: Record<string, unknown> = {}) => ({ event: "charge.success", data: { reference, id: 1, ...extra } });
const row = async (ref = "alt_ref1") => (await d.select().from(payments).where(eq(payments.reference, ref)))[0];
const user = async (id = "A") => (await d.select().from(users).where(eq(users.id, id)))[0];
const audits = async (action: string) => (await d.select().from(auditLog)).filter((a) => a.action === action);

describe("Paystack: signature", () => {
  it("a valid HMAC-SHA512 of the raw body is accepted and grants; a bad or missing one is 401 and changes nothing", async () => {
    await pending(); paystackTx.alt_ref1 = tx();
    expect((await paystack(charge(), "deadbeef")).status).toBe(401);
    const raw = JSON.stringify(charge());
    expect((await paystackHook(new Request("http://x", { method: "POST", body: raw }))).status).toBe(401);
    // signed over different bytes (re-serialised with a space): the raw body is what is checked
    expect((await paystackHook(new Request("http://x", { method: "POST", body: raw + " ", headers: { "x-paystack-signature": hmacSha512Hex(raw, SK) } }))).status).toBe(401);
    expect(verifyCalls).toBe(0);
    expect(await d.select().from(webhookEvents)).toHaveLength(0);
    expect((await paystack(charge())).status).toBe(200);
    expect((await ledgerBalance(d, "A")).purchased).toBe(1000);
  });
});

describe("Paystack: charge.success against the pending row", () => {
  it("a replayed webhook grants once", async () => {
    await pending(); paystackTx.alt_ref1 = tx();
    for (let i = 0; i < 3; i++) expect((await paystack(charge())).status).toBe(200);
    expect((await ledgerBalance(d, "A")).purchased).toBe(1000);
    expect((await row()).status).toBe("success");
  });
  it("the same payment under a different event body still grants once", async () => {
    await pending(); paystackTx.alt_ref1 = tx();
    await paystack(charge()); await paystack(charge("alt_ref1", { id: 2, extra: "redelivered differently" }));
    expect((await ledgerBalance(d, "A")).purchased).toBe(1000);
  });
  it("an amount mismatch is rejected: nothing granted, the row says why", async () => {
    await pending(); paystackTx.alt_ref1 = tx({ amount: 100 });
    expect((await paystack(charge())).status).toBe(200);
    expect((await ledgerBalance(d, "A")).total).toBe(0);
    expect((await row()).status).toBe("rejected");
    expect((await audits("payment.rejected"))[0].meta).toMatchObject({ why: expect.stringMatching(/amount mismatch/) });
  });
  it("a currency mismatch is rejected (same number, wrong currency)", async () => {
    await pending(); paystackTx.alt_ref1 = tx({ currency: "USD" });
    await paystack(charge());
    expect((await ledgerBalance(d, "A")).total).toBe(0);
    expect((await audits("payment.rejected"))[0].meta).toMatchObject({ why: expect.stringMatching(/currency mismatch/) });
  });
  it("a product mismatch is rejected: metadata or plan code naming another product than the checkout", async () => {
    await pending(); paystackTx.alt_ref1 = tx({ metadata: { userId: "A", product: "TOPUP_15K" } });
    await paystack(charge());
    expect((await ledgerBalance(d, "A")).total).toBe(0);
    expect((await audits("payment.rejected"))[0].meta).toMatchObject({ why: expect.stringMatching(/product mismatch/) });

    await pending({ reference: "alt_sub", kind: "subscription", product: "PRO_MONTHLY", amountMinor: 1500000 });
    paystackTx.alt_sub = tx({ reference: "alt_sub", amount: 1500000, metadata: {}, plan: { plan_code: "PLN_year" } });
    await paystack(charge("alt_sub"));
    expect((await user()).plan).toBe("FREE");
    expect((await row("alt_sub")).status).toBe("rejected");
  });
  it("a payment whose metadata names another user is rejected, and never credits that user", async () => {
    await pending(); paystackTx.alt_ref1 = tx({ metadata: { userId: "B", product: "TOPUP_1K" } });
    await paystack(charge());
    expect((await ledgerBalance(d, "A")).total).toBe(0);
    expect((await ledgerBalance(d, "B")).total).toBe(0);
  });
  it("the Lifetime member price verifies: the row pinned 80% of the list price, and that is what was paid", async () => {
    process.env.PRICE_TOPUP_1K_NGN = "300000";
    await d.update(users).set({ plan: "LIFETIME" }).where(eq(users.id, "A"));
    await pending({ amountMinor: 240000 }); paystackTx.alt_ref1 = tx({ amount: 240000 });
    await paystack(charge());
    expect((await row()).status).toBe("success");
    expect((await ledgerBalance(d, "A")).purchased).toBe(1000);
  });
  it("checks the verified amount, not the webhook body: a forged amount in the body is ignored", async () => {
    await pending(); paystackTx.alt_ref1 = tx({ amount: 100 });
    await paystack(charge("alt_ref1", { amount: 300000, status: "success" }));
    expect((await ledgerBalance(d, "A")).total).toBe(0);
  });
  it("out of order: a checkout already marked abandoned or failed that is paid late is still honoured, once", async () => {
    for (const status of ["abandoned", "failed"]) {
      await d.execute(sql`truncate payments, webhook_events, credit_ledger restart identity cascade`);
      await d.update(users).set({ creditsMonthly: 0, creditsPurchased: 0 }).where(eq(users.id, "A"));
      await pending({ status }); paystackTx.alt_ref1 = tx();
      await paystack(charge()); await paystack(charge());
      expect((await row()).status, status).toBe("success");
      expect((await ledgerBalance(d, "A")).purchased, status).toBe(1000);
    }
  });
  it("a reference Paystack doesn't confirm as paid grants nothing", async () => {
    await pending(); paystackTx.alt_ref1 = tx({ status: "abandoned" });
    await paystack(charge());
    expect((await ledgerBalance(d, "A")).total).toBe(0);
    expect((await row()).status).toBe("pending");
  });
  it("a payment for a deleted account (row anonymised) grants nothing and is left in the audit log for a refund", async () => {
    await pending({ userId: null }); paystackTx.alt_ref1 = tx();
    expect((await paystack(charge())).status).toBe(200);
    expect((await ledgerBalance(d, "A")).total).toBe(0);
    expect(await audits("payment.account_deleted")).toHaveLength(1);
  });
});

describe("Paystack: renewals and subscription events are matched by Paystack's codes, not by email", () => {
  const subscribe = async () => {
    await pending({ reference: "alt_sub", kind: "subscription", product: "PRO_MONTHLY", amountMinor: 1500000 });
    paystackTx.alt_sub = tx({ reference: "alt_sub", amount: 1500000, metadata: { userId: "A", product: "PRO_MONTHLY" }, plan: { plan_code: "PLN_month" } });
    await paystack(charge("alt_sub", { customer: { email: "a@x.co", customer_code: "CUS_a" } })); // Paystack's charge.success carries the customer
    await paystack({ event: "subscription.create", data: { subscription_code: "SUB_a", email_token: "tok_a", customer: { email: "a@x.co", customer_code: "CUS_a" }, plan: { plan_code: "PLN_month" }, next_payment_date: "2099-01-01T00:00:00.000Z" } });
  };
  it("subscription.create stores the customer and subscription codes", async () => {
    await subscribe();
    const [s] = await d.select().from(subscriptions);
    expect(s).toMatchObject({ userId: "A", providerSubId: "SUB_a", customerCode: "CUS_a", emailToken: "tok_a", status: "active" });
  });
  it("subscription.create finds the user from the first charge's customer code even when the email differs", async () => {
    await pending({ reference: "alt_sub", kind: "subscription", product: "PRO_MONTHLY", amountMinor: 1500000 });
    paystackTx.alt_sub = tx({ reference: "alt_sub", amount: 1500000, plan: { plan_code: "PLN_month" }, metadata: { userId: "A", product: "PRO_MONTHLY" } });
    await paystack(charge("alt_sub", { customer: { email: "a@x.co", customer_code: "CUS_a" } }));
    await d.update(users).set({ email: "changed@x.co" }).where(eq(users.id, "A"));
    await paystack({ event: "subscription.create", data: { subscription_code: "SUB_a", email_token: "t", customer: { email: "a@x.co", customer_code: "CUS_a" } } });
    expect((await d.select().from(subscriptions))[0]?.userId).toBe("A");
  });
  it("a renewal after the user changed their email (and someone else took the old one) still renews the right account", async () => {
    await subscribe();
    await d.update(users).set({ email: "new-a@x.co" }).where(eq(users.id, "A"));
    await d.update(users).set({ email: "a@x.co" }).where(eq(users.id, "B")); // the old address now belongs to B
    paystackTx.ren_1 = { reference: "ren_1", status: "success", amount: 1500000, currency: "NGN", metadata: null, plan: { plan_code: "PLN_month" }, customer: { email: "a@x.co", customer_code: "CUS_a" } };
    await paystack(charge("ren_1"));
    expect((await row("ren_1"))).toMatchObject({ userId: "A", status: "success", product: "PRO_MONTHLY" });
    expect((await user("B")).plan).toBe("FREE");
  });
  it("a renewal is checked against the configured NGN plan price", async () => {
    await subscribe();
    paystackTx.ren_2 = { reference: "ren_2", status: "success", amount: 999, currency: "NGN", plan: { plan_code: "PLN_month" }, customer: { customer_code: "CUS_a" } };
    await paystack(charge("ren_2"));
    expect((await row("ren_2")).status).toBe("rejected");
  });
  it("invoice.payment_failed is matched by the subscription code first, marks past_due, and says what actually works", async () => {
    await subscribe();
    await d.update(users).set({ email: "new-a@x.co" }).where(eq(users.id, "A"));
    await d.update(users).set({ email: "a@x.co" }).where(eq(users.id, "B"));
    await paystack({ event: "invoice.payment_failed", data: { subscription: { subscription_code: "SUB_a" }, customer: { email: "a@x.co", customer_code: "CUS_other" } } });
    expect((await user("A")).planStatus).toBe("past_due");
    expect((await user("B")).planStatus).toBe("active");
    const n = (await d.select().from(notifications).where(eq(notifications.userId, "A"))).find((x) => x.type === "payment_failed")!;
    expect(n.body).toMatch(/Paystack emailed you a link to update your card/);
    expect(n.body).not.toMatch(/Update your card in Billing/);
  });
  it("a second active subscription for the same account is flagged for a person to refund", async () => {
    await subscribe();
    await paystack({ event: "subscription.create", data: { subscription_code: "SUB_a2", email_token: "t2", customer: { email: "a@x.co", customer_code: "CUS_a" } } });
    expect(await audits("subscription.duplicate")).toHaveLength(1);
  });
});

describe("NOWPayments (same interface): only 'finished' grants, 'partially_paid' only notifies", () => {
  const ipn = (status: string, over: Record<string, unknown> = {}) => ({ payment_id: 77, payment_status: status, order_id: "alt_np", price_amount: 99, price_currency: "usd", ...over });
  beforeEach(async () => {
    await pending({ reference: "alt_np", provider: "nowpayments", kind: "lifetime", product: "LIFETIME", amountMinor: 9900, currency: "USD" });
    nowTx["77"] = { payment_id: 77, order_id: "alt_np", payment_status: "finished", price_amount: 99, price_currency: "usd" };
  });
  it("rejects a bad signature", async () => {
    expect((await nowpay(ipn("finished"), "00")).status).toBe(401);
    expect((await user()).plan).toBe("FREE");
  });
  it("partially_paid tells the user and grants nothing; finished grants once, even when replayed", async () => {
    await nowpay(ipn("partially_paid"));
    expect((await user()).plan).toBe("FREE");
    expect((await d.select().from(notifications)).some((n) => n.type === "payment_partial")).toBe(true);
    await nowpay(ipn("finished")); await nowpay(ipn("finished"));
    expect((await user()).plan).toBe("LIFETIME");
    expect((await d.select().from(payments).where(eq(payments.reference, "alt_np")))[0].status).toBe("success");
    expect((await ledgerBalance(d, "A")).monthly).toBe(2000);
  });
  it("an amount the provider re-check does not confirm is rejected", async () => {
    nowTx["77"] = { ...nowTx["77"], price_amount: 9.9 };
    await nowpay(ipn("finished"));
    expect((await user()).plan).toBe("FREE");
    expect((await row("alt_np")).status).toBe("rejected");
  });
  it("an expired invoice marks the pending row failed", async () => {
    await nowpay(ipn("expired"));
    expect((await row("alt_np")).status).toBe("failed");
  });
  it("ignores an order id that isn't a NOWPayments checkout of ours", async () => {
    await pending({ reference: "alt_card" }); // a Paystack checkout
    nowTx["78"] = { payment_id: 78, order_id: "alt_card", payment_status: "finished", price_amount: 3000, price_currency: "ngn" };
    await nowpay(ipn("finished", { payment_id: 78, order_id: "alt_card" }));
    expect((await ledgerBalance(d, "A")).total).toBe(0);
  });
});
